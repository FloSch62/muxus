import { usePrefsStore } from './state/prefs.js';
import type { TerminalTab } from './state/tabs.js';
import { useUiStore, type SidebarView } from './state/ui.js';

/**
 * The file browser is one of the sidebar's panels and shows the files of
 * whichever SSH session is active. Every way of opening it goes through here,
 * so each behaves the same.
 */
export interface FileBrowserPlacement {
  sidebarCollapsed: boolean;
  focusMode: boolean;
  sidebarView: SidebarView;
  sidebarPanelOpen: boolean;
}

/** Whether the browser is on screen. */
export function isFileBrowserShown(placement: FileBrowserPlacement): boolean {
  return (
    !placement.sidebarCollapsed &&
    !placement.focusMode &&
    placement.sidebarPanelOpen &&
    placement.sidebarView === 'files'
  );
}

function currentPlacement(): FileBrowserPlacement {
  const prefs = usePrefsStore.getState();
  const ui = useUiStore.getState();
  return {
    sidebarCollapsed: prefs.sidebarCollapsed,
    focusMode: ui.focusMode,
    sidebarView: ui.sidebarView,
    sidebarPanelOpen: ui.sidebarPanelOpen,
  };
}

/**
 * Bring the browser on screen: showing a view also brings back a hidden
 * sidebar and a closed panel. It follows the active tab, so the caller
 * activates the one whose files it wants.
 */
export function showFileBrowser(): void {
  useUiStore.getState().setSidebarView('files');
}

/** Show the browser, or put it away and bring the hosts back. */
export function toggleFileBrowser(): void {
  if (isFileBrowserShown(currentPlacement())) useUiStore.getState().setSidebarView('hosts');
  else showFileBrowser();
}

/** Why the browser has no files to show for the active tab. */
export function fileBrowserUnavailableReason(
  tab: Pick<TerminalTab, 'profile' | 'status' | 'sftpAvailable' | 'systemOpenSsh'> | undefined,
): string {
  if (!tab?.profile) return 'Open an SSH session to browse its files.';
  if (tab.profile.kind !== 'ssh') return 'Only SSH sessions have a file browser.';
  if (tab.sftpAvailable === false) {
    return tab.systemOpenSsh
      ? 'The file browser is not available for this system OpenSSH session.'
      : 'SFTP is turned off for this host.';
  }
  if (tab.status === 'connecting') return 'Waiting for the session to connect…';
  return 'The session is not connected.';
}
