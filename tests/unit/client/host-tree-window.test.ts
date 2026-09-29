import { describe, expect, it } from 'vitest';
import {
  liveCountsSignature,
  parseLiveCounts,
} from '../../../client/src/components/sidebar/useLiveHostCounts.js';
import {
  nextRowWindow,
  renderedRowIndices,
  rowSegments,
  visibleRowSpan,
} from '../../../client/src/components/sidebar/tree-window.js';
import type { TerminalTab } from '../../../client/src/state/tabs.js';

describe('visibleRowSpan', () => {
  it('starts at the first row while the list sits below the viewport top', () => {
    // 100px of fixed rows above the tree, a 270px viewport, 27px rows.
    expect(visibleRowSpan(-100, 270, 27, 1000)).toEqual({ start: 0, end: 7 });
  });

  it('covers partially visible rows at both edges', () => {
    expect(visibleRowSpan(40, 100, 27, 1000)).toEqual({ start: 1, end: 6 });
  });

  it('clamps to the list', () => {
    expect(visibleRowSpan(27 * 990, 540, 27, 1000)).toEqual({ start: 990, end: 1000 });
    expect(visibleRowSpan(27 * 2000, 540, 27, 1000)).toEqual({ start: 1000, end: 1000 });
    expect(visibleRowSpan(0, 540, 27, 0)).toEqual({ start: 0, end: 0 });
  });

  it('shows nothing for an unmeasured viewport', () => {
    expect(visibleRowSpan(0, 0, 27, 50)).toEqual({ start: 0, end: 0 });
  });
});

describe('nextRowWindow', () => {
  it('keeps the mounted window while it still covers the viewport', () => {
    const current = { start: 10, end: 60 };
    expect(nextRowWindow(current, { start: 20, end: 40 }, 12)).toBe(current);
    expect(nextRowWindow(current, { start: 10, end: 60 }, 12)).toBe(current);
  });

  it('re-centres with overscan once the viewport leaves it', () => {
    expect(nextRowWindow({ start: 10, end: 60 }, { start: 55, end: 75 }, 12)).toEqual({
      start: 43,
      end: 87,
    });
    expect(nextRowWindow({ start: 10, end: 60 }, { start: 5, end: 25 }, 12)).toEqual({
      start: 0,
      end: 37,
    });
  });
});

describe('renderedRowIndices', () => {
  it('mounts the window, clamped to the rows that exist', () => {
    expect(renderedRowIndices({ start: 3, end: 7 }, 5, 3)).toEqual([3, 4]);
    expect(renderedRowIndices({ start: 0, end: 40 }, 0, -1)).toEqual([]);
  });

  it('keeps the roving tab stop mounted wherever it is', () => {
    expect(renderedRowIndices({ start: 10, end: 13 }, 100, 2)).toEqual([2, 10, 11, 12]);
    expect(renderedRowIndices({ start: 10, end: 13 }, 100, 50)).toEqual([10, 11, 12, 50]);
    expect(renderedRowIndices({ start: 10, end: 13 }, 100, 11)).toEqual([10, 11, 12]);
  });
});

describe('rowSegments', () => {
  it('holds the place of every unmounted row with spacers', () => {
    expect(rowSegments([2, 10, 11], 20)).toEqual([
      { kind: 'gap', rows: 2 },
      { kind: 'row', index: 2 },
      { kind: 'gap', rows: 7 },
      { kind: 'row', index: 10 },
      { kind: 'row', index: 11 },
      { kind: 'gap', rows: 8 },
    ]);
    expect(rowSegments([0, 1], 2)).toEqual([
      { kind: 'row', index: 0 },
      { kind: 'row', index: 1 },
    ]);
  });

  it('always accounts for exactly the whole list', () => {
    for (const [start, end, pinned, count] of [
      [0, 40, 0, 774],
      [300, 350, 12, 774],
      [760, 800, 770, 774],
      [5, 10, 900, 774],
      [0, 40, -1, 0],
    ] as const) {
      const segments = rowSegments(renderedRowIndices({ start, end }, count, pinned), count);
      const rows = segments.reduce(
        (total, segment) => total + (segment.kind === 'gap' ? segment.rows : 1),
        0,
      );
      expect(rows).toBe(count);
    }
  });
});

describe('live host counts', () => {
  /** Only the fields the counts read; profiles carry just what keys them. */
  const tab = (
    id: string,
    status: TerminalTab['status'],
    profile: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
  ) => ({ id, status, profile, title: id, ...extra }) as unknown as TerminalTab;

  it('counts connected and connecting tabs per host', () => {
    const counts = parseLiveCounts(
      liveCountsSignature([
        tab('a', 'connected', { kind: 'ssh', target: 'web' }),
        tab('b', 'connecting', { kind: 'ssh', target: 'web' }),
        tab('c', 'connected', { kind: 'ssh', target: 'db', profileId: 'p1' }),
        tab('d', 'connected', { kind: 'telnet', host: 'sw1', profileId: 'p2' }),
        tab('e', 'closed', { kind: 'ssh', target: 'web' }),
        tab('f', 'connected', { kind: 'local' }),
        tab('g', 'idle', null),
      ]),
    );
    expect(Object.fromEntries(counts)).toEqual({
      'ssh:web': { connected: 1, connecting: 1 },
      'profile:p1': { connected: 1, connecting: 0 },
      'profile:p2': { connected: 1, connecting: 0 },
    });
  });

  it('does not change for tab updates that leave the dots alone', () => {
    const before = liveCountsSignature([
      tab('a', 'connected', { kind: 'ssh', target: 'web' }),
      tab('b', 'connecting', { kind: 'local' }),
    ]);
    // A cwd report, a new title, a local tab connecting and a reorder.
    const after = liveCountsSignature([
      tab('b', 'connected', { kind: 'local' }, { terminalCwd: '/srv' }),
      tab('a', 'connected', { kind: 'ssh', target: 'web' }, { title: 'renamed' }),
      tab('c', 'closed', { kind: 'ssh', target: 'db' }),
    ]);
    expect(after).toBe(before);
  });
});
