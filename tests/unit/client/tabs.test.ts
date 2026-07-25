import { beforeEach, describe, expect, it } from 'vitest';
import {
  requestClosePane,
  splitActivePane,
} from '../../../client/src/session-actions.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useUiStore } from '../../../client/src/state/ui.js';

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
  });
  usePrefsStore.setState({ confirmCloseConnected: true, splitInheritsSession: true });
  useUiStore.setState({ confirmClose: null });
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
      }),
      expect.objectContaining({
        id: 'ssh-tab',
        status: 'closed',
        connectOnMount: false,
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

  it('gates a pane containing live tabs behind the close confirmation', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'right');
    const closingPaneId = useTabsStore.getState().activePaneId;
    const closingTabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().update(closingTabId, { status: 'connected' });

    requestClosePane(closingPaneId);

    expect(useUiStore.getState().confirmClose).toEqual({
      tabIds: [closingTabId],
      paneId: closingPaneId,
    });
    expect(useTabsStore.getState().root.type).toBe('split');
  });

  it('closes a live pane immediately when confirmation is disabled', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'right');
    const closingPaneId = useTabsStore.getState().activePaneId;
    const closingTabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().update(closingTabId, { status: 'connected' });
    usePrefsStore.setState({ confirmCloseConnected: false });

    requestClosePane(closingPaneId);

    expect(useUiStore.getState().confirmClose).toBeNull();
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
