import type { SessionProfile } from '@muxus/shared';
import { usePrefsStore } from './state/prefs.js';
import { useSessionsStore, type SavedSession } from './state/sessions.js';
import { useTabsStore } from './state/tabs.js';

/** Open a local terminal tab using the current preferences. */
export function openLocalTerminal(): void {
  const { localShell, termName } = usePrefsStore.getState();
  const profile: SessionProfile = {
    kind: 'local',
    shell: localShell !== 'auto' && localShell.trim() ? localShell.trim() : undefined,
    term: termName,
  };
  useTabsStore.getState().open(profile, 'Local');
}

/** Open an SSH tab for a saved session. */
export function openSavedSession(session: SavedSession): void {
  const { termName } = usePrefsStore.getState();
  const profile: SessionProfile = {
    kind: 'ssh',
    host: session.host,
    port: session.port,
    user: session.user,
    auth: session.auth,
    keyPath: session.keyPath,
    term: termName,
  };
  useTabsStore.getState().open(profile, session.name || sshTitle(session.user, session.host));
}

/** Open an SSH tab for a ~/.ssh/config alias (ssh resolves the details). */
export function openConfigHost(alias: string, user?: string): void {
  const { termName } = usePrefsStore.getState();
  const profile: SessionProfile = { kind: 'ssh', host: alias, auth: 'agent', term: termName };
  useTabsStore.getState().open(profile, sshTitle(user, alias));
}

/** Duplicate an open tab (same profile, fresh session). */
export function duplicateTab(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (tab) useTabsStore.getState().open(tab.profile, tab.title);
}

export function sshTitle(user: string | undefined, host: string): string {
  return user ? `${user}@${host}` : host;
}

/** Look up a saved session by id (for edit flows). */
export function savedSession(id: string): SavedSession | undefined {
  return useSessionsStore.getState().sessions.find((s) => s.id === id);
}
