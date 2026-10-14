const KITTY_KEYPAD_ENTER = '';

// Option+Left/Right as xterm encodes them: CSI 1 ; 3 D / CSI 1 ; 3 C.
const OPTION_WORD_JUMPS: Readonly<Record<string, readonly [string, string]>> = {
  ArrowLeft: ['\x1b[1;3D', '\x1bb'],
  ArrowRight: ['\x1b[1;3C', '\x1bf'],
};

type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>;

/**
 * Patch up the bytes xterm encodes for a keystroke before they reach the
 * session:
 *
 * - xterm's Kitty encoder exposes KP_Enter's private-use code point on macOS
 *   when no negotiated mode encoded it as a CSI-u sequence.
 * - Option+Left/Right jump by word on macOS, as in Terminal.app and iTerm2.
 *   ESC b / ESC f are the word motions readline, zle, fish and network-device
 *   CLIs understand by default; the raw Alt+Arrow sequence is rarely bound.
 */
export function normalizeTerminalKeyboardInput(
  data: string,
  event: TerminalKeyboardEvent | undefined,
  isMac: boolean,
): string {
  if (!isMac || !event || event.ctrlKey || event.metaKey || event.shiftKey) return data;
  if (!event.altKey && data === KITTY_KEYPAD_ENTER && event.code === 'NumpadEnter') {
    return '\r';
  }
  const wordJump = event.altKey ? OPTION_WORD_JUMPS[event.code] : undefined;
  // Only the plain press encoding: Kitty modes that report event types or
  // other key detail produce different bytes and pass through untouched.
  if (wordJump && data === wordJump[0]) return wordJump[1];
  return data;
}
