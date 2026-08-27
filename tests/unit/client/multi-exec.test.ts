import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toggleMultiExec } from '../../../client/src/session-actions.js';
import {
  broadcastTerminalInput,
  multiExecPaneIds,
  useMultiExecStore,
} from '../../../client/src/state/multi-exec.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useToastStore } from '../../../client/src/state/toast.js';
import {
  registerTerminal,
  type TerminalHandle,
} from '../../../client/src/terminal/terminal-registry.js';

function handle(sendInput: TerminalHandle['sendInput']): TerminalHandle {
  return {
    focus: vi.fn(),
    cursorAnchorPosition: () => undefined,
    sendInput,
    clear: vi.fn(),
    selectAll: vi.fn(),
    hasSelection: () => false,
    getSelection: () => '',
    bufferText: () => '',
    bufferHtml: () => '',
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    zoomPercent: () => 100,
    paste: vi.fn(),
    pasteClipboard: vi.fn(),
    setLogging: vi.fn(() => true),
    persistSnapshot: vi.fn(async () => undefined),
    prepareTransfer: vi.fn(async () => true),
    cancelTransfer: vi.fn(),
  };
}

beforeEach(() => {
  useMultiExecStore.setState({ selectedIds: [], lastMirroredIds: [], groups: [] });
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
  });
  useToastStore.setState({ toast: null });
});

/** A connected session in the focused pane. */
function connectTab(title: string): string {
  const id = useTabsStore.getState().open({ kind: 'local' }, title);
  useTabsStore.getState().update(id, { status: 'connected' });
  return id;
}

describe('multi-execution routing', () => {
  it('identifies panes whose visible tabs participate in active mirrored input', () => {
    const panes = [
      { id: 'pane-left', activeTabId: 'tab-a' },
      { id: 'pane-right', activeTabId: 'tab-b' },
    ];

    expect([...multiExecPaneIds(panes, ['tab-a'])]).toEqual([]);
    expect([...multiExecPaneIds(panes, ['tab-a', 'tab-c'])]).toEqual(['pane-left']);
    expect([...multiExecPaneIds(panes, ['tab-a', 'tab-b'])]).toEqual(['pane-left', 'pane-right']);
  });

  it('mirrors source input only to the other selected terminals', () => {
    const sends = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)];
    const unregister = [
      registerTerminal('tab-a', handle(sends[0]!)),
      registerTerminal('tab-b', handle(sends[1]!)),
      registerTerminal('tab-c', handle(sends[2]!)),
    ];
    useMultiExecStore.getState().setSelection(['tab-a', 'tab-b']);

    expect(broadcastTerminalInput('tab-a', 'ls')).toBe(1);
    expect(sends[0]).not.toHaveBeenCalled();
    expect(sends[1]).toHaveBeenCalledWith('ls');
    expect(sends[2]).not.toHaveBeenCalled();
    unregister.forEach((dispose) => dispose());
  });

  it('mirrors complete commands typed into a selected terminal', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregister = [
      registerTerminal('tab-a', handle(first)),
      registerTerminal('tab-b', handle(second)),
    ];
    useMultiExecStore.getState().setSelection(['tab-a', 'tab-b']);

    expect(broadcastTerminalInput('tab-a', 'uptime\r')).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('uptime\r');
    unregister.forEach((dispose) => dispose());
  });

  it('drops disconnected targets from the selection', () => {
    useMultiExecStore.getState().setSelection(['tab-a', 'tab-b']);
    useMultiExecStore.getState().reconcile(['tab-a']);
    expect(useMultiExecStore.getState()).toMatchObject({
      selectedIds: ['tab-a'],
    });
  });

  it('switches mirroring off and back on over the same terminals', () => {
    const multiExec = () => useMultiExecStore.getState();
    multiExec().setSelection(['tab-a', 'tab-b']);

    expect(multiExec().toggleMirroring(['tab-a', 'tab-b'], [])).toBe(true);
    expect(multiExec().selectedIds).toEqual([]);
    expect(multiExec().toggleMirroring(['tab-a', 'tab-b'], [])).toBe(true);
    expect(multiExec().selectedIds).toEqual(['tab-a', 'tab-b']);
  });

  it('resumes only the terminals still live, else the ones on screen', () => {
    const multiExec = () => useMultiExecStore.getState();
    multiExec().setSelection(['tab-a', 'tab-b']);
    multiExec().toggleMirroring(['tab-a', 'tab-b'], []);

    // "tab-b" went away while mirroring was off, leaving too little to resume.
    multiExec().toggleMirroring(['tab-a', 'tab-c', 'tab-d'], ['tab-c', 'tab-d', 'tab-gone']);
    expect(multiExec().selectedIds).toEqual(['tab-c', 'tab-d']);
  });

  it('declines to mirror when fewer than two terminals are available', () => {
    const multiExec = () => useMultiExecStore.getState();
    multiExec().setSelection(['tab-a', 'tab-b']);
    multiExec().toggleMirroring(['tab-a', 'tab-b'], []);

    expect(multiExec().toggleMirroring(['tab-a'], ['tab-a'])).toBe(false);
    expect(multiExec().selectedIds).toEqual([]);
  });

  it('mirrors the sessions on screen the first time the shortcut is pressed', () => {
    const first = connectTab('edge-1');
    useTabsStore.getState().split(useTabsStore.getState().activePaneId, 'right');
    const second = connectTab('edge-2');

    expect(toggleMultiExec()).toBe(true);
    expect(useMultiExecStore.getState().selectedIds).toEqual([first, second]);

    expect(toggleMultiExec()).toBe(true);
    expect(useMultiExecStore.getState().selectedIds).toEqual([]);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('leaves the panes hidden behind a zoomed one out of the shortcut', () => {
    connectTab('edge-1');
    useTabsStore.getState().split(useTabsStore.getState().activePaneId, 'right');
    connectTab('edge-2');
    // A zoomed pane covers the canvas, so the other session is off screen and
    // must not receive a command typed into the one that is visible.
    expect(useTabsStore.getState().toggleZoom()).toBe(true);

    expect(toggleMultiExec()).toBe(true);
    expect(useMultiExecStore.getState().selectedIds).toEqual([]);
    expect(useToastStore.getState().toast).toMatchObject({ severity: 'info' });
  });

  it('says why the shortcut did nothing when there is nothing to mirror', () => {
    connectTab('edge-1');

    expect(toggleMultiExec()).toBe(true);
    expect(useMultiExecStore.getState().selectedIds).toEqual([]);
    expect(useToastStore.getState().toast).toMatchObject({
      severity: 'info',
      message: expect.stringContaining('two sessions'),
    });
  });

  it('saves and activates named workspace groups', () => {
    useMultiExecStore.getState().setSelection(['tab-a', 'tab-b']);
    const id = useMultiExecStore.getState().saveGroup('Routers');

    expect(useMultiExecStore.getState().groups).toEqual([
      { id, name: 'Routers', tabIds: ['tab-a', 'tab-b'] },
    ]);

    useMultiExecStore.getState().setSelection([]);
    useMultiExecStore.getState().activateGroup(id!, ['tab-b', 'tab-c']);
    expect(useMultiExecStore.getState().selectedIds).toEqual(['tab-b']);
  });
});
