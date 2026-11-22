import { beforeEach, describe, expect, it } from 'vitest';
import {
  openEmptyTab,
  openSessionProfile,
  requestForceReconnect,
  requestForceReconnectAll,
  requestClosePane,
  splitActivePane,
} from '../../../client/src/session-actions.js';
import {
  managedHostSupportsSftp,
  openManagedHostSftp,
} from '../../../client/src/components/sidebar/host-sftp-action.js';
import { useDialogStore } from '../../../client/src/state/dialogs.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import {
  closableTabIdsToRight,
  isEmptyTab,
  tabLostConnection,
  tabsInOrder,
  useTabsStore,
  type SessionTab,
  type TerminalTab,
} from '../../../client/src/state/tabs.js';
import { useUiStore } from '../../../client/src/state/ui.js';
import {
  findPane,
  flattenPaneLayout,
  panesInOrder,
  serializeWorkspace,
  type SplitNode,
} from '../../../client/src/state/workspace-layout.js';

/** Let the close flow run up to the point where it raises its dialog. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Answer the dialog the way a click on Confirm/Cancel would. */
const answerDialog = async (confirmed: boolean) => {
  useDialogStore.getState().resolveHead(confirmed);
  await settle();
};

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    unreadOutputIds: new Set(),
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
    tiling: null,
  });
  usePrefsStore.setState({
    confirmCloseConnected: true,
    splitInheritsSession: true,
    sidebarCollapsed: false,
  });
  useUiStore.setState({ sidebarView: 'hosts', sidebarPanelOpen: true });
  useDialogStore.setState({ queue: [] });
});

describe('terminal output notifications', () => {
  it('marks output on a hidden tab and clears it when the tab is activated', () => {
    const store = useTabsStore.getState();
    const backgroundId = store.open({ kind: 'local' }, 'Background');
    const activeId = store.open({ kind: 'local' }, 'Active');

    useTabsStore.getState().notifyOutput(backgroundId);
    useTabsStore.getState().notifyOutput(activeId);

    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set([backgroundId]));

    useTabsStore.getState().activate(backgroundId);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());
  });

  it('does not update state again for subsequent output while a notification is unread', () => {
    const store = useTabsStore.getState();
    const backgroundId = store.open({ kind: 'local' }, 'Background');
    store.open({ kind: 'local' }, 'Active');
    useTabsStore.getState().notifyOutput(backgroundId);
    const unreadOutputIds = useTabsStore.getState().unreadOutputIds;

    useTabsStore.getState().notifyOutput(backgroundId);

    expect(useTabsStore.getState().unreadOutputIds).toBe(unreadOutputIds);
  });

  it('clears notifications when cycling to or closing a background tab', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'First');
    const secondId = store.open({ kind: 'local' }, 'Second');
    useTabsStore.getState().notifyOutput(firstId);

    useTabsStore.getState().cycle(true);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());

    useTabsStore.getState().notifyOutput(secondId);
    useTabsStore.getState().close(secondId);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());
  });

  it('treats the selected tab in every split pane as visible', () => {
    const store = useTabsStore.getState();
    const leftId = store.open({ kind: 'local' }, 'Left');
    store.split('pane-test', 'right');
    useTabsStore.getState().open({ kind: 'local' }, 'Right');

    useTabsStore.getState().notifyOutput(leftId);

    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());
  });

  it('notifies for panes hidden by zoom and clears when they become visible again', () => {
    const store = useTabsStore.getState();
    const leftId = store.open({ kind: 'local' }, 'Left');
    store.split('pane-test', 'right');
    useTabsStore.getState().open({ kind: 'local' }, 'Right');
    useTabsStore.getState().toggleZoom();

    useTabsStore.getState().notifyOutput(leftId);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set([leftId]));

    useTabsStore.getState().toggleZoom();
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());
  });

  it('treats a terminal covered by its remote editor as hidden', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'ssh', target: 'router' }, 'Router');
    store.openEditor(id, '/etc/hosts');

    useTabsStore.getState().notifyOutput(id);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set([id]));

    useTabsStore.getState().closeEditor(id, '/etc/hosts');
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());
  });

  it('preserves unread output for the selected tab in a zoom-hidden pane', () => {
    const store = useTabsStore.getState();
    const closingId = store.open({ kind: 'local' }, 'Closing');
    const unreadId = store.open({ kind: 'local' }, 'Unread');
    store.split('pane-test', 'right');
    useTabsStore.getState().open({ kind: 'local' }, 'Zoomed');
    useTabsStore.getState().toggleZoom();
    useTabsStore.getState().notifyOutput(unreadId);

    useTabsStore.getState().close(closingId);

    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set([unreadId]));
  });
});

describe('blank session tabs', () => {
  it('opens an idle chooser instead of starting a local process', () => {
    const id = useTabsStore.getState().openEmpty();
    const state = useTabsStore.getState();

    expect(state.activeId).toBe(id);
    expect(state.tabs).toEqual([
      expect.objectContaining({
        id,
        title: 'New tab',
        profile: null,
        status: 'idle',
        connectOnMount: false,
      }),
    ]);
  });

  it('replaces the chooser when a local session is selected', () => {
    const state = useTabsStore.getState();
    const id = state.openEmpty();

    expect(state.replaceEmpty(id, { kind: 'local' }, 'Local')).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id,
        title: 'Local',
        profile: expect.objectContaining({ kind: 'local' }),
        status: 'connecting',
        connectOnMount: true,
      }),
    ]);
  });

  it('replaces the chooser when an SSH target is selected', () => {
    const state = useTabsStore.getState();
    const id = state.openEmpty();

    expect(
      state.replaceEmpty(id, { kind: 'ssh', target: 'edge-router' }, 'Edge router'),
    ).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id,
        title: 'Edge router',
        profile: expect.objectContaining({ kind: 'ssh', target: 'edge-router' }),
        status: 'connecting',
      }),
    ]);
  });
});

describe('host SFTP action', () => {
  const host = {
    kind: 'ssh' as const,
    entry: {
      alias: 'router',
      aliases: ['router'],
      file: '/home/test/.ssh/config',
      options: {},
      resolved: {
        hostname: 'router.example.test',
        port: 22,
        identityFiles: [],
        certificateFiles: [],
        identitiesOnly: false,
        forwardAgent: false,
        proxyJump: [],
        forwards: [],
        passwordOnly: false,
      },
    },
  };

  it('connects with the file browser in front, ready for the session', () => {
    const id = openManagedHostSftp(host);

    expect(useTabsStore.getState()).toMatchObject({
      activeId: id,
      tabs: [{ id, profile: { kind: 'ssh', target: 'router' }, status: 'connecting' }],
    });
    expect(useUiStore.getState().sidebarView).toBe('files');
  });

  it('reuses and activates an existing suitable connection', () => {
    const existingId = useTabsStore
      .getState()
      .open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().update(existingId, {
      status: 'connected',
      connId: 'connection-1',
      sftpAvailable: true,
    });
    useTabsStore.getState().open({ kind: 'local' }, 'Local');

    expect(openManagedHostSftp(host)).toBe(existingId);
    expect(useTabsStore.getState()).toMatchObject({
      activeId: existingId,
      tabs: [{ id: existingId }, { profile: { kind: 'local' } }],
    });
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(useUiStore.getState().sidebarView).toBe('files');
  });

  it('brings a hidden sidebar back for the file browser', () => {
    usePrefsStore.setState({ sidebarCollapsed: true });
    useUiStore.setState({ sidebarPanelOpen: false });

    const id = openManagedHostSftp(host);

    expect(useTabsStore.getState().activeId).toBe(id);
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState()).toMatchObject({ sidebarView: 'files', sidebarPanelOpen: true });
  });

  it('does nothing when SFTP is explicitly disabled', () => {
    const disabled = {
      ...host,
      entry: {
        ...host.entry,
        metadata: {
          profileId: 'ssh-router',
          connectCount: 0,
          disableSftp: true,
        },
      },
    };

    expect(managedHostSupportsSftp(disabled)).toBe(false);
    expect(openManagedHostSftp(disabled)).toBeUndefined();
    expect(useTabsStore.getState().tabs).toEqual([]);
  });
});

