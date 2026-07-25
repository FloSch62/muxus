import { IS_MAC } from '../platform.js';

/**
 * Chord grammar: zero or more modifiers followed by a `KeyboardEvent.code`,
 * joined with `+` — "Mod+Shift+ArrowRight", "Alt+Digit1", "Ctrl+PageDown".
 *
 * `Mod` resolves to Command on macOS and Control everywhere else, so one
 * default table serves every platform. Matching uses `code` (the physical
 * key) rather than `key`, which keeps chords stable across keyboard layouts
 * and unaffected by Shift/AltGr producing a different character.
 */
export interface Chord {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ChordEvent {
  /** The character the key produced, e.g. "z" on the key printed Z. */
  key: string;
  /** The physical key in US-layout terms, e.g. "KeyY" for that same key on QWERTZ. */
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
]);

const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Escape: 'Esc',
  Space: 'Space',
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Delete: 'Del',
  Insert: 'Ins',
};

/** Modifier keys never form a chord on their own. */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** Accept "T"/"1" shorthand alongside literal `KeyboardEvent.code` values. */
function canonicalCode(token: string): string {
  if (/^[a-z]$/i.test(token)) return `Key${token.toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  return token;
}

export function parseChord(text: string): Chord | undefined {
  const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return undefined;
  const chord: Chord = { code: canonicalCode(key), ctrl: false, alt: false, shift: false, meta: false };
  if (isModifierCode(chord.code)) return undefined;
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod':
        if (IS_MAC) chord.meta = true;
        else chord.ctrl = true;
        break;
      case 'ctrl':
      case 'control':
        chord.ctrl = true;
        break;
      case 'alt':
      case 'option':
        chord.alt = true;
        break;
      case 'shift':
        chord.shift = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
      case 'super':
        chord.meta = true;
        break;
      default:
        return undefined;
    }
  }
  return chord;
}

/** Stable lookup key for a chord; identical for equivalent chords. */
export function chordSignature(chord: Chord): string {
  return `${chord.ctrl ? 'C' : ''}${chord.alt ? 'A' : ''}${chord.shift ? 'S' : ''}${chord.meta ? 'M' : ''}:${chord.code}`;
}

export function eventSignature(event: ChordEvent): string {
  return chordSignature(chordFromEvent(event));
}

/**
 * Letters and digits are identified by the character the key produces, so a
 * chord is pressed on the cap it is printed on — Ctrl+Shift+Z is the key
 * labelled Z on a German keyboard, not the physical QWERTY position. Every
 * other key keeps its layout-independent code: arrows and page keys have no
 * character, and modified keys whose character is mangled (Option+1 on macOS,
 * Alt+1 on AZERTY) still resolve by position.
 */
export function chordFromEvent(event: ChordEvent): Chord {
  return {
    code: printedKeyCode(event.key) ?? event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

/**
 * Punctuation that means the same key wherever it is printed — "?" is the
 * question-mark key on both US and German layouts even though they sit on
 * different caps. Characters a layout only produces with Shift over another
 * key (German ";" over the comma key) are deliberately absent, so those keep
 * resolving by position.
 */
const PRINTED_PUNCTUATION: Record<string, string> = {
  '-': 'Minus',
  _: 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '/': 'Slash',
  '?': 'Slash',
  ',': 'Comma',
  '.': 'Period',
  '[': 'BracketLeft',
  ']': 'BracketRight',
};

const NUMPAD_LABELS: Record<string, string> = {
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
  NumpadDecimal: '.',
  NumpadEnter: 'Enter',
};

function printedKeyCode(key: string): string | undefined {
  if (key.length !== 1) return undefined;
  const lower = key.toLowerCase();
  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
  if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
  return PRINTED_PUNCTUATION[key];
}

/** Serialize a captured chord with explicit modifiers (never "Mod"). */
export function chordToString(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(chord.code);
  return parts.join('+');
}

/**
 * A chord needs a non-Shift modifier (or a function key) so bindings can
 * never swallow ordinary typing in the terminal.
 */
export function isBindableChord(chord: Chord): boolean {
  if (isModifierCode(chord.code)) return false;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(chord.code)) return true;
  return chord.ctrl || chord.alt || chord.meta;
}

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${NUMPAD_LABELS[code] ?? code.slice(6)}`;
  return KEY_LABELS[code] ?? code;
}

/** Platform-native rendering: "⌃⇧→" on macOS, "Ctrl+Shift+→" elsewhere. */
export function formatChord(chord: Chord): string {
  if (IS_MAC) {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.meta ? '⌘' : ''}${keyLabel(chord.code)}`;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(keyLabel(chord.code));
  return parts.join('+');
}

// Chord text comes from a fixed catalog plus the user's overrides, and every
// menu, tooltip, and palette row re-renders it. Parse each one once.
const chordStringLabels = new Map<string, string>();

/** Render a stored chord string; unparseable input is echoed unchanged. */
export function formatChordString(text: string): string {
  const cached = chordStringLabels.get(text);
  if (cached !== undefined) return cached;
  const chord = parseChord(text);
  const label = chord ? formatChord(chord) : text;
  chordStringLabels.set(text, label);
  return label;
}
