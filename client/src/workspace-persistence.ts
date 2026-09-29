import { useEffect } from 'react';
import type {
  WorkspaceLayoutV1,
  WorkspaceMultiExecGroup,
  WorkspaceRecord,
  WorkspaceSummary,
} from '@muxus/shared';
import { ApiError, apiFetch, authToken } from './api/http.js';
import { useMultiExecStore } from './state/multi-exec.js';
import { usePrefsStore } from './state/prefs.js';
import { useTabsStore, type SessionTab } from './state/tabs.js';
import { serializeWorkspace } from './state/workspace-layout.js';
import { useWorkspacesStore } from './state/workspaces.js';
import { WorkspaceWindowSync } from './workspace-sync.js';
import {
  PAGE_KEEPALIVE_BODY_LIMIT_BYTES,
  registerUnloadKeepalive,
  requestBodyBytes,
} from './unload-keepalive.js';

const SAVE_DELAY_MS = 350;
const RETRY_DELAY_MS = 2_000;
const WORKSPACE_UNLOAD_PRIORITY = 100;

interface WorkspaceSnapshot {
  layout: WorkspaceLayoutV1;
  multiExecGroups: WorkspaceMultiExecGroup[];
  serialized: string;
}

export type WorkspaceInitialSelection =
  | { kind: 'blank' }
  | { kind: 'new'; id: string; name: string }
  | { kind: 'open'; id: string }
  | { kind: 'open-name'; name: string };

function currentSnapshot(): WorkspaceSnapshot {
  const { root, tabs, activePaneId } = useTabsStore.getState();
  const sessionTabs = tabs.filter((tab): tab is SessionTab => tab.profile !== null);
  const layout = serializeWorkspace(root, sessionTabs, activePaneId);
  const tabIds = new Set(sessionTabs.map((tab) => tab.id));
  const multiExecGroups = useMultiExecStore.getState().groups.flatMap((group) => {
    const ids = [...new Set(group.tabIds)].filter((id) => tabIds.has(id));
    return ids.length >= 2 ? [{ ...group, tabIds: ids }] : [];
  });
  return {
    layout,
    multiExecGroups,
    serialized: JSON.stringify({ layout, multiExecGroups }),
  };
}

/** Restores dial remote sessions too unless the preference turned that off. */
function restoreOptions() {
  return { connectRemote: usePrefsStore.getState().autoReconnectRemote };
}

function summaryOf(workspace: WorkspaceRecord): WorkspaceSummary {
  const { layout: _layout, multiExecGroups: _groups, ...summary } = workspace;
  return summary;
}

function mergeSummary(
  summaries: readonly WorkspaceSummary[],
  workspace: WorkspaceRecord,
): WorkspaceSummary[] {
  const summary = summaryOf(workspace);
  return [summary, ...summaries.filter((candidate) => candidate.id !== workspace.id)];
}

export function nextWorkspaceName(workspaces: readonly WorkspaceSummary[]): string {
  const names = new Set(workspaces.map((workspace) => workspace.name.trim().toLocaleLowerCase()));
  let number = 1;
  while (names.has(`workspace ${number}`)) number++;
  return `Workspace ${number}`;
}

export class WorkspaceRuntime {
  private stopped = false;
  private restoring = false;
  private autoSavePaused = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: WorkspaceSnapshot;
  private saving?: Promise<void>;
  private unsubscribeTabs?: () => void;
  private unsubscribeMultiExec?: () => void;
  private lastSerialized = '';
  private refreshing?: Promise<void>;
  private refreshQueued = false;

  constructor(
    private readonly initialSelection?: WorkspaceInitialSelection,
    private readonly sync = new WorkspaceWindowSync(),
  ) {}

