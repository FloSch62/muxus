const KITTY_KEYPAD_ENTER = '\ue046';

type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>;

/**
 * Work around xterm's Kitty encoder exposing KP_Enter's private-use code point
 * on macOS when no negotiated mode encoded it as a CSI-u sequence.
 */
export function normalizeTerminalKeyboardInput(
  data: string,
  event: TerminalKeyboardEvent | undefined,
  isMac: boolean,
): string {
  if (
    isMac &&
    data === KITTY_KEYPAD_ENTER &&
    event?.code === 'NumpadEnter' &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    return '\r';
  }
  return data;
}
