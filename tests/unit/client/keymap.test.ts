import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBindingIndex,
  chordsAreDefault,
  commandChords,
  commandsForChord,
  commandsForEvent,
  conflictingCommandIds,
  isCommandCustomized,
} from '../../../client/src/keymap/bindings.js';
import {
  chordFromEvent,
  chordSignature,
  chordToString,
  eventSignature,
  formatChord,
  isBindableChord,
  isModifierCode,
  parseChord,
  sendsControlCharacter,
} from '../../../client/src/keymap/chords.js';
import { KEY_COMMANDS, keyCommand } from '../../../client/src/keymap/commands.js';
import { useMultiExecStore } from '../../../client/src/state/multi-exec.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useUiStore } from '../../../client/src/state/ui.js';
import {
  registerTerminal,
  type TerminalHandle,
} from '../../../client/src/terminal/terminal-registry.js';

const keyEvent = (
  key: string,
  code: string,
  modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {},
) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

describe('chords', () => {
  it('parses modifiers, key shorthand, and rejects nonsense', () => {
    // Tests run as a non-macOS platform, so "Mod" resolves to Control.
    expect(parseChord('Mod+Shift+ArrowRight')).toEqual({
      code: 'ArrowRight',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
    });
    expect(parseChord('Mod+K')?.code).toBe('KeyK');
    expect(parseChord('Alt+1')?.code).toBe('Digit1');
    expect(parseChord('Hyper+KeyK')).toBeUndefined();
    expect(parseChord('Ctrl+ShiftLeft')).toBeUndefined();
    expect(parseChord('')).toBeUndefined();
  });

  it('resolves punctuation by the character printed on the cap, then by position', () => {
    const zoomIn = parseChord('Ctrl+Shift+Equal')!;
    expect(eventSignature(keyEvent('+', 'Equal', { ctrlKey: true, shiftKey: true }))).toBe(
      chordSignature(zoomIn),
    );
    expect(eventSignature(keyEvent('=', 'Equal', { ctrlKey: true }))).not.toBe(
      chordSignature(zoomIn),
    );
    // "?" lives over ß on German and over the slash key on US — same shortcut.
    const help = parseChord('Ctrl+Shift+Slash')!;
    expect(eventSignature(keyEvent('?', 'Minus', { ctrlKey: true, shiftKey: true }))).toBe(
      chordSignature(help),
    );
    expect(eventSignature(keyEvent('?', 'Slash', { ctrlKey: true, shiftKey: true }))).toBe(
      chordSignature(help),
    );
    // A character a layout only reaches over another key — German ";" over the
    // comma key — stays with the physical key it was typed on.
    expect(eventSignature(keyEvent(';', 'Comma', { ctrlKey: true, shiftKey: true }))).toBe(
      chordSignature(parseChord('Ctrl+Shift+Comma')!),
    );
  });

  it('round-trips a captured event into a storable chord', () => {
    const chord = chordFromEvent(keyEvent('T', 'KeyT', { ctrlKey: true, shiftKey: true }));
    expect(chordToString(chord)).toBe('Ctrl+Shift+KeyT');
    expect(chordSignature(parseChord(chordToString(chord))!)).toBe(chordSignature(chord));
  });

  it('only accepts chords that cannot swallow ordinary typing', () => {
    expect(isBindableChord(parseChord('Shift+KeyT')!)).toBe(false);
    expect(isBindableChord(parseChord('KeyT')!)).toBe(false);
    expect(isBindableChord(parseChord('F5')!)).toBe(true);
    expect(isBindableChord(parseChord('Alt+ArrowLeft')!)).toBe(true);
    expect(isModifierCode('ShiftLeft')).toBe(true);
  });

  it('knows the chords the shell owns', () => {
    const owned = (text: string) => sendsControlCharacter(parseChord(text)!);
    for (const chord of [
      'Ctrl+KeyC',
      'Ctrl+KeyW',
      'Ctrl+Space',
      // xterm.js sends nothing for it, but the keymap leaves Ctrl+2…8 to the terminal.
      'Ctrl+Digit2',
      'Ctrl+Digit3',
      'Ctrl+Digit8',
      'Ctrl+BracketLeft',
      'Ctrl+Backslash',
      'Ctrl+Slash',
      'Ctrl+Backspace',
      'Ctrl+Shift+Backspace',
      'Ctrl+Shift+Digit2',
      'Ctrl+Shift+Digit6',
      'Ctrl+Shift+Minus',
    ]) {
      expect(owned(chord), chord).toBe(true);
    }
    // Ctrl+Shift with a letter is where the defaults live; Alt, Cmd and other keys stay free.
    for (const chord of [
      'Ctrl+Shift+KeyC',
      'Ctrl+Alt+KeyC',
      'Ctrl+Alt+Backspace',
      'Meta+KeyC',
      'Ctrl+Digit1',
      'Ctrl+PageDown',
      'Alt+KeyC',
    ]) {
      expect(owned(chord), chord).toBe(false);
    }
  });

  it('renders keys the way the shortcut list shows them', () => {
    expect(formatChord(parseChord('Mod+Shift+ArrowRight')!)).toBe('Ctrl+Shift+→');
    expect(formatChord(parseChord('Alt+Digit1')!)).toBe('Alt+1');
    expect(formatChord(parseChord('Ctrl+PageDown')!)).toBe('Ctrl+PgDn');
  });
});