describe('workspace restoration', () => {
  it('starts restored local shells without reconnecting remote sessions', () => {
    useTabsStore.getState().restore({
      version: 1,
      root: {
        id: 'pane-restored',
        type: 'pane',
        activeTabId: 'local-tab',
        tabs: [
          {
            id: 'local-tab',
            kind: 'terminal',
            title: 'Local',
            profile: { kind: 'local', cwd: '/srv/app' },
            offerReconnect: true,
          },
          {
            id: 'ssh-tab',
            kind: 'terminal',
            title: 'Router',
            profile: { kind: 'ssh', target: 'router' },
            offerReconnect: true,
          },
        ],
      },
      activePaneId: 'pane-restored',
    });

    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: 'local-tab',
        status: 'connecting',
        connectOnMount: true,
        restored: true,
      }),
      expect.objectContaining({
        id: 'ssh-tab',
        status: 'closed',
        connectOnMount: false,
        restored: true,
      }),
    ]);
  });

  it('dials restored remote sessions when the restore opts in', () => {
    useTabsStore.getState().restore(
      {
        version: 1,
        root: {
          id: 'pane-restored',
          type: 'pane',
          activeTabId: 'ssh-tab',
          tabs: [
            {
              id: 'ssh-tab',
              kind: 'terminal',
              title: 'Router',
              profile: { kind: 'ssh', target: 'router' },
              offerReconnect: true,
            },
          ],
        },
        activePaneId: 'pane-restored',
      },
      { connectRemote: true },
    );

    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: 'ssh-tab',
        status: 'connecting',
        connectOnMount: true,
      }),
    ]);
  });

  it('reconnects only selected ended sessions', () => {
    useTabsStore.getState().restore({
      version: 1,
      root: {
        id: 'pane-restored',
        type: 'pane',
        tabs: [
          {
            id: 'ssh-a',
            kind: 'terminal',
            title: 'A',
            profile: { kind: 'ssh', target: 'a' },
            offerReconnect: true,
          },
          {
            id: 'ssh-b',
            kind: 'terminal',
            title: 'B',
            profile: { kind: 'ssh', target: 'b' },
            offerReconnect: true,
          },
        ],
      },
    });

    useTabsStore.getState().reconnect(['ssh-b']);

    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: 'ssh-a', status: 'closed', reconnectRequest: 0 }),
      expect.objectContaining({ id: 'ssh-b', status: 'connecting', reconnectRequest: 1 }),
    ]);
  });

  it('reconnects every ended workspace session with optional SSH reattachment', () => {
    useTabsStore.getState().restore({
      version: 1,
      root: {
        id: 'pane-restored',
        type: 'pane',
        tabs: [
          {
            id: 'ssh-a',
            kind: 'terminal',
            title: 'A',
            profile: { kind: 'ssh', target: 'a' },
            offerReconnect: true,
          },
          {
            id: 'telnet-b',
            kind: 'terminal',
            title: 'B',
            profile: { kind: 'telnet', host: 'b', port: 23 },
            offerReconnect: true,
          },
        ],
      },
    });

    useTabsStore.getState().reconnectAll({ reattach: 'tmux' });

    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: 'ssh-a',
        status: 'connecting',
        reconnectRequest: 1,
        reconnectMode: 'tmux',
      }),
      expect.objectContaining({
        id: 'telnet-b',
        status: 'connecting',
        reconnectRequest: 1,
        reconnectMode: undefined,
      }),
    ]);
  });

  it('force reconnects every remote session without replacing local shells', () => {
    const localId = useTabsStore.getState().open({ kind: 'local' }, 'Local');
    const sshId = useTabsStore.getState().open(
      { kind: 'ssh', target: 'router' },
      'Router',
    );
    const telnetId = useTabsStore.getState().open(
      { kind: 'telnet', host: 'console', port: 23 },
      'Console',
    );
    useTabsStore.getState().update(sshId, {
      status: 'connected',
      connId: 'old-transport',
    });
    useTabsStore.getState().update(telnetId, {
      status: 'interrupted',
      failureReason: 'not responding',
      disconnectReason: 'disconnected',
    });

    useTabsStore.getState().forceReconnectAll();

    expect(useTabsStore.getState().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: localId,
          status: 'connecting',
          reconnectRequest: 0,
        }),
        expect.objectContaining({
          id: sshId,
          status: 'connecting',
          connId: undefined,
          reconnectRequest: 1,
          freshTransport: expect.any(String),
          failureReason: undefined,
        }),
        expect.objectContaining({
          id: telnetId,
          status: 'connecting',
          reconnectRequest: 1,
          freshTransport: undefined,
          failureReason: undefined,
          disconnectReason: undefined,
        }),
      ]),
    );
  });

  it('confirms before force reconnecting live remote sessions', async () => {
    const sshId = useTabsStore.getState().open(
      { kind: 'ssh', target: 'router' },
      'Router',
    );
    useTabsStore.getState().update(sshId, { status: 'connected' });

    const pending = requestForceReconnectAll();
    await settle();

    expect(useDialogStore.getState().queue[0]).toMatchObject({
      kind: 'confirm',
      title: 'Force reconnect 1 remote session?',
      destructive: true,
    });
    await answerDialog(true);

    expect(await pending).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: sshId,
        status: 'connecting',
        reconnectRequest: 1,
        freshTransport: expect.any(String),
      }),
    ]);
  });

  it('force reconnects one session while its siblings keep their transport', () => {
    const sshId = useTabsStore.getState().open(
      { kind: 'ssh', target: 'router' },
      'Router',
    );
    const siblingId = useTabsStore.getState().open(
      { kind: 'ssh', target: 'router' },
      'Router 2',
    );
    useTabsStore.getState().update(sshId, { status: 'connected', connId: 'shared' });
    useTabsStore.getState().update(siblingId, { status: 'connected', connId: 'shared' });

    useTabsStore.getState().forceReconnect(sshId);

    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: sshId,
        status: 'connecting',
        connId: undefined,
        reconnectRequest: 1,
        freshTransport: expect.any(String),
      }),
      expect.objectContaining({
        id: siblingId,
        status: 'connected',
        connId: 'shared',
        reconnectRequest: 0,
      }),
    ]);
    expect(useTabsStore.getState().tabs[1]!.freshTransport).toBeUndefined();
  });

  it('confirms before force reconnecting one live session', async () => {
    const sshId = useTabsStore.getState().open(
      { kind: 'ssh', target: 'router' },
      'Router',
    );
    useTabsStore.getState().update(sshId, { status: 'connected' });

    const pending = requestForceReconnect(sshId);
    await settle();

    expect(useDialogStore.getState().queue[0]).toMatchObject({
      kind: 'confirm',
      title: 'Force reconnect Router?',
      destructive: true,
    });
    await answerDialog(true);

    expect(await pending).toBe(true);
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      status: 'connecting',
      reconnectRequest: 1,
      freshTransport: expect.any(String),
    });
  });

  it('force reconnects an ended session without a confirmation', async () => {
    const sshId = useTabsStore.getState().open(
      { kind: 'ssh', target: 'router' },
      'Router',
    );
    useTabsStore.getState().update(sshId, { status: 'closed' });

    expect(await requestForceReconnect(sshId)).toBe(true);

    expect(useDialogStore.getState().queue).toEqual([]);
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      status: 'connecting',
      reconnectRequest: 1,
      freshTransport: expect.any(String),
    });
  });

  it('keeps an unfulfilled fresh-transport request across retries until success', () => {
    const sshId = useTabsStore.getState().open(
      { kind: 'ssh', target: 'router' },
      'Router',
    );
    useTabsStore.getState().update(sshId, { status: 'connected' });
    useTabsStore.getState().forceReconnectAll();
    const token = useTabsStore.getState().tabs[0]!.freshTransport;
    expect(token).toEqual(expect.any(String));

    // A failed forced dial retries through reconnect() and must stay fresh —
    // never silently multiplex onto the transport it was meant to replace.
    useTabsStore.getState().update(sshId, { status: 'closed' });
    useTabsStore.getState().reconnect([sshId]);
    expect(useTabsStore.getState().tabs[0]!.freshTransport).toBe(token);

    // Success clears it, the way the terminal ready handler does.
    useTabsStore.getState().update(sshId, {
      status: 'connected',
      freshTransport: undefined,
    });
    expect(useTabsStore.getState().tabs[0]!.freshTransport).toBeUndefined();
  });

  it('clears stale failure details when manually reconnecting', () => {
    useTabsStore.getState().restore({
      version: 1,
      root: {
        id: 'pane-restored',
        type: 'pane',
        tabs: [
          {
            id: 'ssh-a',
            kind: 'terminal',
            title: 'A',
            profile: { kind: 'ssh', target: 'a' },
            offerReconnect: true,
          },
        ],
      },
    });
    useTabsStore.getState().update('ssh-a', {
      failureReason: 'network unreachable',
      disconnectReason: 'failed',
    });

    useTabsStore.getState().reconnect(['ssh-a'], { reattach: 'screen' });

    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      status: 'connecting',
      reconnectMode: 'screen',
      failureReason: undefined,
      disconnectReason: undefined,
    });
  });

  it('clears the canvas when opening an empty workspace', () => {
    useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().restore({ version: 1, root: null });

    expect(useTabsStore.getState()).toMatchObject({
      tabs: [],
      root: { type: 'pane', activeTabId: null },
      activeId: null,
    });
  });
});

