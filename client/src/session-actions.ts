import type {
  LocalProfile,
  SavedHostProfile,
  SessionProfile,
  SshHostEntry,
} from '@muxus/shared';
import type { ManagedHost } from './managed-hosts.js';
import { localShellLaunchArguments } from './local-shell-profile.js';
import { savedHostDisplayName } from './saved-hosts.js';
import {
  usePrefsStore,
  type LocalShellProfileConfig,
} from './state/prefs.js';
import { useMultiExecStore } from './state/multi-exec.js';
import { useTabsStore } from './state/tabs.js';
import type { PaneDirection, SessionSetLayout } from './state/tabs.js';
import { confirmAction } from './state/dialogs.js';
import { showToast } from './state/toast.js';
import { confirmDiscardRemoteEditors } from './editor/remote-editor-registry.js';
import { findPane, visibleTabIds } from './state/workspace-layout.js';
import { openAppWindow } from './window-management.js';
import { createTabTransferId, shouldDetachTabDrag } from './tab-drag.js';

/**
 * How long a launch swallows an identical repeat. A tab appears instantly but
 * spends its first second connecting, so a double-click on a host reads as "the
 * first click missed" long before there is anything on screen to say otherwise.
 */
const REPEAT_LAUNCH_MS = 500;

let lastLaunch: { key: string; id: string; at: number } | undefined;

/**
 * Collapse a burst of identical launches into one session, handing every caller
 * in the burst the same tab. The window slides with each suppressed click, so
 * mashing a row still yields one tab; a deliberate second session is one short
 * pause away.
 */
function launchOnce(key: string, launch: () => string): string {
  const now = Date.now();
  // A clock that steps backwards must not wedge a host shut, so only an
  // elapsed time inside the window counts as a repeat.
  const elapsed = now - (lastLaunch?.at ?? 0);
  // A guard that outlives its tab would swallow the very click meant to bring
  // the session back, so a closed tab ends the window early.
  const guarded =
    lastLaunch !== undefined &&
    useTabsStore.getState().tabs.some((tab) => tab.id === lastLaunch?.id);
  if (guarded && lastLaunch?.key === key && elapsed >= 0 && elapsed < REPEAT_LAUNCH_MS) {
    lastLaunch = { ...lastLaunch, at: now };
    return lastLaunch.id;
  }
  const id = launch();
  lastLaunch = { key, id, at: now };
  return id;
}

function replaceActiveEmpty(
  profile: SessionProfile,
  title: string,
  requestedTabId?: string,
): string | undefined {
  const state = useTabsStore.getState();
  const activeTab = state.tabs.find((tab) => tab.id === state.activeId);
  const id = requestedTabId ?? (activeTab?.profile === null ? activeTab.id : undefined);
  return id && state.replaceEmpty(id, profile, title) ? id : undefined;
}

function launchLocalTerminal(
  profile: LocalProfile,
  title: string,
  replaceTabId?: string,
): string {
  const key = JSON.stringify(profile);
  return launchOnce(`local:${key}:${replaceTabId ?? ''}`, () => {
    const replacedId = replaceActiveEmpty(profile, title, replaceTabId);
    return replacedId ?? useTabsStore.getState().open(profile, title);
  });
}

/** Open one explicitly selected saved local-shell configuration. */
export function openLocalShellProfile(
  saved: LocalShellProfileConfig,
  replaceTabId?: string,
): string {
  const profile: LocalProfile = {
    kind: 'local',
    shell: saved.shell.trim() || undefined,
    args: localShellLaunchArguments(saved.args),
    cwd: saved.cwd.trim() || undefined,
    startupCommand: saved.startupCommand.trim() || undefined,
  };
  return launchLocalTerminal(profile, saved.name.trim() || 'Local', replaceTabId);
}

/** Open the user's default local terminal. A named profile can replace the
 * automatic shell without changing callers such as Ctrl+Shift+T or splits. */
export function openLocalTerminal(replaceTabId?: string): string {
  const { localShell, localShellProfiles, defaultLocalShellProfileId } =
    usePrefsStore.getState();
  const saved = localShellProfiles.find(
    (profile) => profile.id === defaultLocalShellProfileId,
  );
  if (saved) return openLocalShellProfile(saved, replaceTabId);
  return launchLocalTerminal(
    {
      kind: 'local',
      shell: localShell !== 'auto' && localShell.trim() ? localShell.trim() : undefined,
    },
    'Local',
    replaceTabId,
  );
}

/** Open a blank tab that lets the user choose what kind of session to start. */
export function openEmptyTab(): string {
  return useTabsStore.getState().openEmpty();
}

/**
 * Open an SSH tab. `target` is a ~/.ssh/config alias or an ad-hoc
 * "[user@]host[:port]" — the server resolves it exactly like `ssh <target>`.
 */
