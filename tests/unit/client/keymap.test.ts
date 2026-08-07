import { describe, expect, it } from 'vitest';
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
} from '../../../client/src/keymap/chords.js';
import { KEY_COMMANDS, keyCommand } from '../../../client/src/keymap/commands.js';
import { useUiStore } from '../../../client/src/state/ui.js';

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
