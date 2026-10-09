import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionProfile } from '@muxus/shared';
import { keyCommand } from '../../../client/src/keymap/commands.js';
import { useMultiExecStore } from '../../../client/src/state/multi-exec.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { canSendBreak, supportsBreak } from '../../../client/src/terminal/send-break.js';
import {
  registerTerminal,
  type TerminalHandle,
} from '../../../client/src/terminal/terminal-registry.js';

const SSH: SessionProfile = { kind: 'ssh', target: 'console-server' };
const TELNET: SessionProfile = { kind: 'telnet', host: 'switch', port: 23 };
const SERIAL: SessionProfile = {
  kind: 'serial',
  path: '/dev/ttyUSB0',
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

beforeEach(() => {
  useMultiExecStore.setState({ selectedIds: [], lastMirroredIds: [], groups: [] });
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-break', type: 'pane', activeTabId: null },
    activePaneId: 'pane-break',
    activeId: null,
    zoomedPaneId: null,
  });
});

const tab = (id: string) => useTabsStore.getState().tabs.find((candidate) => candidate.id === id);

function openTab(profile: SessionProfile, status: 'connected' | 'connecting' = 'connected') {
  const id = useTabsStore.getState().open(profile, profile.kind);
  useTabsStore.getState().update(id, { status });
  const sendBreak = vi.fn(() => true);
  const unregister = registerTerminal(id, { sendBreak } as unknown as TerminalHandle);
  return { id, sendBreak, unregister };
}

describe('Send BREAK availability', () => {
  it('belongs to serial, Telnet and SSH tabs only', () => {
    for (const profile of [SSH, TELNET, SERIAL]) {
      const { id, unregister } = openTab(profile);
      expect(supportsBreak(tab(id)), profile.kind).toBe(true);
      unregister();
    }
    const others: SessionProfile[] = [
      { kind: 'local' },
      { kind: 'rdp', host: 'desktop', port: 3389 },
      { kind: 'vnc', host: 'desktop', port: 5900 },
    ];
    for (const profile of others) {
      const { id, unregister } = openTab(profile);
      expect(supportsBreak(tab(id)), profile.kind).toBe(false);
      expect(canSendBreak(tab(id)), profile.kind).toBe(false);
      unregister();
    }
    expect(supportsBreak(undefined)).toBe(false);
  });

  it('waits for the session, but not for a silent SSH console to print', () => {
    const { id, unregister } = openTab(SSH, 'connecting');
    expect(canSendBreak(tab(id))).toBe(false);
    useTabsStore.getState().update(id, { connId: 'connection-1' });
    expect(canSendBreak(tab(id))).toBe(true);
    useTabsStore.getState().update(id, { status: 'closed' });
    expect(canSendBreak(tab(id))).toBe(false);
    unregister();
  });
});

describe('the Send BREAK command', () => {
  const command = () => keyCommand('terminal.send-break')!;

  it('leaves the key to a local shell', () => {
    const { sendBreak, unregister } = openTab({ kind: 'local' });
    expect(command().run()).toBe(false);
    expect(sendBreak).not.toHaveBeenCalled();
    unregister();
  });

  it('sends BREAK to the active session only, even while multi-execution mirrors input', () => {
    const first = openTab(TELNET);
    const second = openTab(SERIAL);
    useMultiExecStore.getState().setSelection([first.id, second.id]);
    useTabsStore.getState().activate(first.id);

    expect(command().run()).toBe(true);
    expect(first.sendBreak).toHaveBeenCalledOnce();
    expect(second.sendBreak).not.toHaveBeenCalled();
    first.unregister();
    second.unregister();
  });
});
