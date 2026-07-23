import type { LocalProfile, SessionProfile } from '@muxus/shared';
import { usePrefsStore } from './state/prefs.js';
import { useTabsStore } from './state/tabs.js';
import type { SavedSession } from './state/sessions.js';

/** Open a new local terminal tab using the user's shell/term preferences. */
export function openLocalTerminal(): string {
  const { localShell, termName } = usePrefsStore.getState();
  const profile: LocalProfile = {
    kind: 'local',
    shell: localShell === 'auto' ? undefined : localShell,
    term: termName,
  };
  return useTabsStore.getState().open(profile, 'Local');
}

/** Open a tab for a saved SSH session. */
export function openSavedSession(session: SavedSession): string {
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
  return useTabsStore.getState().open(profile, session.name);
}

/** Open an ad-hoc SSH tab straight from a ~/.ssh/config alias (agent auth). */
export function openConfigHost(alias: string, hint: { user?: string; port?: number }): string {
  const { termName } = usePrefsStore.getState();
  const profile: SessionProfile = {
    kind: 'ssh',
    host: alias,
    port: hint.port,
    user: hint.user,
    auth: 'agent',
    term: termName,
  };
  return useTabsStore.getState().open(profile, alias);
}