describe('default bindings', () => {
  it('parses every default chord', () => {
    for (const command of KEY_COMMANDS) {
      for (const chord of command.defaultChords) {
        expect(parseChord(chord), `${command.id} → ${chord}`).toBeDefined();
      }
    }
  });

  it('ships without a single chord collision', () => {
    expect([...conflictingCommandIds()]).toEqual([]);
  });

  it('leaves the shell the keys it owns', () => {
    // Ctrl+2…Ctrl+8 are control characters (Ctrl+3 is Escape) and Ctrl+W
    // deletes a word, so away from macOS neither can be a shortcut.
    expect(commandsForChord('Ctrl+Digit3')).toEqual([]);
    expect(commandsForChord('Ctrl+KeyW')).toEqual([]);
    expect(commandsForChord('Alt+Digit3').map((command) => command.id)).toEqual(['tab.select.3']);
    expect(commandsForChord('Ctrl+Shift+KeyW').map((command) => command.id)).toEqual(['tab.close']);
  });

  it('binds multi-execution to a chord of its own', () => {
    expect(commandsForChord('Mod+Shift+M').map((command) => command.id)).toEqual([
      'terminal.multi-exec',
    ]);
  });

  it('opens the saved command menu with Control+Space', () => {
    useUiStore.getState().setCommandButtonMenuOpen(false);
    const commands = commandsForChord('Ctrl+Space');

    expect(commands.map((command) => command.id)).toEqual(['terminal.command-menu']);
    expect(commands[0]?.run()).toBe(true);
    expect(useUiStore.getState().commandButtonMenuOpen).toBe(true);

    useUiStore.getState().setCommandButtonMenuOpen(false);
  });

  it('opens the Send secret picker with its own chord, only beside a terminal', () => {
    useUiStore.getState().setSendSecretMenuOpen(false);
    const commands = commandsForChord('Mod+Shift+P');
    expect(commands.map((command) => command.id)).toEqual(['terminal.send-secret']);
    expect(commands[0]?.title).toBe('Send secret…');

    expect(commands[0]?.run()).toBe(false);
    expect(useUiStore.getState().sendSecretMenuOpen).toBe(false);

    useTabsStore.setState({ activeId: 'tab-secret' });
    const unregister = registerTerminal('tab-secret', {} as TerminalHandle);
    try {
      expect(commands[0]?.run()).toBe(true);
      expect(useUiStore.getState().sendSecretMenuOpen).toBe(true);
    } finally {
      unregister();
      useUiStore.getState().setSendSecretMenuOpen(false);
      useTabsStore.setState({ activeId: null });
    }
  });

  it('switches between the terminal and open files with Control+`', () => {
    useTabsStore.setState({
      tabs: [],
      unreadOutputIds: new Set(),
      root: { id: 'pane-keymap', type: 'pane', activeTabId: null },
      activePaneId: 'pane-keymap',
      activeId: null,
      zoomedPaneId: null,
    });
    const id = useTabsStore.getState().open({ kind: 'local' }, 'Local');
    const commands = commandsForChord('Ctrl+Backquote');
    const toggle = commands[0]!;
    const tab = () => useTabsStore.getState().tabs[0]!;

    expect(commands.map((command) => command.id)).toEqual(['terminal.toggle-editor']);
    expect(toggle.inEditor).toBe(true);
    // Without open files the key stays with the shell.
    expect(toggle.run()).toBe(false);

    useTabsStore.getState().openEditor(id, '/etc/hosts');
    expect(toggle.run()).toBe(true);
    expect(tab()).toMatchObject({ activeEditorPath: '/etc/hosts', terminalShown: true });
    expect(toggle.run()).toBe(true);
    expect(tab()).toMatchObject({ activeEditorPath: '/etc/hosts', terminalShown: false });
  });

  it('toggles focus mode with its default chord', () => {
    useUiStore.getState().setFocusMode(false);
    const commands = commandsForChord('Mod+Shift+B');

    expect(commands.map((command) => command.id)).toEqual(['app.focus-mode']);
    expect(commands[0]?.run()).toBe(true);
    expect(useUiStore.getState().focusMode).toBe(true);
    expect(commands[0]?.run()).toBe(true);
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  it('gives every direction its own split, focus, and move-tab chord', () => {
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      expect(commandChords(keyCommand(`pane.split.${direction}`)!).length).toBeGreaterThan(0);
      expect(commandChords(keyCommand(`pane.focus.${direction}`)!).length).toBeGreaterThan(0);
      expect(commandChords(keyCommand(`tab.to-pane.${direction}`)!).length).toBeGreaterThan(0);
    }
    expect(commandsForChord('Mod+Shift+ArrowRight').map((command) => command.id)).toEqual([
      'pane.split.right',
    ]);
    expect(commandsForChord('Alt+ArrowRight').map((command) => command.id)).toEqual([
      'pane.focus.right',
    ]);
    expect(commandsForChord('Alt+Shift+ArrowRight').map((command) => command.id)).toEqual([
      'tab.to-pane.right',
    ]);
  });

  it('keeps numbered tab selection on the Alt row', () => {
    expect(commandsForChord('Alt+Digit3').map((command) => command.id)).toEqual([
      'tab.select.3',
    ]);
    expect(commandsForChord('Alt+Digit9').map((command) => command.id)).toEqual([
      'tab.select.last',
    ]);
    expect(commandsForChord('Alt+Shift+Digit3')).toEqual([]);
  });
});

/** The keymap of another platform: `Mod` and the macOS-only chords are fixed when it loads. */
async function keymapOn(platform: string) {
  vi.stubGlobal('navigator', { platform });
  vi.resetModules();
  return import('../../../client/src/keymap/bindings.js');
}

describe('line jumps', () => {
  const lineStart = () => keyCommand('terminal.line-start')!;
  const lineEnd = () => keyCommand('terminal.line-end')!;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    useMultiExecStore.setState({ selectedIds: [], lastMirroredIds: [] });
    useTabsStore.setState({ activeId: null });
  });

  it('take exactly Command+Left/Right on macOS', async () => {
    const mac = await keymapOn('MacIntel');
    const commandIds = (code: string, modifiers: Parameters<typeof keyEvent>[2]) =>
      mac.commandsForEvent(keyEvent(code, code, modifiers), {}).map((command) => command.id);

    expect(commandIds('ArrowLeft', { metaKey: true })).toEqual(['terminal.line-start']);
    expect(commandIds('ArrowRight', { metaKey: true })).toEqual(['terminal.line-end']);
    expect(commandIds('ArrowLeft', { metaKey: true, shiftKey: true })).toEqual(['pane.split.left']);
    expect(commandIds('ArrowLeft', { metaKey: true, altKey: true })).toEqual(['pane.focus.left']);
    expect(commandIds('ArrowLeft', { ctrlKey: true })).toEqual([]);
    expect([...mac.conflictingCommandIds()]).toEqual([]);
  });

  it('have no default chord on Windows and Linux', async () => {
    for (const platform of ['Win32', 'Linux x86_64']) {
      const keymap = await keymapOn(platform);
      expect(keymap.keyCommand('terminal.line-start')?.defaultChords, platform).toEqual([]);
      expect(keymap.keyCommand('terminal.line-end')?.defaultChords, platform).toEqual([]);
      expect(
        keymap.commandsForEvent(keyEvent('ArrowLeft', 'ArrowLeft', { ctrlKey: true }), {}),
        platform,
      ).toEqual([]);
    }
  });

  it('only answer chords pressed in a focused terminal', () => {
    expect(lineStart().typesIntoSession).toBe(true);
    expect(lineEnd().typesIntoSession).toBe(true);
  });

  it('type Ctrl+A and Ctrl+E as keys pressed in the active terminal, mirrored by multi-execution', () => {
    const typed = vi.fn(() => true);
    const mirrored = vi.fn(() => true);
    const unregister = [
      registerTerminal('tab-line', { sendKeyboardInput: typed } as unknown as TerminalHandle),
      registerTerminal('tab-mirror', { sendKeyboardInput: mirrored } as unknown as TerminalHandle),
    ];
    useTabsStore.setState({ activeId: 'tab-line' });
    useMultiExecStore.getState().setSelection(['tab-line', 'tab-mirror']);
    try {
      expect(lineStart().run()).toBe(true);
      expect(lineEnd().run()).toBe(true);
      expect(typed.mock.calls).toEqual([['\x01'], ['\x05']]);
      expect(mirrored.mock.calls).toEqual([['\x01'], ['\x05']]);
    } finally {
      for (const done of unregister) done();
    }
  });

  it('leave the key alone without a live session in the active terminal', () => {
    expect(lineStart().run()).toBe(false);

    // An active tab without a terminal, such as a remote desktop.
    useTabsStore.setState({ activeId: 'tab-ended' });
    expect(lineStart().run()).toBe(false);

    const ended = vi.fn(() => false);
    const mirrored = vi.fn(() => true);
    const unregister = [
      registerTerminal('tab-ended', { sendKeyboardInput: ended } as unknown as TerminalHandle),
      registerTerminal('tab-mirror', { sendKeyboardInput: mirrored } as unknown as TerminalHandle),
    ];
    useMultiExecStore.getState().setSelection(['tab-ended', 'tab-mirror']);
    try {
      expect(lineEnd().run()).toBe(false);
      expect(ended).toHaveBeenCalledExactlyOnceWith('\x05');
      expect(mirrored).not.toHaveBeenCalled();
    } finally {
      for (const done of unregister) done();
    }
  });
});

