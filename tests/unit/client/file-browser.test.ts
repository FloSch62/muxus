import { beforeEach, describe, expect, it } from 'vitest';
import {
  fileBrowserUnavailableReason,
  isFileBrowserShown,
  moveFileBrowser,
  showFileBrowser,
  toggleFileBrowser,
  type FileBrowserPlacement,
} from '../../../client/src/file-browser.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useUiStore } from '../../../client/src/state/ui.js';

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    unreadOutputIds: new Set(),
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
  });
  usePrefsStore.setState({ fileBrowserPosition: 'pane', sidebarCollapsed: false });
  useUiStore.setState({ focusMode: false, sidebarView: 'hosts' });
});

function openSshTab(): string {
  const id = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
  useTabsStore.getState().update(id, { status: 'connected', connId: 'connection-1' });
  return id;
}

const sftpOpen = (id: string) =>
  useTabsStore.getState().tabs.find((tab) => tab.id === id)?.sftpOpen;

describe('whether the file browser is on screen', () => {
  const docked: FileBrowserPlacement = {
    position: 'sidebar',
    sidebarCollapsed: false,
    focusMode: false,
    sidebarView: 'files',
  };

  it('follows the tab beside the terminal', () => {
    const placement = { ...docked, position: 'pane' } as const;
    expect(isFileBrowserShown(placement, { sftpOpen: true })).toBe(true);
    expect(isFileBrowserShown(placement, { sftpOpen: false })).toBe(false);
    expect(isFileBrowserShown(placement, undefined)).toBe(false);
  });

  it('follows the sidebar tab when docked there, whatever the tab says', () => {
    expect(isFileBrowserShown(docked, { sftpOpen: false })).toBe(true);
    expect(isFileBrowserShown({ ...docked, sidebarView: 'hosts' }, { sftpOpen: true })).toBe(false);
  });

  it('is hidden with the sidebar', () => {
    expect(isFileBrowserShown({ ...docked, sidebarCollapsed: true }, undefined)).toBe(false);
    expect(isFileBrowserShown({ ...docked, focusMode: true }, undefined)).toBe(false);
  });
});

describe('opening the file browser', () => {
  it('opens beside the terminal of that tab', () => {
    const id = openSshTab();

    showFileBrowser(id);

    expect(sftpOpen(id)).toBe(true);
    expect(useUiStore.getState().sidebarView).toBe('hosts');
  });

  it('brings the sidebar and its file browser tab forward when docked there', () => {
    usePrefsStore.setState({ fileBrowserPosition: 'sidebar', sidebarCollapsed: true });
    const id = openSshTab();

    showFileBrowser(id);

    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState().sidebarView).toBe('files');
    expect(sftpOpen(id)).toBe(false);
  });
});

describe('toggling the file browser', () => {
  it('closes the browser beside the terminal', () => {
    const id = openSshTab();

    toggleFileBrowser(id);
    expect(sftpOpen(id)).toBe(true);
    toggleFileBrowser(id);
    expect(sftpOpen(id)).toBe(false);
  });

  it('switches the docked sidebar back to the hosts and keeps it open', () => {
    usePrefsStore.setState({ fileBrowserPosition: 'sidebar' });
    const id = openSshTab();

    toggleFileBrowser(id);
    expect(useUiStore.getState().sidebarView).toBe('files');
    toggleFileBrowser(id);
    expect(useUiStore.getState().sidebarView).toBe('hosts');
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
  });

  it('opens the docked browser when the sidebar is hidden on its file tab', () => {
    usePrefsStore.setState({ fileBrowserPosition: 'sidebar', sidebarCollapsed: true });
    useUiStore.setState({ sidebarView: 'files' });
    const id = openSshTab();

    toggleFileBrowser(id);

    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState().sidebarView).toBe('files');
  });
});

describe('moving the file browser', () => {
  it('docks it in the sidebar with the file browser tab in front', () => {
    const id = openSshTab();
    useTabsStore.getState().update(id, { sftpOpen: true });

    moveFileBrowser('sidebar', id);

    expect(usePrefsStore.getState().fileBrowserPosition).toBe('sidebar');
    expect(useUiStore.getState().sidebarView).toBe('files');
  });

  it('opens it beside the terminal of the tab it was showing', () => {
    usePrefsStore.setState({ fileBrowserPosition: 'sidebar' });
    useUiStore.setState({ sidebarView: 'files' });
    const id = openSshTab();

    moveFileBrowser('pane', id);

    expect(usePrefsStore.getState().fileBrowserPosition).toBe('pane');
    expect(sftpOpen(id)).toBe(true);
  });
});

describe('moving the file browser without a session', () => {
  it('only changes where it docks', () => {
    usePrefsStore.setState({ fileBrowserPosition: 'sidebar' });

    moveFileBrowser('pane', undefined);

    expect(usePrefsStore.getState().fileBrowserPosition).toBe('pane');
    expect(useTabsStore.getState().tabs).toEqual([]);
  });
});

describe('the docked browser with nothing to show', () => {
  it('says why for each kind of tab', () => {
    expect(fileBrowserUnavailableReason(undefined)).toBe(
      'Open an SSH session to browse its files.',
    );
    expect(
      fileBrowserUnavailableReason({ profile: null, status: 'idle' }),
    ).toBe('Open an SSH session to browse its files.');
    expect(
      fileBrowserUnavailableReason({ profile: { kind: 'local' }, status: 'connected' }),
    ).toBe('Only SSH sessions have a file browser.');
    expect(
      fileBrowserUnavailableReason({
        profile: { kind: 'ssh', target: 'router' },
        status: 'connected',
        sftpAvailable: false,
      }),
    ).toBe('SFTP is turned off for this host.');
    expect(
      fileBrowserUnavailableReason({ profile: { kind: 'ssh', target: 'router' }, status: 'connecting' }),
    ).toBe('Waiting for the session to connect…');
    expect(
      fileBrowserUnavailableReason({ profile: { kind: 'ssh', target: 'router' }, status: 'closed' }),
    ).toBe('The session is not connected.');
  });
});
