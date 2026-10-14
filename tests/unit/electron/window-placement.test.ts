import { describe, expect, it } from 'vitest';
import { parseWindowPlacement, windowBounds } from '../../../electron/src/window-placement.js';

const laptop = { x: 0, y: 0, width: 1920, height: 1080 };
const monitor = { x: 1920, y: -200, width: 2560, height: 1400 };
const size = { width: 1000, height: 720 };

describe('settings window placement', () => {
  it('opens centered over the app window', () => {
    const owner = { x: 2000, y: 0, width: 1600, height: 1000 };
    expect(windowBounds(size, owner, [laptop, monitor])).toEqual({
      x: 2300,
      y: 140,
      width: 1000,
      height: 720,
    });
  });

  it('opens at the size it was left, still centered over the app window', () => {
    const owner = { x: 100, y: 100, width: 1400, height: 900 };
    expect(windowBounds({ width: 900, height: 700, maximized: true }, owner, [laptop])).toEqual({
      x: 350,
      y: 200,
      width: 900,
      height: 700,
    });
  });

  it('keeps a centered window inside the display of a window near its edge', () => {
    const owner = { x: -300, y: 900, width: 800, height: 600 };
    expect(windowBounds(size, owner, [laptop])).toEqual({
      x: 0,
      y: 360,
      width: 1000,
      height: 720,
    });
  });

  it('shrinks a window larger than the display to fit the work area', () => {
    const owner = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(windowBounds({ width: 2400, height: 1300 }, owner, [laptop])).toEqual(laptop);
  });

  it('leaves the position to the system when there is nothing to place against', () => {
    expect(windowBounds({ ...size, maximized: true }, undefined, [laptop])).toEqual(size);
  });

  it('reads only well-formed stored placements', () => {
    expect(parseWindowPlacement({ width: 900, height: 700, maximized: true })).toEqual({
      width: 900,
      height: 700,
      maximized: true,
    });
    expect(parseWindowPlacement({ width: 900, height: 700, maximized: 'yes' })).toEqual({
      width: 900,
      height: 700,
    });
    // Placements saved by earlier versions also carry a position, which is dropped.
    expect(parseWindowPlacement({ x: 10, y: 20, width: 900, height: 700 })).toEqual({
      width: 900,
      height: 700,
    });
    expect(parseWindowPlacement({ width: 0, height: 700 })).toBeUndefined();
    expect(parseWindowPlacement({ width: '900', height: 700 })).toBeUndefined();
    expect(parseWindowPlacement({ width: 900, height: Number.NaN })).toBeUndefined();
    expect(parseWindowPlacement([900, 700])).toBeUndefined();
    expect(parseWindowPlacement(null)).toBeUndefined();
  });
});
