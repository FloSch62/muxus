import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PACED_PASTE_LENGTH, type SessionProfile } from '@muxus/shared';
import { keyCommand } from '../../../client/src/keymap/commands.js';
import { useMultiExecStore } from '../../../client/src/state/multi-exec.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useToastStore } from '../../../client/src/state/toast.js';
import {
  sendTextFile,
  textFileContent,
} from '../../../client/src/terminal/send-text-file.js';
import {
  registerTerminal,
  type TerminalHandle,
} from '../../../client/src/terminal/terminal-registry.js';

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
const CONFIG = 'hostname R1\r\ninterface Gi0/1\r\n description uplink\r\n';

const unregisters: Array<() => void> = [];

beforeEach(() => {
  useMultiExecStore.setState({ selectedIds: [], lastMirroredIds: [], groups: [] });
  useToastStore.setState({ toast: null });
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-file', type: 'pane', activeTabId: null },
    activePaneId: 'pane-file',
    activeId: null,
    zoomedPaneId: null,
  });
});

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  vi.unstubAllGlobals();
});

function openTab(profile: SessionProfile, status: 'connected' | 'connecting' = 'connected') {
  const id = useTabsStore.getState().open(profile, profile.kind);
  useTabsStore.getState().update(id, { status });
  const typeText = vi.fn((_text: string) => true);
  const focus = vi.fn();
  unregisters.push(registerTerminal(id, { typeText, focus } as unknown as TerminalHandle));
  return { id, typeText, focus };
}

const file = (content: BlobPart, name = 'R1.cfg') => new File([content], name);

describe('text file content', () => {
  it('decodes UTF-8, drops a BOM and leaves line breaks to the typing path', () => {
    const bytes = new TextEncoder().encode(`﻿${CONFIG}banner motd ^Ü^\r`);
    expect(textFileContent('R1.cfg', bytes)).toEqual({ text: `${CONFIG}banner motd ^Ü^\r` });
  });

  it('refuses NUL bytes and invalid UTF-8 as binary', () => {
    const problem = { problem: '“R1.cfg” is not a text file, or not in UTF-8.' };
    // A UTF-16 file, as Windows Notepad saves "Unicode".
    expect(textFileContent('R1.cfg', new Uint8Array([0xff, 0xfe, 0x68, 0x00]))).toEqual(problem);
    // Latin-1 "é".
    expect(textFileContent('R1.cfg', new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toEqual(problem);
  });
});

describe('sending a text file', () => {
  it('types it into the tab and the sessions mirroring it', async () => {
    const source = openTab(TELNET);
    const mirror = openTab(SERIAL);
    const elsewhere = openTab(TELNET);
    useMultiExecStore.getState().setSelection([source.id, mirror.id]);

    await expect(sendTextFile(source.id, file(CONFIG))).resolves.toBe(true);
    expect(source.typeText).toHaveBeenCalledExactlyOnceWith(CONFIG);
    expect(mirror.typeText).toHaveBeenCalledExactlyOnceWith(CONFIG);
    expect(elsewhere.typeText).not.toHaveBeenCalled();
    expect(source.focus).toHaveBeenCalled();
  });

  it('refuses a file over the paced-paste limit before typing anything', async () => {
    const { id, typeText } = openTab(TELNET);
    const big = file(new Uint8Array(MAX_PACED_PASTE_LENGTH + 1).fill(0x61));

    await expect(sendTextFile(id, big)).resolves.toBe(false);
    expect(typeText).not.toHaveBeenCalled();
    expect(useToastStore.getState().toast).toMatchObject({
      severity: 'error',
      message: '“R1.cfg” is larger than 1 MB. Send it in parts.',
    });
  });

  it('refuses a binary file before typing anything', async () => {
    const { id, typeText } = openTab(SERIAL);

    await expect(sendTextFile(id, file(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]), 'image.bin'))).resolves.toBe(false);
    expect(typeText).not.toHaveBeenCalled();
    expect(useToastStore.getState().toast).toMatchObject({ severity: 'error' });
  });

  it('says an empty file is empty, BOM or not, and types nothing', async () => {
    const { id, typeText } = openTab(TELNET);

    for (const content of ['', '﻿']) {
      useToastStore.setState({ toast: null });
      await expect(sendTextFile(id, file(content, 'empty.cfg'))).resolves.toBe(false);
      expect(useToastStore.getState().toast).toMatchObject({
        severity: 'info',
        message: '“empty.cfg” is empty.',
      });
    }
    expect(typeText).not.toHaveBeenCalled();
  });

  it('says so when the session ended while the file was read', async () => {
    const { id, typeText } = openTab(TELNET);
    useTabsStore.getState().update(id, { status: 'closed' });

    await expect(sendTextFile(id, file(CONFIG))).resolves.toBe(false);
    expect(typeText).not.toHaveBeenCalled();
    expect(useToastStore.getState().toast).toMatchObject({
      message: 'The session is no longer connected.',
    });
  });
});

describe('the Send text file command', () => {
  const command = () => keyCommand('terminal.send-text-file')!;

  it('is unbound and leaves the key to tabs that take no file', () => {
    expect(command().defaultChords).toEqual([]);
    expect(command().run()).toBe(false);
    openTab({ kind: 'local' });
    expect(command().run()).toBe(false);
    openTab(TELNET, 'connecting');
    expect(command().run()).toBe(false);
  });

  it('asks for a file and types the chosen one into the active session', async () => {
    const { typeText } = openTab(SERIAL);
    let onChange: (() => void) | undefined;
    const input = {
      type: '',
      files: [file(CONFIG)],
      click: vi.fn(),
      addEventListener: (_type: string, listener: () => void) => {
        onChange = listener;
      },
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => input) });

    expect(command().run()).toBe(true);
    expect(input).toMatchObject({ type: 'file' });
    expect(input.click).toHaveBeenCalledOnce();
    onChange?.();
    await vi.waitFor(() => expect(typeText).toHaveBeenCalledExactlyOnceWith(CONFIG));
  });
});