describe('pane focus keys', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('leave Option+arrow to word jumps on macOS and take Command+Option+arrow', async () => {
    const mac = await keymapOn('MacIntel');
    const commandIds = (code: string, modifiers: Parameters<typeof keyEvent>[2]) =>
      mac.commandsForEvent(keyEvent(code, code, modifiers), {}).map((command) => command.id);

    // Two panes side by side must not turn the word jump into a focus change.
    expect(commandIds('ArrowLeft', { altKey: true })).toEqual([]);
    expect(commandIds('ArrowRight', { altKey: true })).toEqual([]);
    for (const direction of ['Left', 'Right', 'Up', 'Down']) {
      expect(commandIds(`Arrow${direction}`, { metaKey: true, altKey: true })).toEqual([
        `pane.focus.${direction.toLowerCase()}`,
      ]);
    }
    expect([...mac.conflictingCommandIds()]).toEqual([]);
  });

  it('stay on Alt+arrow on Windows and Linux', async () => {
    for (const platform of ['Win32', 'Linux x86_64']) {
      const keymap = await keymapOn(platform);
      expect(
        keymap
          .commandsForEvent(keyEvent('ArrowLeft', 'ArrowLeft', { altKey: true }), {})
          .map((command) => command.id),
        platform,
      ).toEqual(['pane.focus.left']);
    }
  });
});