describe('session-set layouts', () => {
  const entries = [
    { profile: { kind: 'ssh' as const, target: 'a' }, title: 'A' },
    { profile: { kind: 'ssh' as const, target: 'b' }, title: 'B' },
    { profile: { kind: 'ssh' as const, target: 'c' }, title: 'C' },
    { profile: { kind: 'ssh' as const, target: 'd' }, title: 'D' },
  ];

  it('launches a group as tabs in one pane', () => {
    useTabsStore.getState().launchSet(entries, 'tabs');
    const state = useTabsStore.getState();
    expect(state.root.type).toBe('pane');
    expect(new Set(state.tabs.map((tab) => tab.paneId)).size).toBe(1);
    expect(state.tabs.every((tab) => tab.status === 'connecting')).toBe(true);
  });

  it('launches a group as an even grid', () => {
    useTabsStore.getState().launchSet(entries, 'grid');
    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      children: [
        { type: 'split', direction: 'vertical' },
        { type: 'split', direction: 'vertical' },
      ],
    });
    expect(new Set(state.tabs.map((tab) => tab.paneId)).size).toBe(4);
  });
});

describe('remote editor tabs', () => {
  it('opens, activates, and closes remote files without disturbing the terminal tab', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'ssh', target: 'edge-router' }, 'Edge router');

    store.openEditor(id, '/etc/hosts');
    store.openEditor(id, '/etc/ssh/sshd_config');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      editorPaths: ['/etc/hosts', '/etc/ssh/sshd_config'],
      activeEditorPath: '/etc/ssh/sshd_config',
    });

    store.activateEditor(id, '/etc/hosts');
    store.closeEditor(id, '/etc/hosts');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      profile: { kind: 'ssh', target: 'edge-router' },
      editorPaths: ['/etc/ssh/sshd_config'],
      activeEditorPath: '/etc/ssh/sshd_config',
    });

    store.closeEditor(id, '/etc/ssh/sshd_config');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      editorPaths: [],
      activeEditorPath: undefined,
    });
  });

  it('brings the terminal in front of open files and back without closing them', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'ssh', target: 'edge-router' }, 'Edge router');
    store.openEditor(id, '/etc/hosts');
    store.openEditor(id, '/etc/motd');

    store.showTerminal(id);
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      editorPaths: ['/etc/hosts', '/etc/motd'],
      activeEditorPath: '/etc/motd',
      terminalShown: true,
    });

    // Closing a file from the strip leaves the terminal in front.
    store.closeEditor(id, '/etc/motd');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      editorPaths: ['/etc/hosts'],
      activeEditorPath: '/etc/hosts',
      terminalShown: true,
    });

    store.activateEditor(id, '/etc/hosts');
    expect(useTabsStore.getState().tabs[0]?.terminalShown).toBe(false);

    store.showTerminal(id);
    store.openEditor(id, '/etc/resolv.conf');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      activeEditorPath: '/etc/resolv.conf',
      terminalShown: false,
    });

    store.showTerminal(id);
    store.closeEditor(id, '/etc/hosts');
    store.closeEditor(id, '/etc/resolv.conf');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      editorPaths: [],
      terminalShown: false,
    });
  });

  it('ignores a terminal request when no file is in front', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'local' }, 'Local');
    const before = useTabsStore.getState();

    store.showTerminal(id);

    expect(useTabsStore.getState()).toBe(before);
  });

  it('marks terminal output unread behind a file and clears it once the terminal is shown', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'local' }, 'Local');
    store.openEditor(id, '/tmp/notes.txt');

    useTabsStore.getState().notifyOutput(id);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set([id]));

    useTabsStore.getState().showTerminal(id);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());

    useTabsStore.getState().notifyOutput(id);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());
  });
});

describe('pane closing', () => {
  it('closes a non-empty pane and its tabs', () => {
    const store = useTabsStore.getState();
    const survivingTabId = store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'right');
    const closingPaneId = useTabsStore.getState().activePaneId;
    const closingTabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');

    useTabsStore.getState().closePane(closingPaneId);

    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({ id: 'pane-test', type: 'pane' });
    expect(state.tabs.map((tab) => tab.id)).toEqual([survivingTabId]);
    expect(state.tabs.some((tab) => tab.id === closingTabId)).toBe(false);
    expect(state.activePaneId).toBe('pane-test');
    expect(state.activeId).toBe(survivingTabId);
  });

  /** Splits off a second pane holding one connected SSH tab. */
  const paneWithLiveTab = () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'right');
    const paneId = useTabsStore.getState().activePaneId;
    const tabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().update(tabId, { status: 'connected' });
    return { paneId, tabId };
  };

  it('gates a pane containing live tabs behind the close confirmation', async () => {
    const { paneId } = paneWithLiveTab();

    void requestClosePane(paneId);
    await settle();

    expect(useDialogStore.getState().queue).toMatchObject([
      { kind: 'confirm', title: 'Close this pane?', destructive: true },
    ]);
    expect(useTabsStore.getState().root.type).toBe('split');
  });

  it('closes the pane once the confirmation is accepted', async () => {
    const { paneId } = paneWithLiveTab();

    void requestClosePane(paneId);
    await settle();
    await answerDialog(true);

    expect(useTabsStore.getState().root).toMatchObject({ id: 'pane-test', type: 'pane' });
  });

  it('keeps the pane when the confirmation is declined', async () => {
    const { paneId, tabId } = paneWithLiveTab();

    void requestClosePane(paneId);
    await settle();
    await answerDialog(false);

    expect(useTabsStore.getState().root.type).toBe('split');
    expect(useTabsStore.getState().tabs.some((tab) => tab.id === tabId)).toBe(true);
  });

  it('turns the preference off when the confirmation is accepted with "don’t ask again"', async () => {
    const { paneId } = paneWithLiveTab();

    void requestClosePane(paneId);
    await settle();
    const request = useDialogStore.getState().queue[0];
    if (request?.kind !== 'confirm') throw new Error('expected a confirmation');
    request.checkbox?.onChecked();
    await answerDialog(true);

    expect(usePrefsStore.getState().confirmCloseConnected).toBe(false);
  });

  it('closes a live pane immediately when confirmation is disabled', async () => {
    usePrefsStore.setState({ confirmCloseConnected: false });
    const { paneId } = paneWithLiveTab();

    await requestClosePane(paneId);

    expect(useDialogStore.getState().queue).toHaveLength(0);
    expect(useTabsStore.getState().root).toMatchObject({ id: 'pane-test', type: 'pane' });
  });
});

