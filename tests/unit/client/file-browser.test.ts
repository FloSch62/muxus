import { beforeEach, describe, expect, it } from 'vitest';
import {
  fileBrowserUnavailableReason,
  isFileBrowserShown,
  showFileBrowser,
  toggleFileBrowser,
  type FileBrowserPlacement,
} from '../../../client/src/file-browser.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useUiStore } from '../../../client/src/state/ui.js';

beforeEach(() => {
  usePrefsStore.setState({ sidebarCollapsed: false });
  useUiStore.setState({ focusMode: false, sidebarView: 'hosts', sidebarPanelOpen: true });
});

describe('whether the file browser is on screen', () => {
  const shown: FileBrowserPlacement = {
    sidebarCollapsed: false,
    focusMode: false,
    sidebarView: 'files',
    sidebarPanelOpen: true,
  };

  it('is while its panel is in front of the open sidebar', () => {
    expect(isFileBrowserShown(shown)).toBe(true);
    expect(isFileBrowserShown({ ...shown, sidebarView: 'hosts' })).toBe(false);
  });

  it('is hidden with the sidebar', () => {
    expect(isFileBrowserShown({ ...shown, sidebarCollapsed: true })).toBe(false);
    expect(isFileBrowserShown({ ...shown, focusMode: true })).toBe(false);
  });

  it('is hidden while the panel is closed and only the rail shows', () => {
    expect(isFileBrowserShown({ ...shown, sidebarPanelOpen: false })).toBe(false);
  });
});

describe('opening the file browser', () => {
  it('brings its panel to the front', () => {
    showFileBrowser();
    expect(useUiStore.getState()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: true });
  });

  it('brings a hidden sidebar and a closed panel back for it', () => {
    usePrefsStore.setState({ sidebarCollapsed: true });
    useUiStore.setState({ sidebarPanelOpen: false });

    showFileBrowser();

    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: true });
  });
});

describe('toggling the file browser', () => {
  it('switches back to the hosts and keeps the sidebar open', () => {
    toggleFileBrowser();
    expect(useUiStore.getState().sidebarView).toBe('files');
    toggleFileBrowser();
    expect(useUiStore.getState()).toMatchObject({ sidebarView: 'hosts', sidebarPanelOpen: true });
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
  });

  it('opens the browser when the sidebar is hidden on its panel', () => {
    usePrefsStore.setState({ sidebarCollapsed: true });
    useUiStore.setState({ sidebarView: 'files' });

    toggleFileBrowser();

    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState().sidebarView).toBe('files');
  });

  it('opens the browser when only the rail is showing', () => {
    useUiStore.setState({ sidebarView: 'files', sidebarPanelOpen: false });

    toggleFileBrowser();

    expect(useUiStore.getState()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: true });
  });
});

describe('the browser with nothing to show', () => {
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
