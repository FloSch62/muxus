import { beforeEach, describe, expect, it } from 'vitest';
import {
  requestClosePane,
  splitActivePane,
} from '../../../client/src/session-actions.js';
import {
  managedHostSupportsSftp,
  openManagedHostSftp,
} from '../../../client/src/components/sidebar/host-sftp-action.js';
import { useDialogStore } from '../../../client/src/state/dialogs.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { findPane } from '../../../client/src/state/workspace-layout.js';

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
  });
  usePrefsStore.setState({ confirmCloseConnected: true, splitInheritsSession: true });
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

  it('connects with the file browser ready to open', () => {
    const id = openManagedHostSftp(host);

    expect(useTabsStore.getState()).toMatchObject({
      activeId: id,
      tabs: [
        {
          id,
          profile: { kind: 'ssh', target: 'router' },
          status: 'connecting',
          sftpOpen: true,
        },
      ],
    });
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
      tabs: [
        { id: existingId, sftpOpen: true },
        { profile: { kind: 'local' } },
      ],
    });
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

  it('activates tabs by position within the focused pane', () => {
    const store = useTabsStore.getState();
    const firstId = store.open({ kind: 'local' }, 'One');
    store.open({ kind: 'local' }, 'Two');
    const thirdId = store.open({ kind: 'local' }, 'Three');

    expect(useTabsStore.getState().activateTabIndex(0)).toBe(true);
    expect(useTabsStore.getState().activeId).toBe(firstId);
    expect(useTabsStore.getState().activateTabIndex('last')).toBe(true);
    expect(useTabsStore.getState().activeId).toBe(thirdId);
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
