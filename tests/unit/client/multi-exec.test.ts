import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastTerminalInput,
  useMultiExecStore,
} from '../../../client/src/state/multi-exec.js';
import {
  registerTerminal,
  type TerminalHandle,
} from '../../../client/src/terminal/terminal-registry.js';

function handle(sendInput: TerminalHandle['sendInput']): TerminalHandle {
  return {
    focus: vi.fn(),
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
    setLogging: vi.fn(() => true),
  };
}

beforeEach(() => {
  useMultiExecStore.setState({ selectedIds: [], groups: [] });
});

describe('multi-execution routing', () => {
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