export function connectTarget(target: string, title = target, replaceTabId?: string): string {
  const profile: SessionProfile = { kind: 'ssh', target };
  return launchOnce(`ssh:${target}:${replaceTabId ?? ''}`, () => {
    const replacedId = replaceActiveEmpty(profile, title, replaceTabId);
    return replacedId ?? useTabsStore.getState().open(profile, title);
  });
}

export function connectSavedHost(host: SavedHostProfile, replaceTabId?: string): string {
  const profile = { ...host.profile, profileId: host.id };
  const title = savedHostDisplayName(host);
  const id = launchOnce(`saved:${host.id}:${replaceTabId ?? ''}`, () => {
    const replacedId = replaceActiveEmpty(profile, title, replaceTabId);
    return replacedId ?? useTabsStore.getState().open(profile, title);
  });
  if (host.metadata.color) useTabsStore.getState().update(id, { color: host.metadata.color });
  return id;
}

/** Connect a listed host with its Muxus display name and color carried into
 *  the tab, preserving the visual cue after the sidebar is hidden. */
export function connectHost(host: SshHostEntry, replaceTabId?: string): string {
  const id = connectTarget(host.alias, host.metadata?.displayName ?? host.alias, replaceTabId);
  if (host.metadata?.color) useTabsStore.getState().update(id, { color: host.metadata.color });
  return id;
}

/** Connect any sidebar host, regardless of which source it comes from. */
export function connectManagedHost(host: ManagedHost, replaceTabId?: string): string {
  return host.kind === 'ssh'
    ? connectHost(host.entry, replaceTabId)
    : connectSavedHost(host.entry, replaceTabId);
}

/** Replace the current canvas with every host in a sidebar group. */
export async function launchManagedHostGroup(
  hosts: readonly ManagedHost[],
  layout: SessionSetLayout,
): Promise<string[]> {
  const currentTabIds = useTabsStore.getState().tabs.map((tab) => tab.id);
  if (!(await confirmDiscardRemoteEditors(currentTabIds))) return [];
  const ids = useTabsStore.getState().launchSet(
    hosts.map((host) =>
      host.kind === 'ssh'
        ? {
            profile: { kind: 'ssh' as const, target: host.entry.alias },
            title: host.entry.metadata?.displayName ?? host.entry.alias,
            color: host.entry.metadata?.color,
          }
        : {
            profile: { ...host.entry.profile, profileId: host.entry.id },
            title: savedHostDisplayName(host.entry),
            color: host.entry.metadata.color,
          },
    ),
    layout,
  );
  useMultiExecStore.getState().setGroups([]);
  return ids;
}

/**
 * Switch mirrored input on or off from the keyboard. Switching it on resumes
 * the terminals that were mirroring last, and for a first press falls back to
 * the sessions on screen — the ones visibly receiving the keystrokes.
 */
export function toggleMultiExec(): boolean {
  const { tabs, root, zoomedPaneId } = useTabsStore.getState();
  const connected = tabs.filter((tab) => tab.status === 'connected').map((tab) => tab.id);
  const onScreen = visibleTabIds(root, zoomedPaneId);
  if (useMultiExecStore.getState().toggleMirroring(connected, onScreen)) return true;
  showToast(
    'info',
    connected.length < 2
      ? 'Connect at least two sessions to mirror input.'
      : 'Pick the terminals to mirror input into from the multi-exec control.',
  );
  return true;
}

/** Duplicate an open tab (same profile, fresh session). */
export function duplicateTab(tabId: string): boolean {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.profile) return false;
  const id = useTabsStore.getState().open(tab.profile, tab.title);
  if (tab.color) useTabsStore.getState().update(id, { color: tab.color });
  return true;
}

/**
 * Serial consoles own the device exclusively, so a second session on the same
 * port would only fail; everything else can be dialed again.
 */
function canReopen(profile: SessionProfile): boolean {
  return profile.kind !== 'serial';
}

/**
 * Split the focused pane and, unless the user opted out, carry the current
 * session into it — the tmux reflex of "same box, one more pane". Panes with
 * nothing to copy open the session chooser instead.
 */
export function splitActivePane(direction: PaneDirection): boolean {
  const state = useTabsStore.getState();
  const source = state.tabs.find((tab) => tab.id === state.activeId);
  const paneId = state.activePaneId;
  if (!state.split(paneId, direction)) return false;
  if (
    usePrefsStore.getState().splitInheritsSession &&
    source?.profile &&
    canReopen(source.profile)
  ) {
    const id = useTabsStore.getState().open(source.profile, source.title);
    if (source.color) useTabsStore.getState().update(id, { color: source.color });
  }
  return true;
}

/** Close the focused pane, or the tab when the canvas has a single pane. */
export function requestCloseActivePane(): boolean {
  const { root, activePaneId, activeId } = useTabsStore.getState();
  if (root.type === 'pane') {
    if (!activeId) return false;
    void requestCloseTabs([activeId]);
    return true;
  }
  void requestClosePane(activePaneId);
  return true;
}

