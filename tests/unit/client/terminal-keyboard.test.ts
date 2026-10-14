import { describe, expect, it } from 'vitest';
import { normalizeTerminalKeyboardInput } from '../../../client/src/terminal/keyboard-input.js';

function keyEvent(
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
) {
  return {
    code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe('terminal keyboard input', () => {
  it('turns the macOS KP_Enter private-use glyph into carriage return', () => {
    expect(
      normalizeTerminalKeyboardInput('\ue046', keyEvent('NumpadEnter'), true),
    ).toBe('\r');
  });

  it('does not change the ordinary Return key', () => {
    expect(normalizeTerminalKeyboardInput('\r', keyEvent('Enter'), true)).toBe('\r');
  });

  it('preserves negotiated Kitty keypad reporting', () => {
    const kittyKeypadEnter = '\x1b[57414u';

    expect(
      normalizeTerminalKeyboardInput(kittyKeypadEnter, keyEvent('NumpadEnter'), true),
    ).toBe(kittyKeypadEnter);
  });

  it('leaves modified, non-macOS, and non-keyboard input untouched', () => {
    expect(
      normalizeTerminalKeyboardInput(
        '\ue046',
        keyEvent('NumpadEnter', { shiftKey: true }),
        true,
      ),
    ).toBe('\ue046');
    expect(normalizeTerminalKeyboardInput('\ue046', keyEvent('NumpadEnter'), false)).toBe(
      '\ue046',
    );
    expect(normalizeTerminalKeyboardInput('\ue046', undefined, true)).toBe('\ue046');
  });

  it('turns Option+Left/Right into word motions on macOS', () => {
    expect(
      normalizeTerminalKeyboardInput('\x1b[1;3D', keyEvent('ArrowLeft', { altKey: true }), true),
    ).toBe('\x1bb');
    expect(
      normalizeTerminalKeyboardInput('\x1b[1;3C', keyEvent('ArrowRight', { altKey: true }), true),
    ).toBe('\x1bf');
  });

  it('leaves other arrow chords and non-macOS Alt+Arrow untouched', () => {
    expect(
      normalizeTerminalKeyboardInput('\x1b[1;3D', keyEvent('ArrowLeft', { altKey: true }), false),
    ).toBe('\x1b[1;3D');
    expect(
      normalizeTerminalKeyboardInput(
        '\x1b[1;4D',
        keyEvent('ArrowLeft', { altKey: true, shiftKey: true }),
        true,
      ),
    ).toBe('\x1b[1;4D');
    expect(normalizeTerminalKeyboardInput('\x1b[D', keyEvent('ArrowLeft'), true)).toBe('\x1b[D');
    expect(normalizeTerminalKeyboardInput('\x1b[1;3D', undefined, true)).toBe('\x1b[1;3D');
  });

  it('preserves Kitty encodings that report key event types', () => {
    const kittyOptionLeftPress = '\x1b[1;3:1D';

    expect(
      normalizeTerminalKeyboardInput(
        kittyOptionLeftPress,
        keyEvent('ArrowLeft', { altKey: true }),
        true,
      ),
    ).toBe(kittyOptionLeftPress);
  });
});
