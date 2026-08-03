import { describe, expect, it } from 'vitest';
import { pasteLineNumberWindow } from '../../../client/src/terminal/paste-line-numbers.js';

describe('paste line-number window', () => {
  it('renders at most the visible gutter window for a very large paste', () => {
    const window = pasteLineNumberWindow(1_000_000, 0);

    expect(window.labels.split('\n')).toHaveLength(20);
    expect(window.labels).toMatch(/^1\n2\n/);
    expect(window.labels).toMatch(/\n19\n20$/);
    expect(window.offsetPx).toBe(0);
  });

  it('moves the bounded window to match the editor scroll position', () => {
    const window = pasteLineNumberWindow(1_000_000, 999_980 * 18 + 7);
    const labels = window.labels.split('\n');

    expect(labels).toHaveLength(20);
    expect(labels[0]).toBe('999981');
    expect(labels.at(-1)).toBe('1000000');
    expect(window.offsetPx).toBe(7);
  });

  it('uses the measured editor line height when the interface is scaled', () => {
    const window = pasteLineNumberWindow(1_000, 981 * 21.3571, 21.3571);
    const labels = window.labels.split('\n');

    expect(labels[0]).toBe('982');
    expect(labels.at(-1)).toBe('1000');
    expect(window.offsetPx).toBeCloseTo(0);
  });
});