  async start(): Promise<void> {
    const beforeLoad = currentSnapshot().serialized;
    let catalogChangedOnStart = false;
    try {
      const catalogRequest = apiFetch<{ workspaces: WorkspaceSummary[] }>('/api/workspaces');
      let catalog: { workspaces: WorkspaceSummary[] };
      let workspace: WorkspaceRecord | null;
      let persistedSource = '';
      let restoreSavedLayout = true;

      if (this.initialSelection?.kind === 'new') {
        catalog = await catalogRequest;
        if (this.stopped) return;
        const snapshot = currentSnapshot();
        workspace = await apiFetch<WorkspaceRecord>('/api/workspaces', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: this.initialSelection.id,
            createIfMissing: true,
            name: this.initialSelection.name.trim(),
            layout: snapshot.layout,
            multiExecGroups: snapshot.multiExecGroups,
          }),
        });
        catalogChangedOnStart = true;
        persistedSource = snapshot.serialized;
        restoreSavedLayout = false;
      } else if (this.initialSelection?.kind === 'open') {
        [catalog, workspace] = await Promise.all([
          catalogRequest,
          apiFetch<WorkspaceRecord>(
            `/api/workspaces/${encodeURIComponent(this.initialSelection.id)}`,
          ),
        ]);
      } else if (this.initialSelection?.kind === 'open-name') {
        catalog = await catalogRequest;
        const target = this.initialSelection.name.trim().toLocaleLowerCase();
        const idMatches = catalog.workspaces.filter(
          (candidate) => candidate.id.toLocaleLowerCase() === target,
        );
        const matches =
          idMatches.length > 0
            ? idMatches
            : catalog.workspaces.filter(
                (candidate) => candidate.name.trim().toLocaleLowerCase() === target,
              );
        workspace =
          matches.length === 1
            ? await apiFetch<WorkspaceRecord>(
                `/api/workspaces/${encodeURIComponent(matches[0]!.id)}`,
              )
            : null;
      } else if (this.initialSelection?.kind === 'blank') {
        catalog = await catalogRequest;
        workspace = null;
      } else {
        const [loadedCatalog, startup, latest] = await Promise.all([
          catalogRequest,
          apiFetch<{ workspace: WorkspaceRecord | null }>('/api/workspaces/startup'),
          apiFetch<{ workspace: WorkspaceRecord | null }>('/api/workspaces/latest'),
        ]);
        catalog = loadedCatalog;
        workspace = startup.workspace ?? latest.workspace;
      }
      if (this.stopped) return;
      let summaries = catalog.workspaces;

      if (workspace) {
        persistedSource ||= JSON.stringify({
          layout: workspace.layout,
          multiExecGroups: workspace.multiExecGroups,
        });
        const state = useTabsStore.getState();
        // Do not clobber a session the user opened while startup requests were in flight.
        if (restoreSavedLayout && state.tabs.length === 0 && state.root.type === 'pane') {
          this.restoring = true;
          state.restore(workspace.layout, restoreOptions());
          useMultiExecStore.getState().setGroups(workspace.multiExecGroups);
          this.restoring = false;
        }
        const opened = await apiFetch<WorkspaceRecord>(
          `/api/workspaces/${encodeURIComponent(workspace.id)}/open`,
          { method: 'POST' },
        );
        if (this.stopped) return;
        catalogChangedOnStart = true;
        summaries = mergeSummary(summaries, opened);
        useWorkspacesStore.setState({
          workspaces: summaries,
          activeId: opened.id,
          activeName: opened.name,
          startupId: summaries.find((candidate) => candidate.isStartup)?.id,
          ready: true,
          error: undefined,
        });
      } else {
        useWorkspacesStore.setState({
          workspaces: summaries,
          activeId: undefined,
          activeName: 'Unsaved workspace',
          startupId: summaries.find((candidate) => candidate.isStartup)?.id,
          ready: true,
          error: undefined,
        });
      }

      const loaded = currentSnapshot();
      this.lastSerialized = workspace?.isLocked ? persistedSource : loaded.serialized;
      const changedSincePersist = workspace
        ? persistedSource !== loaded.serialized
        : loaded.serialized !== beforeLoad;
      if (!workspace?.isLocked && changedSincePersist) {
        this.pending = loaded;
        this.schedule();
      }
    } catch {
      if (this.stopped) return;
      // Connectivity/auth failures are presented by the backend-status banner.
      this.lastSerialized = currentSnapshot().serialized;
      useWorkspacesStore.setState({ ready: true });
    }

    if (this.stopped) return;
    this.unsubscribeTabs = useTabsStore.subscribe(() => this.handleChange());
    this.unsubscribeMultiExec = useMultiExecStore.subscribe(() => this.handleChange());
    this.startSync();
    if (catalogChangedOnStart) this.sync.invalidateCatalog();
  }

  stop(): void {
    this.flushOnUnload();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribeTabs?.();
    this.unsubscribeMultiExec?.();
    this.sync.stop();
  }

  async saveAs(name: string): Promise<WorkspaceRecord> {
    return this.withBusy(async () => {
      const wasPaused = this.autoSavePaused;
      this.autoSavePaused = true;
      try {
        await this.flushNow();
        const snapshot = currentSnapshot();
        const saved = await apiFetch<WorkspaceRecord>('/api/workspaces', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            layout: snapshot.layout,
            multiExecGroups: snapshot.multiExecGroups,
          }),
        });
        const opened = await apiFetch<WorkspaceRecord>(
          `/api/workspaces/${encodeURIComponent(saved.id)}/open`,
          { method: 'POST' },
        );
        this.lastSerialized = snapshot.serialized;
        this.recordActive(opened);
        return opened;
      } finally {
        this.autoSavePaused = wasPaused;
        if (!wasPaused && !this.activeWorkspaceIsLocked()) this.handleChange();
      }
    });
  }

  async save(): Promise<WorkspaceRecord> {
    return this.withBusy(async () => {
      const { activeId, activeName } = useWorkspacesStore.getState();
      if (!activeId) throw new Error('Save the workspace with a name first.');

      const wasPaused = this.autoSavePaused;
      this.autoSavePaused = true;
      try {
        await this.flushNow(true);
        const snapshot = currentSnapshot();
        const saved = await apiFetch<WorkspaceRecord>('/api/workspaces', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: activeId,
            name: activeName,
            layout: snapshot.layout,
            multiExecGroups: snapshot.multiExecGroups,
            overwriteLocked: true,
          }),
        });
        this.lastSerialized = snapshot.serialized;
        this.recordActive(saved);
        return saved;
      } finally {
        this.autoSavePaused = wasPaused;
        if (!wasPaused && !this.activeWorkspaceIsLocked()) this.handleChange();
      }
    });
  }

  async rename(id: string, name: string): Promise<WorkspaceRecord> {
    return this.withBusy(async () => {
      await this.flushNow();
      const renamed = await apiFetch<WorkspaceRecord>(
        `/api/workspaces/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        },
      );
      const { activeId } = useWorkspacesStore.getState();
      if (renamed.id === activeId) {
        this.recordActive(renamed);
      } else {
        this.recordWorkspace(renamed);
      }
      return renamed;
    });
  }

  async open(id: string): Promise<WorkspaceRecord> {
    return this.withBusy(async () => {
      await this.flushNow();
      const workspace = await apiFetch<WorkspaceRecord>(
        `/api/workspaces/${encodeURIComponent(id)}/open`,
        { method: 'POST' },
      );
      this.restoring = true;
      useTabsStore.getState().restore(workspace.layout, restoreOptions());
      useMultiExecStore.getState().setGroups(workspace.multiExecGroups);
      this.restoring = false;
      this.pending = undefined;
      this.lastSerialized = currentSnapshot().serialized;
      this.recordActive(workspace);
      return workspace;
    });
  }

  async setStartup(id: string | null): Promise<void> {
    return this.withBusy(async () => {
      const { workspace } = await apiFetch<{ workspace: WorkspaceRecord | null }>(
        '/api/workspaces/startup',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        },
      );
      useWorkspacesStore.setState((state) => ({
        startupId: workspace?.id,
        workspaces: state.workspaces.map((candidate) => ({
          ...candidate,
          isStartup: candidate.id === workspace?.id,
        })),
      }));
      this.sync.invalidateCatalog();
    });
  }

  async setLocked(id: string, isLocked: boolean): Promise<WorkspaceRecord> {
    return this.withBusy(async () => {
      const isActive = useWorkspacesStore.getState().activeId === id;
      const wasPaused = this.autoSavePaused;
      if (isActive) this.autoSavePaused = true;
      try {
        // Persist edits made before the user locks the active workspace.
        if (isActive && isLocked) await this.flushNow();
        const updated = await apiFetch<WorkspaceRecord>(
          `/api/workspaces/${encodeURIComponent(id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ isLocked }),
          },
        );
        if (isActive) {
          this.recordActive(updated);
        } else {
          this.recordWorkspace(updated);
        }
        return updated;
      } finally {
        this.autoSavePaused = wasPaused;
        if (isActive && !wasPaused && !this.activeWorkspaceIsLocked()) this.handleChange();
      }
    });
  }

  async delete(id: string): Promise<void> {
    return this.withBusy(async () => {
      await this.flushNow();
      const { deleted } = await apiFetch<{ deleted: boolean }>(
        `/api/workspaces/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!deleted) throw new Error('Workspace not found.');

      const { activeId } = useWorkspacesStore.getState();
      if (id === activeId) {
        this.pending = undefined;
        this.lastSerialized = currentSnapshot().serialized;
      }
      useWorkspacesStore.setState((state) => ({
        workspaces: state.workspaces.filter((workspace) => workspace.id !== id),
        ...(id === state.activeId
          ? { activeId: undefined, activeName: 'Unsaved workspace' }
          : {}),
        ...(id === state.startupId ? { startupId: undefined } : {}),
        error: undefined,
      }));
      const nextActive = useWorkspacesStore.getState();
      this.updateActiveWorkspace(nextActive.activeId, nextActive.activeName, id === activeId);
      this.sync.invalidateCatalog();
    });
  }

  async refreshCatalog(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    const refresh = (async () => {
      do {
        this.refreshQueued = false;
        const catalog = await apiFetch<{ workspaces: WorkspaceSummary[] }>('/api/workspaces');
        if (this.stopped) return;
        this.reconcileCatalog(catalog.workspaces);
      } while (this.refreshQueued && !this.stopped);
    })();
    this.refreshing = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshing === refresh) this.refreshing = undefined;
    }
  }

  focusOpenWorkspace(id: string): boolean {
    return this.sync.focusOpenWorkspace(id);
  }

  requestWorkspacePresence(): void {
    this.sync.requestPresence();
  }

  private startSync(): void {
    const { activeId, activeName } = useWorkspacesStore.getState();
    this.updateActiveWorkspace(activeId, activeName);
    this.sync.start({
      onCatalogChanged: () => void this.refreshCatalog().catch(() => undefined),
      onOpenWindowCountsChanged: (openWindowCounts) => {
        useWorkspacesStore.setState({ openWindowCounts });
      },
      onWindowFocus: () => void this.refreshCatalog().catch(() => undefined),
      onFocusRequested: () => {
        if (typeof window === 'undefined') return;
        if (window.muxusDesktop) window.muxusDesktop.focusWindow();
        else window.focus();
      },
    });
  }

  private reconcileCatalog(workspaces: WorkspaceSummary[]): void {
    const previous = useWorkspacesStore.getState();
    const active = workspaces.find((workspace) => workspace.id === previous.activeId);
    const previousActive = previous.workspaces.find(
      (workspace) => workspace.id === previous.activeId,
    );
    if (previous.activeId && !active) {
      this.detachActiveWorkspace(
        workspaces,
        `Workspace “${previous.activeName}” was deleted in another window. Current sessions remain open as an unsaved workspace.`,
      );
      return;
    }

    useWorkspacesStore.setState({
      workspaces,
      activeName: active?.name ?? previous.activeName,
      startupId: workspaces.find((workspace) => workspace.isStartup)?.id,
      error: undefined,
    });
    if (active) this.updateActiveWorkspace(active.id, active.name);
    if (active?.isLocked && !previousActive?.isLocked) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.pending = undefined;
    } else if (active && !active.isLocked && previousActive?.isLocked) {
      this.handleChange();
    }
  }

  private detachActiveWorkspace(workspaces: WorkspaceSummary[], message: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.lastSerialized = currentSnapshot().serialized;
    useWorkspacesStore.setState({
      workspaces,
      activeId: undefined,
      activeName: 'Unsaved workspace',
      startupId: workspaces.find((workspace) => workspace.isStartup)?.id,
      error: message,
    });
    this.updateActiveWorkspace(undefined, 'Unsaved workspace', true);
  }

  private updateActiveWorkspace(
    id: string | undefined,
    name: string,
    clearReloadLaunch = false,
  ): void {
    this.sync.setActiveWorkspace(id, name, clearReloadLaunch);
    if (typeof document === 'undefined') return;
    if (id) document.title = `${name} — Muxus`;
    else if (document.title.endsWith(' — Muxus')) document.title = 'Muxus';
  }

  private handleChange(): void {
    if (
      this.restoring ||
      this.stopped ||
      this.autoSavePaused ||
      this.activeWorkspaceIsLocked()
    ) return;
    const snapshot = currentSnapshot();
    if (snapshot.serialized === this.lastSerialized) return;
    this.lastSerialized = snapshot.serialized;
    this.pending = snapshot;
    this.schedule();
  }

  private schedule(delay = SAVE_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushPending().catch(() => undefined);
    }, delay);
  }

  private flushPending(): Promise<void> {
    if (this.saving) return this.saving;
    if (this.activeWorkspaceIsLocked()) {
      this.pending = undefined;
      return Promise.resolve();
    }
    if (!this.pending || this.stopped) return Promise.resolve();
    const snapshot = this.pending;
    this.pending = undefined;
    const { activeId, activeName, workspaces } = useWorkspacesStore.getState();
    const save = apiFetch<WorkspaceRecord>('/api/workspaces', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: activeId,
        name: activeId ? activeName : nextWorkspaceName(workspaces),
        allocateDefaultName: !activeId,
        layout: snapshot.layout,
        multiExecGroups: snapshot.multiExecGroups,
      }),
    })
      .then((saved) => this.recordActive(saved))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404 && activeId) {
          const state = useWorkspacesStore.getState();
          if (state.activeId === activeId) {
            this.detachActiveWorkspace(
              state.workspaces.filter((workspace) => workspace.id !== activeId),
              `Workspace “${activeName}” was deleted in another window. Current sessions remain open as an unsaved workspace.`,
            );
          }
          return;
        }
        if (error instanceof ApiError && error.body?.code === 'workspace-locked') {
          // handleChange() already recorded this snapshot as observed. Mark it dirty
          // again so unlocking requeues it even when no further edits are made.
          this.lastSerialized = '';
          useWorkspacesStore.setState((state) => ({
            workspaces: state.workspaces.map((workspace) =>
              workspace.id === activeId ? { ...workspace, isLocked: true } : workspace,
            ),
            error: undefined,
          }));
          return;
        }
        this.pending ??= snapshot;
        if (!this.stopped) this.schedule(RETRY_DELAY_MS);
        throw error;
      })
      .finally(() => {
        this.saving = undefined;
        if (this.pending && !this.timer && !this.stopped) this.schedule();
      });
    this.saving = save;
    return save;
  }

  private async flushNow(discardPending = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (discardPending) this.pending = undefined;
    while (this.saving || this.pending) {
      await (this.saving ?? this.flushPending());
    }
  }

  private recordActive(workspace: WorkspaceRecord): void {
    useWorkspacesStore.setState((state) => ({
      workspaces: mergeSummary(state.workspaces, workspace),
      activeId: workspace.id,
      activeName: workspace.name,
      startupId: workspace.isStartup ? workspace.id : state.startupId,
      error: undefined,
    }));
    this.updateActiveWorkspace(workspace.id, workspace.name);
    this.sync.invalidateCatalog();
  }

  private recordWorkspace(workspace: WorkspaceRecord): void {
    useWorkspacesStore.setState((state) => ({
      workspaces: mergeSummary(state.workspaces, workspace),
      startupId: workspace.isStartup ? workspace.id : state.startupId,
      error: undefined,
    }));
    this.sync.invalidateCatalog();
  }

  private activeWorkspaceIsLocked(): boolean {
    const { activeId, workspaces } = useWorkspacesStore.getState();
    return workspaces.some((workspace) => workspace.id === activeId && workspace.isLocked);
  }

  private async withBusy<T>(action: () => Promise<T>): Promise<T> {
    useWorkspacesStore.setState({ busy: true, error: undefined });
    try {
      return await action();
    } catch (error) {
      useWorkspacesStore.setState({
        error: error instanceof Error ? error.message : 'Workspace action failed',
      });
      throw error;
    } finally {
      useWorkspacesStore.setState({ busy: false });
    }
  }

  flushOnUnload(maxBodyBytes = PAGE_KEEPALIVE_BODY_LIMIT_BYTES): number {
    if (!this.pending || this.activeWorkspaceIsLocked()) return 0;
    const { activeId, activeName, workspaces } = useWorkspacesStore.getState();
    const body = JSON.stringify({
      id: activeId,
      name: activeId ? activeName : nextWorkspaceName(workspaces),
      allocateDefaultName: !activeId,
      layout: this.pending.layout,
      multiExecGroups: this.pending.multiExecGroups,
    });
    const bodyBytes = requestBodyBytes(body);
    if (bodyBytes > maxBodyBytes) return 0;
    this.pending = undefined;
    void fetch('/api/workspaces', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${authToken()}`,
        'content-type': 'application/json',
      },
      body,
      keepalive: true,
    }).catch(() => undefined);
    return bodyBytes;
  }
}

