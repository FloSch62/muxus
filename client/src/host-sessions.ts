import { tabsInOrder, type SessionTab, type TerminalTab } from './state/tabs.js';
import type { PaneNode } from './state/workspace-layout.js';

/**
 * The sidebar host a tab was opened from, keyed like managedHostKey. Local
 * shells and ad-hoc remote sessions without a saved profile belong to no host.
 */
export function tabHostKey(tab: TerminalTab): string | undefined {
  const profile = tab.profile;
  if (!profile || profile.kind === 'local') return undefined;
  if (profile.profileId) return `profile:${profile.profileId}`;
  return profile.kind === 'ssh' ? `ssh:${profile.target}` : undefined;
}

/**
 * Every tab in this window opened from one sidebar host, in the window-wide
 * order the tab numbers follow — live, connecting and ended alike, since an
 * ended tab is still somewhere to jump back to.
 */
export function hostSessionTabs(
  root: PaneNode,
  tabs: readonly TerminalTab[],
  hostKey: string,
): SessionTab[] {
  return tabsInOrder(root, tabs).filter(
    (tab): tab is SessionTab => tabHostKey(tab) === hostKey,
  );
}
