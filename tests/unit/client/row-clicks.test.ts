import { describe, expect, it } from 'vitest';
import {
  clickOpensRow,
  hostClickOutcome,
  type HostActivation,
} from '../../../client/src/components/sidebar/row-clicks.js';

/** A plain left click; `clicks` is the event's detail. */
function click(clicks: number, modifiers: Partial<HostActivation> = {}): HostActivation {
  return {
    newSession: false,
    repeat: clicks > 1,
    clicks,
    toggleSelection: false,
    extendSelection: false,
    ...modifiers,
  };
}

const shiftClick = (clicks: number) =>
  click(clicks, { newSession: true, extendSelection: true });
const ctrlClick = (clicks: number) => click(clicks, { toggleSelection: true });
const middleClick: HostActivation = { newSession: true, repeat: false };

describe('sidebar rows opening on a single click', () => {
  it('opens on every click, as before', () => {
    for (const clicks of [0, 1, 2, 3]) expect(clickOpensRow(clicks, 'click')).toBe(true);
  });

  it('connects a host on a plain click and on the second click of a double-click', () => {
    expect(hostClickOutcome(click(1), 'click', false)).toBe('open');
    expect(hostClickOutcome(click(2), 'click', false)).toBe('open');
  });

  it('keeps Ctrl/Cmd-click for the selection', () => {
    expect(hostClickOutcome(ctrlClick(1), 'click', false)).toBe('toggle');
  });

  it('extends a selection with Shift-click, and opens another session without one', () => {
    expect(hostClickOutcome(shiftClick(1), 'click', true)).toBe('extend');
    expect(hostClickOutcome(shiftClick(1), 'click', false)).toBe('open');
  });
});

describe('sidebar rows opening on a double-click', () => {
  it('opens on the second click and on Enter or Space, never on the first click', () => {
    expect(clickOpensRow(1, 'double-click')).toBe(false);
    expect(clickOpensRow(2, 'double-click')).toBe(true);
    expect(clickOpensRow(0, 'double-click')).toBe(true);
  });

  it('does not open again on the third click of a triple-click', () => {
    expect(clickOpensRow(3, 'double-click')).toBe(false);
    expect(hostClickOutcome(click(3), 'double-click', true)).toBe('ignore');
  });

  it('selects a host on a single click and connects it on the second', () => {
    expect(hostClickOutcome(click(1), 'double-click', false)).toBe('select');
    expect(hostClickOutcome(click(1), 'double-click', true)).toBe('select');
    expect(hostClickOutcome(click(2), 'double-click', true)).toBe('open');
  });

  it('toggles with Ctrl/Cmd-click and extends with Shift-click even with nothing selected', () => {
    expect(hostClickOutcome(ctrlClick(1), 'double-click', false)).toBe('toggle');
    expect(hostClickOutcome(shiftClick(1), 'double-click', false)).toBe('extend');
    expect(hostClickOutcome(shiftClick(1), 'double-click', true)).toBe('extend');
  });

  it('opens a modified double-click, so Shift-double-click still starts another session', () => {
    expect(hostClickOutcome(shiftClick(2), 'double-click', true)).toBe('open');
    expect(hostClickOutcome(ctrlClick(2), 'double-click', true)).toBe('open');
  });

  it('leaves the keyboard and middle-click as they were', () => {
    expect(hostClickOutcome(click(0), 'double-click', true)).toBe('open');
    expect(hostClickOutcome(shiftClick(0), 'double-click', true)).toBe('extend');
    expect(hostClickOutcome(shiftClick(0), 'double-click', false)).toBe('open');
    expect(hostClickOutcome(middleClick, 'double-click', true)).toBe('open');
    expect(
      hostClickOutcome({ newSession: false, repeat: false, toggleSelection: true }, 'double-click', false),
    ).toBe('toggle');
  });
});
