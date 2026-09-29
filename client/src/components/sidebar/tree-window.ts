/**
 * Row windowing for the host tree. Only the rows near the sidebar's viewport
 * are mounted; spacers stand in for the rest, so a list of thousands of hosts
 * costs the same to render as a screenful. Kept pure so the arithmetic is
 * testable without a DOM.
 */

/** Rows mounted beyond each edge of the viewport, so short scrolls render nothing. */
export const TREE_OVERSCAN = 12;

/** A half-open range of flattened row indices: `start` ≤ index < `end`. */
export interface RowWindow {
  start: number;
  end: number;
}

export type RowSegment = { kind: 'row'; index: number } | { kind: 'gap'; rows: number };

/**
 * The rows whose boxes intersect the viewport. `scrolledPast` is how far the
 * list's top edge sits above the viewport's top edge — negative while the list
 * starts further down, below the fixed rows.
 */
export function visibleRowSpan(
  scrolledPast: number,
  viewportHeight: number,
  rowPitch: number,
  rowCount: number,
): RowWindow {
  if (rowCount <= 0 || rowPitch <= 0) return { start: 0, end: 0 };
  const start = Math.min(rowCount, Math.max(0, Math.floor(scrolledPast / rowPitch)));
  const end = Math.min(
    rowCount,
    Math.max(start, Math.ceil((scrolledPast + Math.max(0, viewportHeight)) / rowPitch)),
  );
  return { start, end };
}

/**
 * Keep the mounted window while it still covers what is visible, so scrolling
 * within the overscan re-renders nothing; otherwise re-centre it with overscan
 * on both sides.
 */
export function nextRowWindow(
  current: RowWindow,
  visible: RowWindow,
  overscan = TREE_OVERSCAN,
): RowWindow {
  if (visible.start >= current.start && visible.end <= current.end) return current;
  return { start: Math.max(0, visible.start - overscan), end: visible.end + overscan };
}

/**
 * The row indices to mount, ascending: the window clamped to the list, plus
 * `pinned` — the roving tab stop has to stay in the DOM wherever it is, or
 * Tab could no longer reach the tree and a focused row would drop its focus.
 */
export function renderedRowIndices(
  window: RowWindow,
  rowCount: number,
  pinned: number,
): number[] {
  const start = Math.max(0, Math.min(window.start, rowCount));
  const end = Math.max(start, Math.min(window.end, rowCount));
  const indices: number[] = [];
  if (pinned >= 0 && pinned < start) indices.push(pinned);
  for (let index = start; index < end; index++) indices.push(index);
  if (pinned >= end && pinned < rowCount) indices.push(pinned);
  return indices;
}

/** Interleave mounted rows with spacers that hold the place of everything else. */
export function rowSegments(indices: readonly number[], rowCount: number): RowSegment[] {
  const segments: RowSegment[] = [];
  let next = 0;
  for (const index of indices) {
    if (index > next) segments.push({ kind: 'gap', rows: index - next });
    segments.push({ kind: 'row', index });
    next = index + 1;
  }
  if (rowCount > next) segments.push({ kind: 'gap', rows: rowCount - next });
  return segments;
}
