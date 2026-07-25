import type {
  LocalProfile,
  SavedHostProfile,
  SessionProfile,
  SshHostEntry,
} from '@muxus/shared';
import type { ManagedHost } from './managed-hosts.js';
import { savedHostDisplayName } from './saved-hosts.js';
import { usePrefsStore } from './state/prefs.js';
import { useMultiExecStore } from './state/multi-exec.js';
import { useTabsStore } from './state/tabs.js';
import type { PaneDirection, SessionSetLayout } from './state/tabs.js';
import { useUiStore } from './state/ui.js';
import { confirmDiscardRemoteEditors } from './editor/remote-editor-registry.js';
import { findPane } from './state/workspace-layout.js';
import { openAppWindow } from './window-management.js';

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

/** Open a new local terminal tab using the user's shell preference. */
export function openLocalTerminal(replaceTabId?: string): string {
  const { localShell } = usePrefsStore.getState();
  const profile: LocalProfile = {
    kind: 'local',
    shell: localShell !== 'auto' && localShell.trim() ? localShell.trim() : undefined,
  };
  const replacedId = replaceActiveEmpty(profile, 'Local', replaceTabId);
  if (replacedId) return replacedId;
  return useTabsStore.getState().open(profile, 'Local');
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
  const replacedId = replaceActiveEmpty(profile, title, replaceTabId);
  if (replacedId) return replacedId;
  return useTabsStore.getState().open(profile, title);
}

export function connectSavedHost(host: SavedHostProfile, replaceTabId?: string): string {
  const profile = { ...host.profile, profileId: host.id };
  const title = savedHostDisplayName(host);
  const replacedId = replaceActiveEmpty(profile, title, replaceTabId);
  const id = replacedId ?? useTabsStore.getState().open(profile, title);
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
export function launchManagedHostGroup(
  hosts: readonly ManagedHost[],
  layout: SessionSetLayout,
): string[] {
  const currentTabIds = useTabsStore.getState().tabs.map((tab) => tab.id);
  if (!confirmDiscardRemoteEditors(currentTabIds)) return [];
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
    requestCloseTabs([activeId]);
    return true;
  }
  requestClosePane(activePaneId);
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
 * Close tabs, routing through a confirmation dialog when any of them still
 * has a live session (pref-gated). The dialog in AppShell performs the
 * actual close on confirm.
 */
export function requestCloseTabs(tabIds: string[]): void {
  const { tabs, close } = useTabsStore.getState();
  const targets = tabIds.filter((id) => tabs.some((tab) => tab.id === id));
  if (targets.length === 0) return;
  if (!confirmDiscardRemoteEditors(targets)) return;
  const live = targets.some((id) => tabs.find((tab) => tab.id === id)?.status === 'connected');
  if (live && usePrefsStore.getState().confirmCloseConnected) {
    useUiStore.getState().setConfirmClose({ tabIds: targets });
    return;
  }
  for (const id of targets) close(id);
}

/**
 * Close a split pane and every tab it contains. Live sessions use the same
 * preference-gated confirmation as individual tab closes.
 */
export function requestClosePane(paneId: string): void {
  const { root, tabs, closePane } = useTabsStore.getState();
  if (root.type === 'pane' || !findPane(root, paneId)) return;
  const targets = tabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.id);
  if (!confirmDiscardRemoteEditors(targets)) return;
  const live = tabs.some((tab) => tab.paneId === paneId && tab.status === 'connected');
  if (live && usePrefsStore.getState().confirmCloseConnected) {
    useUiStore.getState().setConfirmClose({ tabIds: targets, paneId });
    return;
  }
  closePane(paneId);
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
