import { usePrefsStore, type FileBrowserPosition } from './state/prefs.js';
import { useTabsStore, type TerminalTab } from './state/tabs.js';
import { useUiStore, type SidebarView } from './state/ui.js';

/**
 * The file browser either opens beside an SSH terminal, one tab at a time, or
 * sits behind a tab in the window sidebar and follows the active session.
 * Every way of opening it goes through here, so each behaves the same
 * wherever the browser is docked.
 */
export interface FileBrowserPlacement {
  position: FileBrowserPosition;
  sidebarCollapsed: boolean;
  focusMode: boolean;
  sidebarView: SidebarView;
}

/** Whether the browser for a tab is on screen. */
export function isFileBrowserShown(
  placement: FileBrowserPlacement,
  tab: Pick<TerminalTab, 'sftpOpen'> | undefined,
): boolean {
  if (placement.position === 'pane') return !!tab?.sftpOpen;
  return !placement.sidebarCollapsed && !placement.focusMode && placement.sidebarView === 'files';
}

function currentPlacement(): FileBrowserPlacement {
  const prefs = usePrefsStore.getState();
  const ui = useUiStore.getState();
  return {
    position: prefs.fileBrowserPosition,
    sidebarCollapsed: prefs.sidebarCollapsed,
    focusMode: ui.focusMode,
    sidebarView: ui.sidebarView,
  };
}

/** Reactive {@link isFileBrowserShown}, for controls that reflect it. */
export function useFileBrowserShown(tab: Pick<TerminalTab, 'sftpOpen'> | undefined): boolean {
  const position = usePrefsStore((state) => state.fileBrowserPosition);
  const sidebarCollapsed = usePrefsStore((state) => state.sidebarCollapsed);
  const focusMode = useUiStore((state) => state.focusMode);
  const sidebarView = useUiStore((state) => state.sidebarView);
  return isFileBrowserShown({ position, sidebarCollapsed, focusMode, sidebarView }, tab);
}

/** Bring the browser for a tab on screen. The caller activates the tab. */
export function showFileBrowser(tabId: string): void {
  if (usePrefsStore.getState().fileBrowserPosition === 'pane') {
    useTabsStore.getState().update(tabId, { sftpOpen: true });
    return;
  }
  if (usePrefsStore.getState().sidebarCollapsed) {
    usePrefsStore.getState().set({ sidebarCollapsed: false });
  }
  useUiStore.getState().setSidebarView('files');
}

/** Show the browser for a tab, or put it away. Docked, that brings the hosts back. */
export function toggleFileBrowser(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  const placement = currentPlacement();
  if (!isFileBrowserShown(placement, tab)) {
    showFileBrowser(tabId);
  } else if (placement.position === 'pane') {
    useTabsStore.getState().update(tabId, { sftpOpen: false });
  } else {
    useUiStore.getState().setSidebarView('hosts');
  }
}

/** Dock the browser elsewhere and keep the tab's browser in view there. */
export function moveFileBrowser(position: FileBrowserPosition, tabId: string | undefined): void {
  usePrefsStore.getState().set({ fileBrowserPosition: position });
  if (tabId) showFileBrowser(tabId);
}

/** Why the sidebar's browser has no files to show for the active tab. */
export function fileBrowserUnavailableReason(
  tab: Pick<TerminalTab, 'profile' | 'status' | 'sftpAvailable'> | undefined,
): string {
  if (!tab?.profile) return 'Open an SSH session to browse its files.';
  if (tab.profile.kind !== 'ssh') return 'Only SSH sessions have a file browser.';
  if (tab.sftpAvailable === false) return 'SFTP is turned off for this host.';
  if (tab.status === 'connecting') return 'Waiting for the session to connect…';
  return 'The session is not connected.';
}
