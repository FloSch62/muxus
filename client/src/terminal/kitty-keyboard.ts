import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * Kitty keyboard protocol (https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
 *
 * Implements the progressive-enhancement flag stack (CSI ? u query, CSI > u
 * push, CSI < u pop, CSI = u set) with separate stacks for the main and alt
 * screens, and encodes key events per the active flags:
 *   1  disambiguate escape codes   2  report event types
 *   4  report alternate keys       8  report all keys as escape codes
 *  16  report associated text
 * Arrow/function keys keep their legacy CSI forms (kitty-compatible), which
 * xterm.js already emits — the encoder only takes over where the legacy
 * encoding is ambiguous or the flags demand more.
 */

export const FLAG_DISAMBIGUATE = 1;
export const FLAG_EVENT_TYPES = 2;
export const FLAG_ALTERNATE_KEYS = 4;
export const FLAG_ALL_ESCAPES = 8;
export const FLAG_ASSOCIATED_TEXT = 16;
const ALL_FLAGS = 31;
const MAX_STACK = 16;

export interface KeyEventLike {
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** C0-adjacent keys that get CSI u codes (kitty functional encoding). */
const SPECIAL_CODEPOINTS: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
};

/** Modifier keys report Private Use Area codepoints, but only with flag 8. */
const MODIFIER_CODEPOINTS: Record<string, number> = {
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450,
};

/**
 * Encode one key event per the active flags. Returns null when the legacy
 * path should handle the key (xterm's default encoding is already correct).
 */
export function encodeKittyKey(ev: KeyEventLike, flags: number): string | null {
  if (!flags || ev.isComposing) return null;
  const isUp = ev.type === 'keyup';
  if (ev.type !== 'keydown' && !isUp) return null;
  if (isUp && !(flags & FLAG_EVENT_TYPES)) return null;

  const modifiers = (ev.shiftKey ? 1 : 0) | (ev.altKey ? 2 : 0) | (ev.ctrlKey ? 4 : 0) | (ev.metaKey ? 8 : 0);

  let codepoint: number | undefined;
  let shiftedAlternate: number | undefined;
  let text: string | undefined;

  const special = SPECIAL_CODEPOINTS[ev.key];
  const modifierKey = MODIFIER_CODEPOINTS[ev.code];
  if (special !== undefined) {
    codepoint = special;
    // Unmodified Enter/Tab/Backspace keep their single-byte legacy encodings
    // unless every key must become an escape code; Escape is always encoded
    // (its legacy \x1b byte is the ambiguity the protocol exists to fix).
    if (!(flags & FLAG_ALL_ESCAPES) && ev.key !== 'Escape' && modifiers === 0 && !isUp) return null;
  } else if (modifierKey !== undefined) {
    if (!(flags & FLAG_ALL_ESCAPES)) return null;
    codepoint = modifierKey;
  } else if (ev.key.length === 1 || (ev.key.length === 2 && ev.key.codePointAt(0)! > 0xffff)) {
    const lower = ev.key.toLowerCase();
    codepoint = lower.codePointAt(0)!;
    if (flags & FLAG_ALTERNATE_KEYS && ev.shiftKey && ev.key !== lower) {
      shiftedAlternate = ev.key.codePointAt(0)!;
    }
    if (flags & FLAG_ASSOCIATED_TEXT && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !isUp) {
      text = ev.key;
    }
    // Plain text (no ctrl/alt/super) stays on the legacy path unless all
    // keys must be escapes — that is what keeps typing byte-identical.
    if (!(flags & FLAG_ALL_ESCAPES) && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !isUp) return null;
  } else {
    // Arrows, F-keys, nav cluster: legacy CSI encodings match kitty's.
    return null;
  }

  const eventType = flags & FLAG_EVENT_TYPES ? (isUp ? 3 : ev.repeat ? 2 : 1) : 1;
  const modParam = modifiers + 1;

  let keyPart = String(codepoint);
  if (shiftedAlternate !== undefined && shiftedAlternate !== codepoint) keyPart += `:${shiftedAlternate}`;

  let modPart = '';
  if (modParam !== 1 || eventType !== 1) {
    modPart = String(modParam);
    if (eventType !== 1) modPart += `:${eventType}`;
  }

  let textPart = '';
  if (text) {
    const codepoints: number[] = [];
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      codepoints.push(cp);
      i += cp > 0xffff ? 2 : 1;
    }
    textPart = codepoints.join(':');
  }

  if (textPart) return `\x1b[${keyPart};${modPart || '1'};${textPart}u`;
  if (modPart) return `\x1b[${keyPart};${modPart}u`;
  return `\x1b[${keyPart}u`;
}

export class KittyKeyboardHandler {
  private readonly stacks: Record<'normal' | 'alternate', number[]> = { normal: [0], alternate: [0] };
  private readonly disposables: IDisposable[] = [];

  constructor(private readonly term: Terminal) {}

  get flags(): number {
    const stack = this.stacks[this.term.buffer.active.type];
    return stack[stack.length - 1] ?? 0;
  }

  attach(): void {
    const parser = this.term.parser;
    this.disposables.push(
      parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
        this.term.input(`\x1b[?${this.flags}u`, false);
        return true;
      }),
      parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
        const stack = this.activeStack();
        stack.push((numParam(params, 0) ?? 0) & ALL_FLAGS);
        if (stack.length > MAX_STACK) stack.splice(1, 1); // drop the oldest push, keep the base
        return true;
      }),
      parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
        const stack = this.activeStack();
        const count = numParam(params, 0) ?? 1;
        for (let i = 0; i < count && stack.length > 1; i++) stack.pop();
        return true;
      }),
      parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
        const stack = this.activeStack();
        const flags = (numParam(params, 0) ?? 0) & ALL_FLAGS;
        const mode = numParam(params, 1) ?? 1;
        const current = stack[stack.length - 1] ?? 0;
        const next = mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags;
        stack[stack.length - 1] = next;
        return true;
      }),
      // RIS resets the protocol along with the rest of the terminal state.
      parser.registerEscHandler({ final: 'c' }, () => {
        this.stacks.normal = [0];
        this.stacks.alternate = [0];
        return false;
      }),
    );
  }

  /** Handle a key event; true = consumed (an encoding was sent). */
  handleKey(ev: KeyboardEvent): boolean {
    const seq = encodeKittyKey(ev, this.flags);
    if (seq === null) return false;
    this.term.input(seq, true);
    return true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private activeStack(): number[] {
    return this.stacks[this.term.buffer.active.type];
  }
}

function numParam(params: (number | number[])[], index: number): number | undefined {
  const value = params[index];
  return typeof value === 'number' && value >= 0 ? value : undefined;
}