describe('directional splits', () => {
  it('places the new pane on the side that was asked for', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');

    const created = store.split('pane-test', 'left');

    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      children: [{ id: created }, { id: 'pane-test' }],
    });
    expect(state.activePaneId).toBe(created);
    expect(state.activeId).toBeNull();
  });

  it('stacks vertically when splitting up or down', () => {
    const store = useTabsStore.getState();
    const created = store.split('pane-test', 'down');

    expect(useTabsStore.getState().root).toMatchObject({
      type: 'split',
      direction: 'vertical',
      children: [{ id: 'pane-test' }, { id: created }],
    });
  });

  it('carries the current session, and its color, into the new pane', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().update(id, { color: '#ef5350' });

    expect(splitActivePane('right')).toBe(true);

    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({ type: 'split', direction: 'horizontal' });
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]).toMatchObject({
      profile: { kind: 'ssh', target: 'router' },
      title: 'Router',
      color: '#ef5350',
      paneId: state.activePaneId,
      status: 'connecting',
    });
    expect(state.activeId).toBe(state.tabs[1]!.id);
  });

  it('leaves the session chooser for serial consoles and when opted out', () => {
    const store = useTabsStore.getState();
    store.open(
      {
        kind: 'serial',
        path: '/dev/ttyUSB0',
        baudRate: 115_200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      },
      'Console',
    );

    splitActivePane('right');
    expect(useTabsStore.getState().tabs).toHaveLength(1);

    usePrefsStore.setState({ splitInheritsSession: false });
    useTabsStore.getState().open({ kind: 'local' }, 'Local');
    splitActivePane('down');
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(useTabsStore.getState().activeId).toBeNull();
  });
});

describe('keyboard pane focus', () => {
  it('moves focus to the pane on that side and reports when there is none', () => {
    const store = useTabsStore.getState();
    const localId = store.open({ kind: 'local' }, 'Local');
    const rightPane = store.split('pane-test', 'right')!;
    const remoteId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');

    expect(useTabsStore.getState().focusPaneDirection('left')).toBe(true);
    expect(useTabsStore.getState()).toMatchObject({ activePaneId: 'pane-test', activeId: localId });

    expect(useTabsStore.getState().focusPaneDirection('right')).toBe(true);
    expect(useTabsStore.getState()).toMatchObject({ activePaneId: rightPane, activeId: remoteId });

    // Nothing further right: the key is left to the terminal.
    expect(useTabsStore.getState().focusPaneDirection('right')).toBe(false);
    expect(useTabsStore.getState().focusPaneDirection('up')).toBe(false);
  });

  it('cycles panes in reading order', () => {
    const store = useTabsStore.getState();
    const rightPane = store.split('pane-test', 'right')!;
    useTabsStore.getState().focusPane('pane-test');

    expect(useTabsStore.getState().cyclePane(false)).toBe(true);
    expect(useTabsStore.getState().activePaneId).toBe(rightPane);
    expect(useTabsStore.getState().cyclePane(false)).toBe(true);
    expect(useTabsStore.getState().activePaneId).toBe('pane-test');
  });

});

