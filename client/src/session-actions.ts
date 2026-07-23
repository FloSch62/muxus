import type { LocalProfile, SessionProfile, SshHostEntry } from '@muxus/shared';
import { usePrefsStore } from './state/prefs.js';
import { useTabsStore } from './state/tabs.js';
import { useUiStore } from './state/ui.js';

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

/** Open a new local terminal tab using the user's shell/term preferences. */
export function openLocalTerminal(replaceTabId?: string): string {
  const { localShell, termName } = usePrefsStore.getState();
  const profile: LocalProfile = {
    kind: 'local',
    shell: localShell !== 'auto' && localShell.trim() ? localShell.trim() : undefined,
    term: termName,
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
  const { termName } = usePrefsStore.getState();
  const profile: SessionProfile = { kind: 'ssh', target, term: termName };
  const replacedId = replaceActiveEmpty(profile, title, replaceTabId);
  if (replacedId) return replacedId;
  return useTabsStore.getState().open(profile, title);
}

/** Connect a listed host with its Muxus display name and color carried into
 *  the tab, preserving the visual cue after the sidebar is hidden. */
export function connectHost(host: SshHostEntry, replaceTabId?: string): string {
  const id = connectTarget(host.alias, host.metadata?.displayName ?? host.alias, replaceTabId);
  if (host.metadata?.color) useTabsStore.getState().update(id, { color: host.metadata.color });
  return id;
}

/** Duplicate an open tab (same profile, fresh session). */
export function duplicateTab(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (tab?.profile) useTabsStore.getState().open(tab.profile, tab.title);
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
  const live = targets.some((id) => tabs.find((tab) => tab.id === id)?.status === 'connected');
  if (live && usePrefsStore.getState().confirmCloseConnected) {
    useUiStore.getState().setConfirmCloseTabs(targets);
    return;
  }
  for (const id of targets) close(id);
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
