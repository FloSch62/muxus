import type { SidebarOpenGesture } from '../../state/prefs.js';

/** How a host row was activated. */
export interface HostActivation {
  /** Shift-click or middle-click: open another session, never list the open ones. */
  newSession: boolean;
  /** The second click of a double-click. */
  repeat: boolean;
  /** The click's `detail`: its count in a multi-click, 0 for Enter or Space. Absent for other gestures. */
  clicks?: number;
  /** Ctrl/Cmd-click: add the host to the selection or take it out instead of connecting. */
  toggleSelection?: boolean;
  /** Shift-click: extends a selection when there is one, else opens a new session. */
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
 * With single-click opening, only Ctrl/Cmd-click and a Shift-click that has a
 * selection to extend stay out of connecting. With double-click opening, the
 * first click is file-manager selection — plain, Ctrl/Cmd or Shift — and the
 * second click opens; anything past a double-click is ignored.
 */
export function hostClickOutcome(
  activation: HostActivation,
  gesture: SidebarOpenGesture,
  hasSelection: boolean,
): HostClickOutcome {
  const selectsOnClick = gesture === 'double-click' && (activation.clicks ?? 0) > 0;
  if (selectsOnClick && activation.clicks !== 1) {
    return activation.clicks === 2 ? 'open' : 'ignore';
  }
  if (activation.toggleSelection) return 'toggle';
  if (activation.extendSelection && (selectsOnClick || hasSelection)) return 'extend';
  return selectsOnClick ? 'select' : 'open';
}