/** Open the tab's profile as a fresh session in a separate app window. */
export function openTabInNewWindow(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab?.profile) return;
  openAppWindow({
    kind: 'session',
    profile: tab.profile,
    title: tab.title,
    ...(tab.color ? { color: tab.color } : {}),
  });
}

/** Open a new window which claims the existing tab instead of redialing it. */
export function moveTabToNewWindow(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  const transferId = createTabTransferId();
  void import('./tab-transfer.js').then((module) =>
    module.registerTabTransferSource(transferId, tabId),
  );
  // Keep the native/web window open inside the original user gesture. The
  // destination retries its claim while the lazily loaded source registers.
  openTabTransferInNewWindow(transferId, tab.title);
}

/** Finish a drag outside this renderer by opening a destination for its token. */
export function openTabTransferInNewWindow(transferId: string, title: string): void {
  openAppWindow({ kind: 'tab-transfer', transferId, title });
}

/** Detach a drag using native cursor bounds on desktop and DOM bounds on the web. */
export function detachTabToNewWindow(
  transferId: string,
  title: string,
  event: Pick<DragEvent, 'dataTransfer' | 'screenX' | 'screenY'>,
): void {
  const launch = { kind: 'tab-transfer' as const, transferId, title };
  if (window.muxusDesktop) {
    void window.muxusDesktop.detachTab(launch);
    return;
  }
  if (shouldDetachTabDrag(event)) openAppWindow(launch);
}

/** Open a listed host as a fresh SSH session in a separate app window. */
export function openHostInNewWindow(host: SshHostEntry): void {
  openAppWindow({
    kind: 'session',
    profile: { kind: 'ssh', target: host.alias },
    title: host.metadata?.displayName ?? host.alias,
    ...(host.metadata?.color ? { color: host.metadata.color } : {}),
  });
}

export function openSavedHostInNewWindow(host: SavedHostProfile): void {
  openAppWindow({
    kind: 'session',
    profile: { ...host.profile, profileId: host.id },
    title: savedHostDisplayName(host),
    ...(host.metadata.color ? { color: host.metadata.color } : {}),
  });
}

export function openManagedHostInNewWindow(host: ManagedHost): void {
  if (host.kind === 'ssh') openHostInNewWindow(host.entry);
  else openSavedHostInNewWindow(host.entry);
}

/**
 * The pref-gated "this ends a live session" question, shared by tab and pane
 * closes. Returns false when the user backs out.
 */
async function confirmEndingLiveSessions(
  targets: string[],
  title: string,
): Promise<boolean> {
  const live = useTabsStore
    .getState()
    .tabs.filter((tab) => targets.includes(tab.id) && tab.status === 'connected');
  if (live.length === 0 || !usePrefsStore.getState().confirmCloseConnected) return true;
  return confirmAction({
    title,
    description:
      live.length === 1
        ? `“${live[0]!.title}” has a live session — closing ends it.`
        : `${live.length} tabs have live sessions — closing ends them.`,
    confirmLabel: 'Close',
    destructive: true,
    checkbox: {
      label: 'Don’t ask again',
      onChecked: () => usePrefsStore.getState().set({ confirmCloseConnected: false }),
    },
  });
}

/**
 * Close tabs, asking first when any of them still has unsaved files or
 * a live session (the latter is pref-gated).
 */
export async function requestCloseTabs(tabIds: string[]): Promise<void> {
  const targets = tabIds.filter((id) =>
    useTabsStore.getState().tabs.some((tab) => tab.id === id),
  );
  if (targets.length === 0) return;
  if (!(await confirmDiscardRemoteEditors(targets))) return;
  const title =
    targets.length === 1 ? 'Close this tab?' : `Close ${targets.length} tabs?`;
  if (!(await confirmEndingLiveSessions(targets, title))) return;
  const { close } = useTabsStore.getState();
  for (const id of targets) close(id);
}

/**
 * Close a split pane and every tab it contains. Live sessions use the same
 * preference-gated confirmation as individual tab closes.
 */
export async function requestClosePane(paneId: string): Promise<void> {
  const { root, tabs } = useTabsStore.getState();
  if (root.type === 'pane' || !findPane(root, paneId)) return;
  const targets = tabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.id);
  if (!(await confirmDiscardRemoteEditors(targets))) return;
  if (!(await confirmEndingLiveSessions(targets, 'Close this pane?'))) return;
  useTabsStore.getState().closePane(paneId);
}

/**
 * Whether omnibox input can be dialed directly: "[user@]host[:port]" with a
 * plausible host part. Deliberately permissive — any single word could be a
 * resolvable hostname or config alias.
 */
export function isQuickConnectTarget(input: string): boolean {
  const s = input.trim();
  if (!s || /\s/.test(s)) return false;
  const at = s.lastIndexOf('@');
  const user = at > 0 ? s.slice(0, at) : undefined;
  const rest = at > 0 ? s.slice(at + 1) : s;
  if (at === 0 || user === '') return false;
  const m = /^([^:]+)(?::(\d+))?$/.exec(rest);
  if (!m || !m[1]) return false;
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}
