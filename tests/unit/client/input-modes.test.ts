import { describe, expect, it } from 'vitest';
import {
  customTerminalInputModes,
  hostTerminalInputModes,
  keyboardInputData,
  localEchoText,
  terminalInputModesPatch,
} from '../../../client/src/terminal/input-modes.js';

const xterm = hostTerminalInputModes(undefined);

describe('host terminal input modes', () => {
  it("keeps xterm.js's keys and no echo for a host that sets nothing", () => {
    expect(xterm).toEqual({ backspaceKey: 'del', enterKey: 'cr', implicitCr: false, localEcho: false });
    expect(customTerminalInputModes(xterm)).toBe(false);
    expect(hostTerminalInputModes({ enterKey: 'lf' })).toEqual({ ...xterm, enterKey: 'lf' });
    expect(customTerminalInputModes({ ...xterm, localEcho: true })).toBe(true);
  });

  it('stores the defaults as unset', () => {
    expect(terminalInputModesPatch(xterm)).toEqual({
      backspaceKey: null,
      enterKey: null,
      implicitCr: false,
      localEcho: false,
    });
    expect(
      terminalInputModesPatch({ backspaceKey: 'ctrl-h', enterKey: 'crlf', implicitCr: true, localEcho: true }),
    ).toEqual({ backspaceKey: 'ctrl-h', enterKey: 'crlf', implicitCr: true, localEcho: true });
  });
});

describe('keyboard input', () => {
  it('sends every keystroke exactly as xterm.js encodes it by default', () => {
    for (const key of ['\r', '\x7f', '\b', '\x1b\r', '\x1b\x7f', 'a', '\x1b[A', '\x03', '\t']) {
      expect(keyboardInputData(key, xterm)).toBe(key);
    }
  });

  it("sends Backspace and Enter as the host's keys", () => {
    const console = { backspaceKey: 'ctrl-h', enterKey: 'crlf' } as const;
    expect(keyboardInputData('\x7f', console)).toBe('\b');
    expect(keyboardInputData('\r', console)).toBe('\r\n');
    expect(keyboardInputData('\r', { backspaceKey: 'del', enterKey: 'lf' })).toBe('\n');
  });

  it('leaves the keys alone with modifiers and in other input', () => {
    const console = { backspaceKey: 'ctrl-h', enterKey: 'lf' } as const;
    // Alt+Backspace, Alt+Enter, Ctrl+Backspace, and text that only contains the bytes.
    for (const data of ['\x1b\x7f', '\x1b\r', '\b', 'ab\r', '\x1b[13;2u']) {
      expect(keyboardInputData(data, console)).toBe(data);
    }
  });
});

describe('local echo', () => {
  it('shows text as typed, Enter as a new line and Backspace as an erase', () => {
    expect(localEchoText('a')).toBe('a');
    expect(localEchoText('é🙂')).toBe('é🙂');
    expect(localEchoText('\r')).toBe('\r\n');
    expect(localEchoText('\x7f')).toBe('\b \b');
    expect(localEchoText('\b')).toBe('\b \b');
  });

  it('shows nothing for control keys, escape sequences and terminal replies', () => {
    for (const data of ['\x03', '\t', '\x1b', '\x1b[A', '\x1bOP', '\x1bb', '\x1b[?1;2c', '\x1b[I']) {
      expect(localEchoText(data)).toBe('');
    }
  });

  it('shows pasted and saved text line by line, without its control characters', () => {
    expect(localEchoText('conf t\nhostname r1\r\nend\r')).toBe('conf t\r\nhostname r1\r\nend\r\n');
    expect(localEchoText('a\tb\x07c')).toBe('abc');
  });

  it('drops C1 controls, which xterm.js would take as a query and answer', () => {
    // CSI 6n (cursor position), DCS, OSC and ST as single C1 characters.
    expect(localEchoText('z\u009b6n')).toBe('z6n');
    expect(localEchoText('\u0090$q"p\u009c\u009d10;?\u0007')).toBe('$q"p10;?');
    expect(localEchoText('\u0080\u009f é')).toBe(' é');
  });
});
