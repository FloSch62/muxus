import { describe, expect, it } from 'vitest';
import { encodeKittyKey, type KeyEventLike } from '../../../client/src/terminal/kitty-keyboard.js';

function key(overrides: Partial<KeyEventLike>): KeyEventLike {
  return {
    type: 'keydown',
    key: 'a',
    code: 'KeyA',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe('encodeKittyKey', () => {
  it('does nothing when the protocol is inactive', () => {
    expect(encodeKittyKey(key({ key: 'Escape' }), 0)).toBeNull();
  });

  it('encodes Escape unambiguously with flag 1', () => {
    expect(encodeKittyKey(key({ key: 'Escape', code: 'Escape' }), 1)).toBe('\x1b[27u');
  });

  it('leaves plain printable keys on the legacy path with flag 1', () => {
    expect(encodeKittyKey(key({}), 1)).toBeNull();
    expect(encodeKittyKey(key({ key: 'A', shiftKey: true }), 1)).toBeNull();
  });

  it('encodes ctrl/alt-modified keys with flag 1', () => {
    expect(encodeKittyKey(key({ ctrlKey: true, key: 'c', code: 'KeyC' }), 1)).toBe('\x1b[99;5u');
    expect(encodeKittyKey(key({ altKey: true }), 1)).toBe('\x1b[97;3u');
    expect(encodeKittyKey(key({ ctrlKey: true, shiftKey: true }), 1)).toBe('\x1b[97;6u');
  });

  it('keeps unmodified Enter/Tab/Backspace legacy, encodes them when modified', () => {
    expect(encodeKittyKey(key({ key: 'Enter', code: 'Enter' }), 1)).toBeNull();
    expect(encodeKittyKey(key({ key: 'Enter', code: 'Enter', ctrlKey: true }), 1)).toBe('\x1b[13;5u');
    expect(encodeKittyKey(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), 1)).toBe('\x1b[9;5u');
    expect(encodeKittyKey(key({ key: 'Backspace', code: 'Backspace', altKey: true }), 1)).toBe('\x1b[127;3u');
  });

  it('encodes every key as an escape with flag 8', () => {
    expect(encodeKittyKey(key({}), 8 | 1)).toBe('\x1b[97u');
    expect(encodeKittyKey(key({ key: 'Enter', code: 'Enter' }), 8 | 1)).toBe('\x1b[13u');
  });

  it('reports event types with flag 2', () => {
    expect(encodeKittyKey(key({ ctrlKey: true, key: 'c', code: 'KeyC', repeat: true }), 1 | 2)).toBe('\x1b[99;5:2u');
    expect(encodeKittyKey(key({ type: 'keyup', ctrlKey: true, key: 'c', code: 'KeyC' }), 1 | 2)).toBe('\x1b[99;5:3u');
    // Key release of a plain key is reported even though its press was text.
    expect(encodeKittyKey(key({ type: 'keyup' }), 1 | 2)).toBe('\x1b[97;1:3u');
  });

  it('drops keyup events without flag 2', () => {
    expect(encodeKittyKey(key({ type: 'keyup', ctrlKey: true, key: 'c', code: 'KeyC' }), 1)).toBeNull();
  });

  it('reports shifted alternates with flag 4', () => {
    expect(encodeKittyKey(key({ ctrlKey: true, shiftKey: true, key: 'A' }), 1 | 4)).toBe('\x1b[97:65;6u');
  });

  it('attaches associated text with flag 16', () => {
    expect(encodeKittyKey(key({}), 1 | 8 | 16)).toBe('\x1b[97;1;97u');
    // Ctrl combos carry no text.
    expect(encodeKittyKey(key({ ctrlKey: true }), 1 | 8 | 16)).toBe('\x1b[97;5u');
  });

  it('reports modifier keys themselves only with flag 8', () => {
    expect(encodeKittyKey(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 1)).toBeNull();
    expect(encodeKittyKey(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 8)).toBe('\x1b[57441;2u');
  });

  it('leaves arrows and F-keys to the (kitty-compatible) legacy encodings', () => {
    expect(encodeKittyKey(key({ key: 'ArrowLeft', code: 'ArrowLeft' }), 1)).toBeNull();
    expect(encodeKittyKey(key({ key: 'F5', code: 'F5', ctrlKey: true }), 1)).toBeNull();
  });

  it('ignores events mid-IME-composition', () => {
    expect(encodeKittyKey(key({ isComposing: true, ctrlKey: true }), 1)).toBeNull();
  });
});