describe('moving tabs between panes', () => {
  it('drops a background tab at an exact position in another pane', () => {
    const store = useTabsStore.getState();
    const movingId = store.open({ kind: 'local' }, 'Moving');
    const stayingId = store.open({ kind: 'local' }, 'Staying');
    const rightPane = store.split('pane-test', 'right')!;
    const firstRightId = useTabsStore.getState().open({ kind: 'local' }, 'Right one');
    const secondRightId = useTabsStore.getState().open({ kind: 'local' }, 'Right two');

    expect(
      useTabsStore.getState().moveTabToPane(movingId, rightPane, secondRightId, 'before'),
    ).toBe(true);

    const state = useTabsStore.getState();
    expect(
      state.tabs.filter((tab) => tab.paneId === rightPane).map((tab) => tab.id),
    ).toEqual([firstRightId, movingId, secondRightId]);
    expect(findPane(state.root, 'pane-test')?.activeTabId).toBe(stayingId);
    expect(state).toMatchObject({ activePaneId: rightPane, activeId: movingId });
  });

  it('collapses a split after its last tab is dropped into its sibling', () => {
    const store = useTabsStore.getState();
    const leftId = store.open({ kind: 'local' }, 'Left');
    const rightPane = store.split('pane-test', 'right')!;
    const movingId = useTabsStore.getState().open({ kind: 'local' }, 'Right');

    expect(useTabsStore.getState().moveTabToPane(movingId, 'pane-test', leftId)).toBe(true);

    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({ id: 'pane-test', type: 'pane', activeTabId: movingId });
    expect(state.tabs.map((tab) => [tab.id, tab.paneId])).toEqual([
      [leftId, 'pane-test'],
      [movingId, 'pane-test'],
    ]);
    expect(state.activePaneId).toBe('pane-test');
    expect(rightPane).not.toBe('pane-test');
  });

  it('sends the active tab to the neighbouring pane', () => {
    const store = useTabsStore.getState();
    const stayId = store.open({ kind: 'local' }, 'Local');
    const rightPane = store.split('pane-test', 'right')!;
    const movingId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');

    expect(useTabsStore.getState().moveTabToDirection('left')).toBe(true);

    const state = useTabsStore.getState();
    // The emptied pane collapses, leaving both tabs in the surviving pane.
    expect(state.root).toMatchObject({ id: 'pane-test', type: 'pane' });
    expect(state.tabs.map((tab) => [tab.id, tab.paneId])).toEqual([
      [stayId, 'pane-test'],
      [movingId, 'pane-test'],
    ]);
    expect(state).toMatchObject({ activePaneId: 'pane-test', activeId: movingId });
    expect(rightPane).not.toBe('pane-test');
  });

  it('splits off a new pane when there is none in that direction', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'Local');
    const secondId = store.open({ kind: 'ssh', target: 'router' }, 'Router');

    expect(useTabsStore.getState().moveTabToDirection('down')).toBe(true);

    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({
      type: 'split',
      direction: 'vertical',
      children: [{ id: 'pane-test', activeTabId: firstId }, { activeTabId: secondId }],
    });
    expect(state.activeId).toBe(secondId);
    expect(state.tabs.find((tab) => tab.id === secondId)?.paneId).toBe(state.activePaneId);
  });

  it('splits a specific background tab into a new right pane', () => {
    const store = useTabsStore.getState();
    const movingId = store.open({ kind: 'local' }, 'Move me');
    const stayingId = store.open({ kind: 'ssh', target: 'router' }, 'Stay here');

    expect(useTabsStore.getState().moveTabToNewPane(movingId, 'right')).toBe(true);

    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      children: [
        { id: 'pane-test', activeTabId: stayingId },
        { activeTabId: movingId },
      ],
    });
    expect(state.tabs.find((tab) => tab.id === movingId)?.paneId).toBe(state.activePaneId);
    expect(state.activeId).toBe(movingId);
  });

  it('splits a specific tab into a new lower pane', () => {
    const store = useTabsStore.getState();
    const stayingId = store.open({ kind: 'local' }, 'Stay here');
    const movingId = store.open({ kind: 'ssh', target: 'router' }, 'Move me');

    expect(useTabsStore.getState().moveTabToNewPane(movingId, 'down')).toBe(true);

    expect(useTabsStore.getState().root).toMatchObject({
      type: 'split',
      direction: 'vertical',
      children: [
        { id: 'pane-test', activeTabId: stayingId },
        { activeTabId: movingId },
      ],
    });
  });

  it('does not move the only tab into a new pane', () => {
    const id = useTabsStore.getState().open({ kind: 'local' }, 'Only tab');

    expect(useTabsStore.getState().moveTabToNewPane(id, 'right')).toBe(false);
    expect(useTabsStore.getState().root).toMatchObject({ id: 'pane-test', type: 'pane' });
  });

  it('declines to move the only tab of a pane into a new pane', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');

    expect(useTabsStore.getState().moveTabToDirection('right')).toBe(false);
    expect(useTabsStore.getState().root).toMatchObject({ type: 'pane' });
  });

  it('reorders tabs inside the strip', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'One');
    const secondId = store.open({ kind: 'local' }, 'Two');

    expect(useTabsStore.getState().moveTabWithinPane(-1)).toBe(true);
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([secondId, firstId]);
    expect(useTabsStore.getState().moveTabWithinPane(-1)).toBe(false);
  });

  it('reorders a dragged tab relative to its drop target', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'One');
    const secondId = store.open({ kind: 'local' }, 'Two');
    const thirdId = store.open({ kind: 'local' }, 'Three');

    expect(useTabsStore.getState().reorderTab(firstId, thirdId, 'after')).toBe(true);
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      secondId,
      thirdId,
      firstId,
    ]);
    expect(useTabsStore.getState().reorderTab(firstId, thirdId, 'after')).toBe(false);
  });

  it('groups pinned tabs first and reorders only within the same pin group', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'One');
    const secondId = store.open({ kind: 'local' }, 'Two');
    const thirdId = store.open({ kind: 'local' }, 'Three');

    expect(useTabsStore.getState().setPinned(secondId, true)).toBe(true);
    expect(useTabsStore.getState().setPinned(thirdId, true)).toBe(true);
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      secondId,
      thirdId,
      firstId,
    ]);
    expect(useTabsStore.getState().reorderTab(firstId, secondId, 'before')).toBe(false);
    expect(useTabsStore.getState().reorderTab(thirdId, secondId, 'before')).toBe(true);
    expect(useTabsStore.getState().setPinned(thirdId, false)).toBe(true);
    expect(useTabsStore.getState().tabs.map((tab) => [tab.id, !!tab.pinned])).toEqual([
      [secondId, true],
      [thirdId, false],
      [firstId, false],
    ]);
  });

  it('selects only unpinned tabs to the right for browser-style bulk close', () => {
    const store = useTabsStore.getState();
    const pinnedSourceId = store.open({ kind: 'local' }, 'Pinned source');
    const pinnedNeighborId = store.open({ kind: 'local' }, 'Pinned neighbor');
    const firstId = store.open({ kind: 'local' }, 'One');
    const secondId = store.open({ kind: 'local' }, 'Two');
    useTabsStore.getState().setPinned(pinnedSourceId, true);
    useTabsStore.getState().setPinned(pinnedNeighborId, true);
    const tabs = useTabsStore.getState().tabs;

    expect(closableTabIdsToRight(tabs, pinnedSourceId)).toEqual([firstId, secondId]);
    expect(closableTabIdsToRight(tabs, firstId)).toEqual([secondId]);
    expect(closableTabIdsToRight(tabs, secondId)).toEqual([]);
    expect(closableTabIdsToRight(tabs, 'missing')).toEqual([]);
  });

  it('keeps a pinned tab ahead of unpinned tabs when moving it to another pane', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Stay');
    const pinnedId = store.open({ kind: 'local' }, 'Pinned');
    useTabsStore.getState().setPinned(pinnedId, true);
    const rightPane = useTabsStore.getState().split('pane-test', 'right')!;
    const firstRightId = useTabsStore.getState().open({ kind: 'ssh', target: 'one' }, 'One');
    const secondRightId = useTabsStore.getState().open({ kind: 'ssh', target: 'two' }, 'Two');
    useTabsStore.getState().activate(pinnedId);

    expect(useTabsStore.getState().moveTabToDirection('right')).toBe(true);
    expect(
      useTabsStore.getState().tabs
        .filter((tab) => tab.paneId === rightPane)
        .map((tab) => [tab.id, !!tab.pinned]),
    ).toEqual([
      [pinnedId, true],
      [firstRightId, false],
      [secondRightId, false],
    ]);
  });

  it('activates tabs by their window-wide pane and strip order', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'Left one');
    store.open({ kind: 'local' }, 'Left two');
    const rightPane = store.split('pane-test', 'right')!;
    const thirdId = useTabsStore.getState().open({ kind: 'local' }, 'Right one');
    useTabsStore.getState().open({ kind: 'local' }, 'Right two');

    expect(useTabsStore.getState().activateTabIndex(0)).toBe(true);
    expect(useTabsStore.getState()).toMatchObject({ activePaneId: 'pane-test', activeId: firstId });
    expect(useTabsStore.getState().activateTabIndex(2)).toBe(true);
    expect(useTabsStore.getState()).toMatchObject({ activePaneId: rightPane, activeId: thirdId });
    expect(useTabsStore.getState().activateTabIndex(4)).toBe(false);
  });
});

describe('pane zoom', () => {
  it('fills the canvas with one pane and restores it on the next press', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');
    const rightPane = store.split('pane-test', 'right')!;

    expect(useTabsStore.getState().toggleZoom()).toBe(true);
    expect(useTabsStore.getState().zoomedPaneId).toBe(rightPane);
    expect(useTabsStore.getState().toggleZoom()).toBe(true);
    expect(useTabsStore.getState().zoomedPaneId).toBeNull();
  });

  it('does not zoom a canvas that has a single pane', () => {
    expect(useTabsStore.getState().toggleZoom()).toBe(false);
    expect(useTabsStore.getState().zoomedPaneId).toBeNull();
  });

  it('drops the zoom as soon as another pane takes focus', () => {
    const store = useTabsStore.getState();
    store.split('pane-test', 'right');
    useTabsStore.getState().toggleZoom();

    useTabsStore.getState().focusPane('pane-test');
    expect(useTabsStore.getState().zoomedPaneId).toBeNull();
  });

  it('drops the zoom when the zoomed pane closes', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');
    const rightPane = store.split('pane-test', 'right')!;
    useTabsStore.getState().toggleZoom();

    useTabsStore.getState().closePane(rightPane);
    expect(useTabsStore.getState()).toMatchObject({
      zoomedPaneId: null,
      activePaneId: 'pane-test',
    });
  });
});

describe('pane and tab symbiosis', () => {
  it('closes the pane along with its last tab', () => {
    const store = useTabsStore.getState();
    const keptId = store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'right');
    const closingId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');

    useTabsStore.getState().close(closingId);

    expect(useTabsStore.getState()).toMatchObject({
      root: { id: 'pane-test', type: 'pane' },
      activePaneId: 'pane-test',
      activeId: keptId,
    });
  });

  it('keeps the canvas when the last tab of the only pane closes', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'local' }, 'Local');

    useTabsStore.getState().close(id);

    expect(useTabsStore.getState()).toMatchObject({
      root: { id: 'pane-test', type: 'pane', activeTabId: null },
      tabs: [],
      activeId: null,
    });
  });

  it('resizes the focused pane inside its own split and evens panes out again', () => {
    const store = useTabsStore.getState();
    store.split('pane-test', 'right');
    useTabsStore.getState().focusPane('pane-test');

    expect(useTabsStore.getState().resizeActivePane(0.1)).toBe(true);
    expect(useTabsStore.getState().root).toMatchObject({ ratio: 0.6 });

    // The second child grows in the other direction.
    expect(useTabsStore.getState().cyclePane(false)).toBe(true);
    expect(useTabsStore.getState().resizeActivePane(0.1)).toBe(true);
    expect(useTabsStore.getState().root).toMatchObject({ ratio: 0.5 });

    useTabsStore.getState().resizeActivePane(0.2);
    expect(useTabsStore.getState().equalizePanes()).toBe(true);
    expect(useTabsStore.getState().root).toMatchObject({ ratio: 0.5 });
  });
});

