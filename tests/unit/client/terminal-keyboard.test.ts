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
});
