import type { SidebarOpenGesture } from '../../state/prefs.js';

/** How a host row was activated. */
export interface HostActivation {
  /** Middle-click, Shift+Enter or Shift + double-click: open another session, never list the open ones. */
  newSession: boolean;
  /** The second click of a double-click. */
  repeat: boolean;
  /** The click's `detail`: its count in a multi-click, 0 for Enter or Space. Absent for other gestures. */
  clicks?: number;
  /** Ctrl/Cmd-click: add the host to the selection or take it out instead of connecting. */
  toggleSelection?: boolean;
  /**
   * Shift held: a click selects the range from the last host clicked; from the
   * keyboard it extends a selection when there is one, else opens a new session.
   */
  extendSelection?: boolean;
}

/**
 * Click rules for sidebar rows, kept free of React so they can be tested.
 *
 * `clicks` is the click event's `detail`: 1 and 2 for the two clicks of a
 * double-click, higher for a triple-click, and 0 for the click a row
 * synthesizes for Enter or Space. The keyboard opens under either gesture.
 */
export function clickOpensRow(clicks: number, gesture: SidebarOpenGesture): boolean {
  return gesture === 'click' || clicks === 0 || clicks === 2;
}

/** What a gesture on a host row does. */
export type HostClickOutcome = 'open' | 'toggle' | 'extend' | 'select' | 'ignore';

/**
 * Ctrl/Cmd-click and Shift-click select in either mode; with single-click
 * opening, every other click connects. With double-click opening, the first
 * click is file-manager selection — plain, Ctrl/Cmd or Shift — and the second
 * click opens; anything past a double-click is ignored. From the keyboard,
 * Shift extends a selection that exists and otherwise opens another session.
 */
export function hostClickOutcome(
  activation: HostActivation,
  gesture: SidebarOpenGesture,
  hasSelection: boolean,
): HostClickOutcome {
  const clicks = activation.clicks ?? 0;
  const selectsOnClick = gesture === 'double-click' && clicks > 0;
  if (selectsOnClick && clicks !== 1) return clicks === 2 ? 'open' : 'ignore';
  if (activation.toggleSelection) return 'toggle';
  if (activation.extendSelection && (clicks > 0 || hasSelection)) return 'extend';
  return selectsOnClick ? 'select' : 'open';
}