describe('arranging open tabs', () => {
  /**
   * Tabs 1 and 2 on the left, tab 3 on the right above an empty pane. They are
   * opened in the order 1, 3, 2, and tab 2 has the focus.
   */
  const openSplitLayout = () => {
    const store = useTabsStore.getState();
    const first = store.open({ kind: 'local' }, 'First');
    const rightPane = store.split('pane-test', 'right')!;
    const third = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Third');
    useTabsStore.getState().split(rightPane, 'down');
    useTabsStore.getState().focusPane('pane-test');
    const second = useTabsStore.getState().open({ kind: 'local' }, 'Second');
    return [first, second, third];
  };
  const withoutPane = (tabs: readonly TerminalTab[]) =>
    tabs.map(({ paneId: _paneId, ...tab }) => tab);

  it.each([
    ['rows', 'vertical', 'height', 'width'],
    ['columns', 'horizontal', 'width', 'height'],
  ] as const)('tiles %s: an equal pane for each tab, in tab order', (layout, direction, shared, full) => {
    const ids = openSplitLayout();

    expect(useTabsStore.getState().arrangeTabs(layout)).toBe(true);

    const state = useTabsStore.getState();
    const { panes, dividers } = flattenPaneLayout(state.root);
    expect(panes.map(({ pane }) => pane.activeTabId)).toEqual(ids);
    for (const { pane, rect } of panes) {
      expect(state.tabs.filter((tab) => tab.paneId === pane.id).map((tab) => tab.id)).toEqual([
        pane.activeTabId,
      ]);
      expect(rect[shared]).toBeCloseTo(1 / 3);
      expect(rect[full]).toBe(1);
    }
    expect(dividers.map((divider) => divider.direction)).toEqual([direction, direction]);
    expect(state).toMatchObject({
      activePaneId: panes[1]!.pane.id,
      activeId: ids[1],
      zoomedPaneId: null,
    });
  });

  /** Tab count, then the column sizes tiled as columns (vertically) and as rows (horizontally). */
  const grids: Array<[number, number[], number[]]> = [
    [2, [1, 1], [2]],
    [3, [1, 1, 1], [3]],
    [4, [2, 2], [2, 2]],
    [5, [2, 3], [2, 3]],
    [6, [2, 2, 2], [3, 3]],
    [7, [2, 2, 3], [3, 4]],
    [8, [2, 2, 2, 2], [4, 4]],
    [9, [3, 3, 3], [3, 3, 3]],
    [10, [3, 3, 4], [3, 3, 4]],
    [11, [3, 4, 4], [3, 4, 4]],
    [12, [3, 3, 3, 3], [4, 4, 4]],
  ];

  it.each(
    grids.flatMap(([count, columns, rows]) => [
      ['columns', count, columns] as const,
      ['rows', count, rows] as const,
    ]),
  )('tiles %s of %i tabs as columns of %j, column by column', (layout, count, sizes) => {
    const ids = Array.from({ length: count }, (_, index) =>
      useTabsStore.getState().open({ kind: 'local' }, `Tab ${index + 1}`),
    );

    expect(useTabsStore.getState().arrangeTabs(layout)).toBe(true);

    const { root, tabs } = useTabsStore.getState();
    const expected = sizes.flatMap((size, column) =>
      Array.from({ length: size }, (_, row) => ({
        x: column / sizes.length,
        y: row / size,
        width: 1 / sizes.length,
        height: 1 / size,
      })),
    );
    const { panes } = flattenPaneLayout(root);
    expect(panes.map(({ pane }) => pane.activeTabId)).toEqual(ids);
    panes.forEach(({ rect }, index) => {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(rect[key], `tab ${index + 1} ${key}`).toBeCloseTo(expected[index]![key]);
      }
    });
    expect(tabsInOrder(root, tabs).map((tab) => tab.id)).toEqual(ids);
    expect(useTabsStore.getState().arrangeTabs(layout)).toBe(false);
  });

  /** Panes per column, left to right. */
  const columnSizes = () => {
    const sizes = new Map<number, number>();
    for (const { rect } of flattenPaneLayout(useTabsStore.getState().root).panes) {
      sizes.set(rect.x, (sizes.get(rect.x) ?? 0) + 1);
    }
    return [...sizes.values()];
  };
  const openTabs = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      useTabsStore.getState().open({ kind: 'local' }, `Tab ${index + 1}`),
    );

  it.each(['columns', 'rows'] as const)(
    'keeps tiling %s as sessions open, each one last and the grid laid out by the same rule',
    (layout) => {
      const ids = openTabs(1);
      expect(useTabsStore.getState().arrangeTabs(layout)).toBe(true);
      for (const [count, columns, rows] of grids) {
        ids.push(useTabsStore.getState().open({ kind: 'local' }, `Tab ${count}`));
        const state = useTabsStore.getState();
        expect(columnSizes(), `${count} tabs`).toEqual(layout === 'columns' ? columns : rows);
        expect(tabsInOrder(state.root, state.tabs).map((tab) => tab.id)).toEqual(ids);
        expect(state.tabs.map((tab) => tab.id)).toEqual(ids);
        expect(state).toMatchObject({ activeId: ids.at(-1), tiling: layout });
      }
    },
  );

  it('puts a new session last even while an earlier tile has the focus', () => {
    const ids = openTabs(3);
    useTabsStore.getState().arrangeTabs('rows');
    useTabsStore.getState().activate(ids[0]!);

    const laterId = useTabsStore.getState().open({ kind: 'local' }, 'Later');

    const { root, tabs, activeId } = useTabsStore.getState();
    expect(tabsInOrder(root, tabs).map((tab) => tab.id)).toEqual([...ids, laterId]);
    expect(activeId).toBe(laterId);
  });

  it('closes the grid up by the same rule when a tab or its pane closes', () => {
    const ids = openTabs(7);
    useTabsStore.getState().arrangeTabs('columns');
    expect(columnSizes()).toEqual([2, 2, 3]);

    useTabsStore.getState().close(ids[2]!);
    expect(columnSizes()).toEqual([2, 2, 2]);
    useTabsStore.getState().closePane(useTabsStore.getState().tabs[0]!.paneId);
    expect(columnSizes()).toEqual([2, 3]);

    const { root, tabs, tiling } = useTabsStore.getState();
    expect(tabsInOrder(root, tabs).map((tab) => tab.id)).toEqual([ids[1], ...ids.slice(3)]);
    expect(tiling).toBe('columns');
  });

  it('gives the host monitor and a new tab a tile of their own while tiling', () => {
    openTabs(1);
    useTabsStore.getState().arrangeTabs('columns');
    const monitorId = useTabsStore.getState().openMonitor();
    const emptyId = useTabsStore.getState().openEmpty();

    expect(columnSizes()).toEqual([1, 1, 1]);
    const { root, tabs } = useTabsStore.getState();
    expect(tabsInOrder(root, tabs).slice(1).map((tab) => tab.id)).toEqual([monitorId, emptyId]);
  });

  it("ends tiling when a pane's own + adds a tab there, which keeps the layout", () => {
    const ids = openTabs(3);
    useTabsStore.getState().arrangeTabs('columns');
    const firstPaneId = useTabsStore.getState().tabs.find((tab) => tab.id === ids[0])!.paneId;

    const addedId = openEmptyTab(firstPaneId);
    useTabsStore.getState().open({ kind: 'local' }, 'Later');

    const state = useTabsStore.getState();
    expect(state.tiling).toBeNull();
    expect(columnSizes()).toEqual([1, 1, 1]);
    expect(state.tabs.filter((tab) => tab.paneId === firstPaneId).map((tab) => tab.id)).toEqual([
      ids[0],
      addedId,
      state.activeId,
    ]);
  });

  it('keeps tiling when a divider is let go where it was', () => {
    openTabs(3);
    useTabsStore.getState().arrangeTabs('columns');
    const root = useTabsStore.getState().root as SplitNode;

    useTabsStore.getState().resizeSplit(root.id, root.ratio);

    expect(useTabsStore.getState()).toMatchObject({ root, tiling: 'columns' });
  });

  it('keeps tiling when growing a pane changes nothing, at its limit', () => {
    openTabs(1);
    useTabsStore.getState().split('pane-test', 'right');
    useTabsStore.getState().focusPane('pane-test');
    useTabsStore.getState().resizeActivePane(0.5);
    useTabsStore.getState().arrangeTabs('rows');
    const root = useTabsStore.getState().root;
    expect(root).toMatchObject({ ratio: 0.9 });

    expect(useTabsStore.getState().resizeActivePane(0.04)).toBe(true);

    expect(useTabsStore.getState()).toMatchObject({ root, tiling: 'rows' });
  });

  it('drops a zoom on another tile when a view takes the focus in the last one', () => {
    const [firstId] = openTabs(2);
    useTabsStore.getState().arrangeTabs('columns');
    useTabsStore.getState().openEmpty();
    useTabsStore.getState().activate(firstId!);
    expect(useTabsStore.getState().toggleZoom()).toBe(true);

    const monitorId = useTabsStore.getState().openMonitor();

    expect(useTabsStore.getState()).toMatchObject({
      activeId: monitorId,
      zoomedPaneId: null,
      tiling: 'columns',
    });
    expect(columnSizes()).toEqual([1, 1, 1]);
  });

  it('keeps a zoom when a session opens or closes without changing the grid', () => {
    openTabs(2);
    useTabsStore.getState().openEmpty();
    useTabsStore.getState().arrangeTabs('columns');
    expect(useTabsStore.getState().toggleZoom()).toBe(true);
    const zoomedPaneId = useTabsStore.getState().zoomedPaneId;

    // The host monitor takes the untouched new tab's place.
    useTabsStore.getState().openMonitor();
    useTabsStore.getState().close('missing-tab');

    expect(useTabsStore.getState()).toMatchObject({ zoomedPaneId, tiling: 'columns' });
    expect(columnSizes()).toEqual([1, 1, 1]);
  });

  it.each<[string, () => unknown]>([
    ['a split', () => useTabsStore.getState().split(useTabsStore.getState().activePaneId, 'down')],
    [
      'a tab moved to another pane',
      () => {
        const [first, second] = useTabsStore.getState().tabs;
        useTabsStore.getState().moveTabToPane(first!.id, second!.paneId);
      },
    ],
    ['a dragged divider', () => useTabsStore.getState().resizeSplit(useTabsStore.getState().root.id, 0.3)],
    ['a grown pane', () => useTabsStore.getState().resizeActivePane(0.1)],
    ['evened-out panes', () => useTabsStore.getState().equalizePanes()],
    [
      'a host group launch',
      () => useTabsStore.getState().launchSet([{ profile: { kind: 'local' }, title: 'Set' }], 'tabs'),
    ],
  ])('ends tiling on %s', (_edit, edit) => {
    openTabs(3);
    useTabsStore.getState().arrangeTabs('columns');

    edit();

    expect(useTabsStore.getState().tiling).toBeNull();
  });

  it('keeps tiling through a zoom, which the next session drops', () => {
    openTabs(3);
    useTabsStore.getState().arrangeTabs('columns');
    expect(useTabsStore.getState().toggleZoom()).toBe(true);
    expect(useTabsStore.getState().tiling).toBe('columns');

    useTabsStore.getState().open({ kind: 'local' }, 'Tab 4');

    expect(useTabsStore.getState()).toMatchObject({ zoomedPaneId: null, tiling: 'columns' });
    expect(columnSizes()).toEqual([2, 2]);
  });

  it('puts new sessions in the focused pane again after Tabs', () => {
    openTabs(3);
    useTabsStore.getState().arrangeTabs('rows');
    useTabsStore.getState().arrangeTabs('tabs');
    useTabsStore.getState().open({ kind: 'local' }, 'Tab 4');

    const state = useTabsStore.getState();
    expect(state.root.type).toBe('pane');
    expect(state.tabs.every((tab) => tab.paneId === state.root.id)).toBe(true);
    expect(state.tiling).toBeNull();
  });

  it('lays four tabs out as the same two-by-two grid either way, switching only the mode', () => {
    for (let index = 0; index < 4; index++) {
      useTabsStore.getState().open({ kind: 'local' }, `Tab ${index + 1}`);
    }

    expect(useTabsStore.getState().arrangeTabs('rows')).toBe(true);
    const grid = useTabsStore.getState().root;
    expect(useTabsStore.getState().arrangeTabs('columns')).toBe(true);
    expect(useTabsStore.getState()).toMatchObject({ root: grid, tiling: 'columns' });
    expect(useTabsStore.getState().arrangeTabs('columns')).toBe(false);
  });

  it('moves tabs between panes only: same tabs, sessions, numbers and array slots', () => {
    const ids = openSplitLayout();
    const before = useTabsStore.getState().tabs;

    useTabsStore.getState().arrangeTabs('rows');

    const { root, tabs } = useTabsStore.getState();
    expect(withoutPane(tabs)).toEqual(withoutPane(before));
    expect(tabsInOrder(root, tabs).map((tab) => tab.id)).toEqual(ids);
    // The first tab of a pane stays where it was.
    expect(tabs[0]).toBe(before[0]);
  });

  it('gathers every tab into the focused pane, in tab order', () => {
    const ids = openSplitLayout();
    useTabsStore.getState().arrangeTabs('columns');
    const focusedPaneId = useTabsStore.getState().activePaneId;
    const tiled = useTabsStore.getState().tabs;

    expect(useTabsStore.getState().arrangeTabs('tabs')).toBe(true);

    const state = useTabsStore.getState();
    expect(state.root).toEqual({ id: focusedPaneId, type: 'pane', activeTabId: ids[1] });
    expect(state.tabs.map((tab) => [tab.id, tab.paneId])).toEqual(
      ids.map((id) => [id, focusedPaneId]),
    );
    expect(withoutPane(state.tabs)).toEqual(
      withoutPane(ids.map((id) => tiled.find((tab) => tab.id === id)!)),
    );
    expect(state).toMatchObject({ activePaneId: focusedPaneId, activeId: ids[1] });
  });

  it('arranges the host monitor, the hosts tab and a new tab like any other tab', () => {
    const sessionId = useTabsStore.getState().open({ kind: 'local' }, 'Local');
    const monitorId = useTabsStore.getState().openMonitor();
    const hostsId = useTabsStore.getState().openHosts();
    const emptyId = useTabsStore.getState().openEmpty();
    const ids = [sessionId, monitorId, hostsId, emptyId];
    const before = useTabsStore.getState().tabs;

    expect(useTabsStore.getState().arrangeTabs('columns')).toBe(true);
    expect(panesInOrder(useTabsStore.getState().root).map((pane) => pane.activeTabId)).toEqual(ids);
    expect(useTabsStore.getState().activeId).toBe(emptyId);

    expect(useTabsStore.getState().arrangeTabs('tabs')).toBe(true);
    expect(withoutPane(useTabsStore.getState().tabs)).toEqual(withoutPane(before));
    expect(isEmptyTab(useTabsStore.getState().tabs[3]!)).toBe(true);
  });

  it('keeps pinned tabs at the head of the gathered strip', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'First');
    store.split('pane-test', 'right');
    const pinnedId = useTabsStore.getState().open({ kind: 'local' }, 'Pinned');
    useTabsStore.getState().setPinned(pinnedId, true);

    expect(useTabsStore.getState().arrangeTabs('tabs')).toBe(true);
    expect(useTabsStore.getState().tabs.map((tab) => [tab.id, !!tab.pinned])).toEqual([
      [pinnedId, true],
      [firstId, false],
    ]);
  });

  it('with a single tab, only turns the mode on or off', () => {
    useTabsStore.getState().open({ kind: 'local' }, 'Only');
    useTabsStore.getState().split('pane-test', 'down');
    const root = useTabsStore.getState().root;

    expect(useTabsStore.getState().arrangeTabs('tabs')).toBe(false);
    expect(useTabsStore.getState().arrangeTabs('rows')).toBe(true);
    expect(useTabsStore.getState().arrangeTabs('rows')).toBe(false);
    expect(useTabsStore.getState().arrangeTabs('tabs')).toBe(true);
    expect(useTabsStore.getState()).toMatchObject({ root, tiling: null });
  });

  it('declines when the tabs are already laid out that way', () => {
    useTabsStore.getState().open({ kind: 'local' }, 'First');
    const secondId = useTabsStore.getState().open({ kind: 'local' }, 'Second');
    expect(useTabsStore.getState().arrangeTabs('tabs')).toBe(false);

    // Two tabs stacked by hand already have the layout: only the mode turns on.
    expect(useTabsStore.getState().moveTabToNewPane(secondId, 'down')).toBe(true);
    const stacked = useTabsStore.getState().root;
    expect(useTabsStore.getState().arrangeTabs('rows')).toBe(true);
    expect(useTabsStore.getState().root).toBe(stacked);
    expect(useTabsStore.getState().arrangeTabs('rows')).toBe(false);

    expect(useTabsStore.getState().arrangeTabs('columns')).toBe(true);
    const tiled = useTabsStore.getState().root;
    expect(useTabsStore.getState().arrangeTabs('columns')).toBe(false);
    expect(useTabsStore.getState().root).toBe(tiled);

    // A dragged divider ends tiling; tiling again evens the panes out.
    useTabsStore.getState().resizeSplit(tiled.id, 0.3);
    expect(useTabsStore.getState().tiling).toBeNull();
    expect(useTabsStore.getState().arrangeTabs('columns')).toBe(true);
    expect(useTabsStore.getState().root).toMatchObject({ direction: 'horizontal', ratio: 0.5 });
    expect(useTabsStore.getState().activeId).toBe(secondId);
  });

  it('drops a zoom, even on tabs that are already tiled', () => {
    openSplitLayout();
    useTabsStore.getState().toggleZoom();

    expect(useTabsStore.getState().arrangeTabs('rows')).toBe(true);
    expect(useTabsStore.getState().zoomedPaneId).toBeNull();

    useTabsStore.getState().toggleZoom();
    expect(useTabsStore.getState().arrangeTabs('rows')).toBe(true);
    expect(useTabsStore.getState().zoomedPaneId).toBeNull();
  });

  it('clears the unread mark of a tab it brings into view', () => {
    const [firstId] = openSplitLayout();
    useTabsStore.getState().notifyOutput(firstId!);
    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set([firstId]));

    useTabsStore.getState().arrangeTabs('columns');

    expect(useTabsStore.getState().unreadOutputIds).toEqual(new Set());
  });

  it('saves a tiled layout and restores it as it was, still tiling', () => {
    const ids = openSplitLayout();
    useTabsStore.getState().arrangeTabs('rows');
    const { root, tabs, activePaneId, tiling } = useTabsStore.getState();
    const layout = serializeWorkspace(
      root,
      tabs.filter((tab): tab is SessionTab => tab.profile !== null),
      activePaneId,
      tiling,
    );
    useTabsStore.getState().stopTiling();

    useTabsStore.getState().restore(layout);

    const restored = useTabsStore.getState();
    expect(restored.root).toEqual(root);
    expect(tabsInOrder(restored.root, restored.tabs).map((tab) => tab.id)).toEqual(ids);
    expect(restored).toMatchObject({ activePaneId, activeId: ids[1], tiling: 'rows' });
  });
});