describe('user overrides', () => {
  const overrides = { 'pane.zoom': ['Ctrl+Shift+KeyJ'], 'pane.equalize': [] };

  it('replaces the defaults of the rebound command only', () => {
    expect(commandsForChord('Ctrl+Shift+KeyJ', overrides).map((command) => command.id)).toEqual([
      'pane.zoom',
    ]);
    expect(commandsForChord('Mod+Shift+Z', overrides)).toEqual([]);
    expect(commandsForChord('Mod+Shift+ArrowDown', overrides).map((command) => command.id)).toEqual([
      'pane.split.down',
    ]);
  });

  it('treats an empty chord list as unbound', () => {
    const index = buildBindingIndex(overrides);
    expect([...index.values()].flat().some((command) => command.id === 'pane.equalize')).toBe(false);
  });

  it('reports a chord shared with another command', () => {
    const clashing = { 'pane.zoom': ['Mod+Shift+T'] };
    expect([...conflictingCommandIds(clashing)].sort()).toEqual(['pane.zoom', 'tab.new']);
  });

  it('leaves Send BREAK unbound until a chord is recorded for it', () => {
    expect(keyCommand('terminal.send-break')?.defaultChords).toEqual([]);
    const bound = { 'terminal.send-break': ['Ctrl+Alt+KeyB'] };
    expect(commandsForChord('Ctrl+Alt+KeyB', bound).map((command) => command.id)).toEqual([
      'terminal.send-break',
    ]);
    expect(conflictingCommandIds(bound).has('terminal.send-break')).toBe(false);
  });

  it('recognizes an override that only restates the default', () => {
    const zoom = keyCommand('pane.zoom')!;
    expect(chordsAreDefault(zoom, ['Ctrl+Shift+KeyZ'])).toBe(true);
    expect(isCommandCustomized(zoom, { 'pane.zoom': ['Ctrl+Shift+KeyZ'] })).toBe(false);
    expect(isCommandCustomized(zoom, overrides)).toBe(true);
  });
});

