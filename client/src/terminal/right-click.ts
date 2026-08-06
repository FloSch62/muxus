import type { RightClickAction } from '../state/prefs.js';

/**
 * xterm enables word selection on right click by default on macOS. Its native
 * contextmenu listener runs before Muxus's React handler, so that behavior can
 * replace an existing selection before Muxus decides whether to copy or paste.
 */
export const XTERM_RIGHT_CLICK_OPTIONS = {
  rightClickSelectsWord: false,
} as const;

export type TerminalRightClickIntent =
  | { kind: 'copy'; selection: string }
  | { kind: 'paste' }
  | { kind: 'menu'; selection: string };

/** Resolve one right click from the selection that existed when it occurred. */
export function terminalRightClickIntent(
  action: RightClickAction,
  selection: string,
): TerminalRightClickIntent {
  if (action === 'menu') return { kind: 'menu', selection };
  if (action === 'copy-paste' && selection) return { kind: 'copy', selection };
  return { kind: 'paste' };
}