describe('lost connections', () => {
  it('counts a dropped connection, not an ended shell, a reconnect or a closed tab', () => {
    const id = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
    const { update } = useTabsStore.getState();
    const lost = () => tabLostConnection(useTabsStore.getState().tabs, id);

    update(id, { status: 'connected', connId: 'conn-1' });
    expect(lost()).toBe(false);

    // Updated as the terminal does when the transport drops.
    update(id, { status: 'interrupted', connId: undefined, disconnectReason: 'disconnected' });
    expect(lost()).toBe(true);
    update(id, { status: 'closed', disconnectReason: 'failed' });
    expect(lost()).toBe(true);

    update(id, { disconnectReason: 'completed' });
    expect(lost()).toBe(false);

    update(id, { disconnectReason: 'disconnected' });
    useTabsStore.getState().reconnect([id]);
    expect(lost()).toBe(false);

    useTabsStore.getState().close(id);
    expect(lost()).toBe(false);
  });
});

describe('the host monitor tab', () => {
  it('opens once per window: asking again goes to the tab that is there', () => {
    const first = useTabsStore.getState().openMonitor();
    const sessionId = useTabsStore.getState().open({ kind: 'local' }, 'Shell');
    expect(useTabsStore.getState().activeId).toBe(sessionId);

    const second = useTabsStore.getState().openMonitor();

    expect(second).toBe(first);
    const state = useTabsStore.getState();
    expect(state.tabs.filter((tab) => tab.view === 'monitor')).toHaveLength(1);
    expect(state.activeId).toBe(first);
    expect(state.tabs[0]).toMatchObject({ title: 'Host monitor', profile: null, status: 'idle', view: 'monitor' });
  });

  it('opens the hosts as a tab of their own, once per window, beside the monitor', () => {
    const monitorId = useTabsStore.getState().openMonitor();
    const hostsId = useTabsStore.getState().openHosts();
    expect(hostsId).not.toBe(monitorId);
    useTabsStore.getState().activate(monitorId);

    expect(useTabsStore.getState().openHosts()).toBe(hostsId);

    const state = useTabsStore.getState();
    expect(state.activeId).toBe(hostsId);
    expect(state.tabs.map((tab) => tab.view)).toEqual(['monitor', 'hosts']);
    expect(state.tabs[1]).toMatchObject({ title: 'Hosts', profile: null, status: 'idle' });
    expect(isEmptyTab(state.tabs[1]!)).toBe(false);
  });

  it('takes the place of an untouched new tab in front', () => {
    const emptyId = useTabsStore.getState().openEmpty();
    const monitorId = useTabsStore.getState().openMonitor();
    const state = useTabsStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual([monitorId]);
    expect(state.tabs.some((tab) => tab.id === emptyId)).toBe(false);
    expect(findPane(state.root, 'pane-test')?.activeTabId).toBe(monitorId);
  });

  it('is not a tab still choosing its session: a host opened next gets a tab of its own', () => {
    const monitorId = useTabsStore.getState().openMonitor();
    expect(isEmptyTab(useTabsStore.getState().tabs[0]!)).toBe(false);
    expect(useTabsStore.getState().replaceEmpty(monitorId, { kind: 'local' }, 'Shell')).toBe(false);

    const sessionId = openSessionProfile({ kind: 'ssh', target: 'web-01' }, 'web-01');

    const state = useTabsStore.getState();
    expect(sessionId).not.toBe(monitorId);
    expect(state.tabs.map((tab) => tab.view ?? tab.profile?.kind)).toEqual(['monitor', 'ssh']);
  });

  it('comes back from a saved layout as a monitor, not as a session', () => {
    useTabsStore.getState().restore({
      version: 1,
      activePaneId: 'pane',
      root: {
        id: 'pane',
        type: 'pane',
        activeTabId: 'monitor-tab',
        tabs: [
          { id: 'monitor-tab', kind: 'monitor', title: 'Host monitor', pinned: true },
          {
            id: 'ssh-tab',
            kind: 'terminal',
            title: 'web-01',
            profile: { kind: 'ssh', target: 'web-01' },
            offerReconnect: true,
          },
        ],
      },
    });
    const state = useTabsStore.getState();
    expect(state.activeId).toBe('monitor-tab');
    expect(state.tabs[0]).toMatchObject({ id: 'monitor-tab', view: 'monitor', profile: null, status: 'idle', pinned: true });
    expect(state.tabs[1]).toMatchObject({ id: 'ssh-tab', status: 'closed', restored: true });
    // Asking for the monitor afterwards finds the restored one.
    expect(state.openMonitor()).toBe('monitor-tab');
  });
});