describe('keyboard layouts', () => {
  const commandIds = (event: Parameters<typeof commandsForEvent>[0]) =>
    commandsForEvent(event, {}).map((command) => command.id);

  it('takes letters from the key cap, so QWERTZ presses the key printed Z', () => {
    // German layout: the cap printed Z sits where QWERTY has Y.
    expect(commandIds(keyEvent('z', 'KeyY', { ctrlKey: true, shiftKey: true }))).toEqual(['pane.zoom']);
    // ...and the cap printed Y must not zoom just because it sits on KeyZ.
    expect(commandIds(keyEvent('y', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toEqual([]);
  });

  it('stores a rebound chord under the letter the user pressed', () => {
    expect(chordToString(chordFromEvent(keyEvent('z', 'KeyY', { ctrlKey: true, shiftKey: true })))).toBe(
      'Ctrl+Shift+KeyZ',
    );
  });

  it('falls back to the physical key when the character is mangled', () => {
    // AZERTY types "&" where QWERTY has 1; macOS turns Option+1 into "¡".
    expect(commandIds(keyEvent('&', 'Digit1', { altKey: true }))).toEqual(['tab.select.1']);
    expect(commandIds(keyEvent('¡', 'Digit1', { altKey: true }))).toEqual(['tab.select.1']);
    // Digits typed as digits resolve the same way.
    expect(commandIds(keyEvent('1', 'Digit1', { altKey: true }))).toEqual(['tab.select.1']);
  });

  it('keeps German punctuation on the printed cap', () => {
    // Ctrl+Shift+? opens the sheet where the layout prints "?" (over ß)...
    expect(commandIds(keyEvent('?', 'Minus', { ctrlKey: true, shiftKey: true }))).toEqual([
      'app.shortcuts',
    ]);
    // ...and the key printed "-" still zooms the terminal out.
    expect(commandIds(keyEvent('_', 'Slash', { ctrlKey: true, shiftKey: true }))).toEqual([
      'terminal.zoom-out',
    ]);
    // Shrinking a pane rides the comma key, which German types as ";".
    expect(commandIds(keyEvent(';', 'Comma', { ctrlKey: true, shiftKey: true }))).toEqual([
      'pane.shrink',
    ]);
  });

  it('zooms from the printed + and - keys of either layout', () => {
    // German types "+" unshifted on another key; US needs Shift on "=".
    expect(commandIds(keyEvent('+', 'BracketRight', { ctrlKey: true }))).toEqual([
      'terminal.zoom-in',
    ]);
    expect(commandIds(keyEvent('+', 'Equal', { ctrlKey: true, shiftKey: true }))).toEqual([
      'terminal.zoom-in',
    ]);
    expect(commandIds(keyEvent('=', 'Equal', { ctrlKey: true }))).toEqual(['terminal.zoom-in']);
    expect(commandIds(keyEvent('+', 'NumpadAdd', { ctrlKey: true }))).toEqual(['terminal.zoom-in']);
    // German "-" sits on the slash key, US on its own.
    expect(commandIds(keyEvent('-', 'Slash', { ctrlKey: true }))).toEqual(['terminal.zoom-out']);
    expect(commandIds(keyEvent('-', 'Minus', { ctrlKey: true }))).toEqual(['terminal.zoom-out']);
    expect(commandIds(keyEvent('_', 'Slash', { ctrlKey: true, shiftKey: true }))).toEqual([
      'terminal.zoom-out',
    ]);
  });

  it('leaves keys without a character on their layout-independent code', () => {
    expect(commandIds(keyEvent('ArrowRight', 'ArrowRight', { ctrlKey: true, shiftKey: true }))).toEqual([
      'pane.split.right',
    ]);
    expect(commandIds(keyEvent('ArrowLeft', 'ArrowLeft', { altKey: true }))).toEqual(['pane.focus.left']);
  });
});
