import { describe, expect, it } from 'vitest';
import { parseWindowPlacement, windowBounds } from '../../../electron/src/window-placement.js';

const laptop = { x: 0, y: 0, width: 1920, height: 1080 };
const monitor = { x: 1920, y: -200, width: 2560, height: 1400 };
const size = { width: 1000, height: 720 };

describe('settings window placement', () => {
  it('reopens where the window was left, including on a second display', () => {
    const saved = { x: 2400, y: 100, width: 900, height: 700 };
    expect(windowBounds(saved, laptop, [laptop, monitor], size)).toEqual(saved);
  });

  it('moves a window that straddles displays onto the one it overlaps most', () => {
    expect(
      windowBounds({ x: 1300, y: 50, width: 1000, height: 700 }, laptop, [laptop, monitor], size),
    ).toEqual({ x: 920, y: 50, width: 1000, height: 700 });
  });

  it('shrinks a window larger than its display to fit the work area', () => {
    expect(
      windowBounds({ x: 100, y: 100, width: 2400, height: 1300 }, undefined, [laptop], size),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('centers over the app window when the saved display is gone', () => {
    const owner = { x: 100, y: 100, width: 1400, height: 900 };
    expect(
      windowBounds({ x: 2400, y: 100, width: 900, height: 700 }, owner, [laptop], size),
    ).toEqual({ x: 350, y: 200, width: 900, height: 700 });
  });

  it('opens centered over the app window the first time', () => {
    const owner = { x: 2000, y: 0, width: 1600, height: 1000 };
    expect(windowBounds(undefined, owner, [laptop, monitor], size)).toEqual({
      x: 2300,
      y: 140,
      width: 1000,
      height: 720,
    });
  });

  it('keeps a centered window inside the display of a window near its edge', () => {
    const owner = { x: -300, y: 900, width: 800, height: 600 };
    expect(windowBounds(undefined, owner, [laptop], size)).toEqual({
      x: 0,
      y: 360,
      width: 1000,
      height: 720,
    });
  });

  it('leaves the position to the system when there is nothing to place against', () => {
    expect(windowBounds(undefined, undefined, [laptop], size)).toEqual(size);
  });

  it('reads only well-formed stored placements', () => {
    expect(parseWindowPlacement({ x: 10, y: 20, width: 900, height: 700, maximized: true })).toEqual(
      { x: 10, y: 20, width: 900, height: 700, maximized: true },
    );
    expect(parseWindowPlacement({ x: 10, y: 20, width: 900, height: 700, maximized: 'yes' })).toEqual(
      { x: 10, y: 20, width: 900, height: 700 },
    );
    expect(parseWindowPlacement({ x: 10, y: 20, width: 0, height: 700 })).toBeUndefined();
    expect(parseWindowPlacement({ x: '10', y: 20, width: 900, height: 700 })).toBeUndefined();
    expect(parseWindowPlacement({ x: 10, y: Number.NaN, width: 900, height: 700 })).toBeUndefined();
    expect(parseWindowPlacement([10, 20, 900, 700])).toBeUndefined();
    expect(parseWindowPlacement(null)).toBeUndefined();
  });
});