let activeRuntime: WorkspaceRuntime | undefined;

function runtime(): WorkspaceRuntime {
  if (!activeRuntime) throw new Error('Workspace persistence is not available in this window.');
  return activeRuntime;
}

export const saveWorkspaceAs = (name: string) => runtime().saveAs(name);
export const saveWorkspace = () => runtime().save();
export const renameWorkspace = (id: string, name: string) => runtime().rename(id, name);
export const openWorkspace = (id: string) => runtime().open(id);
export const setStartupWorkspace = (id: string | null) => runtime().setStartup(id);
export const setWorkspaceLocked = (id: string, isLocked: boolean) =>
  runtime().setLocked(id, isLocked);
export const deleteWorkspace = (id: string) => runtime().delete(id);
export const refreshWorkspaceCatalog = () => runtime().refreshCatalog();
export const focusOpenWorkspace = (id: string) => runtime().focusOpenWorkspace(id);
export const requestWorkspacePresence = () => runtime().requestWorkspacePresence();

/** Restore startup/latest once, then debounce the active named workspace to SQLite. */
export function useWorkspacePersistence(
  enabled = true,
  initialSelection?: WorkspaceInitialSelection,
): void {
  const initialKind = initialSelection?.kind;
  const initialId =
    initialSelection?.kind === 'open' || initialSelection?.kind === 'new'
      ? initialSelection.id
      : undefined;
  const initialName = initialSelection?.kind === 'new' ? initialSelection.name : undefined;
  const initialLookupName =
    initialSelection?.kind === 'open-name' ? initialSelection.name : undefined;
  useEffect(() => {
    if (!enabled) return;
    const selection: WorkspaceInitialSelection | undefined = initialKind
      ? initialKind === 'open'
        ? { kind: 'open', id: initialId! }
        : initialKind === 'new'
          ? { kind: 'new', id: initialId!, name: initialName! }
          : initialKind === 'open-name'
            ? { kind: 'open-name', name: initialLookupName! }
          : { kind: 'blank' }
      : undefined;
    const runtime = new WorkspaceRuntime(selection);
    activeRuntime = runtime;
    const unregisterUnloadFlush = registerUnloadKeepalive(
      (maxBodyBytes) => runtime.flushOnUnload(maxBodyBytes),
      { priority: WORKSPACE_UNLOAD_PRIORITY },
    );
    void runtime.start();
    return () => {
      unregisterUnloadFlush();
      runtime.stop();
      if (activeRuntime === runtime) activeRuntime = undefined;
    };
  }, [enabled, initialId, initialKind, initialLookupName, initialName]);
}
