import { describe, expect, it } from 'vitest';
import { pointInsideAnyWindow } from '../../../desktop/src/tab-detach.js';

describe('native tab detach bounds', () => {
  const windows = [
    { x: 100, y: 50, width: 800, height: 600 },
    { x: 1_000, y: 100, width: 500, height: 400 },
  ];

  it('recognizes points inside either Muxus window', () => {
    expect(pointInsideAnyWindow({ x: 100, y: 50 }, windows)).toBe(true);
    expect(pointInsideAnyWindow({ x: 899, y: 649 }, windows)).toBe(true);
    expect(pointInsideAnyWindow({ x: 1_250, y: 300 }, windows)).toBe(true);
  });

  it('leaves outer edges and desktop points available for detaching', () => {
    expect(pointInsideAnyWindow({ x: 900, y: 300 }, windows)).toBe(false);
    expect(pointInsideAnyWindow({ x: 1_500, y: 300 }, windows)).toBe(false);
    expect(pointInsideAnyWindow({ x: 50, y: 20 }, windows)).toBe(false);
  });
});
