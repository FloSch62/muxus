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
import {
  PAGE_KEEPALIVE_BODY_LIMIT_BYTES,
  registerUnloadKeepalive,
  requestBodyBytes,
} from './unload-keepalive.js';

const SAVE_DELAY_MS = 350;
const RETRY_DELAY_MS = 2_000;
const DEFAULT_WORKSPACE_NAME = 'Workspace 1';
const WORKSPACE_UNLOAD_PRIORITY = 100;

interface WorkspaceSnapshot {
  layout: WorkspaceLayoutV1;
  multiExecGroups: WorkspaceMultiExecGroup[];
  serialized: string;
}

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

  async start(): Promise<void> {
    const beforeLoad = currentSnapshot().serialized;
    try {
      const [catalog, startup, latest] = await Promise.all([
        apiFetch<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
        apiFetch<{ workspace: WorkspaceRecord | null }>('/api/workspaces/startup'),
        apiFetch<{ workspace: WorkspaceRecord | null }>('/api/workspaces/latest'),
      ]);
      if (this.stopped) return;
      const workspace = startup.workspace ?? latest.workspace;
      let summaries = catalog.workspaces;
      let restoredSource = '';
      let restored = false;

      if (workspace) {
        const state = useTabsStore.getState();
        // Do not clobber a session the user opened while startup requests were in flight.
        if (state.tabs.length === 0 && state.root.type === 'pane') {
          this.restoring = true;
          restoredSource = JSON.stringify({
            layout: workspace.layout,
            multiExecGroups: workspace.multiExecGroups,
          });
          state.restore(workspace.layout, restoreOptions());
          useMultiExecStore.getState().setGroups(workspace.multiExecGroups);
          this.restoring = false;
          restored = true;
        }
        const opened = await apiFetch<WorkspaceRecord>(
          `/api/workspaces/${encodeURIComponent(workspace.id)}/open`,
          { method: 'POST' },
        );
        if (this.stopped) return;
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
      this.lastSerialized = restored && workspace?.isLocked ? restoredSource : loaded.serialized;
      if (
        !workspace?.isLocked &&
        ((restored && restoredSource !== loaded.serialized) ||
          (!restored && loaded.serialized !== beforeLoad))
      ) {
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
  }

  stop(): void {
    this.flushOnUnload();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribeTabs?.();
    this.unsubscribeMultiExec?.();
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
    });
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
    const { activeId, activeName } = useWorkspacesStore.getState();
    const save = apiFetch<WorkspaceRecord>('/api/workspaces', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: activeId,
        name: activeId ? activeName : DEFAULT_WORKSPACE_NAME,
        layout: snapshot.layout,
        multiExecGroups: snapshot.multiExecGroups,
      }),
    })
      .then((saved) => this.recordActive(saved))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.body?.code === 'workspace-locked') {
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
  }

  private recordWorkspace(workspace: WorkspaceRecord): void {
    useWorkspacesStore.setState((state) => ({
      workspaces: mergeSummary(state.workspaces, workspace),
      startupId: workspace.isStartup ? workspace.id : state.startupId,
      error: undefined,
    }));
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
    const { activeId, activeName } = useWorkspacesStore.getState();
    const body = JSON.stringify({
      id: activeId,
      name: activeId ? activeName : DEFAULT_WORKSPACE_NAME,
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

/** Restore startup/latest once, then debounce the active named workspace to SQLite. */
export function useWorkspacePersistence(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const runtime = new WorkspaceRuntime();
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
  }, [enabled]);
}
