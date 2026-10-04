import type { VisibleNode } from '../../host-tree.js';

/**
 * Multi-selection rules for the host tree, kept free of React so they can be
 * tested. Only hosts are ever selected; folders are what ranges run through.
 *
 * A range is file-manager style: Ctrl/Cmd-click sets the anchor and fixes the
 * selection around it (the base), and each Shift-click or Shift+Arrow then
 * re-derives base ∪ anchor…target. Moving the target back shrinks the range
 * again instead of leaving every row it ever touched selected.
 */
export interface TreeSelectionAnchor {
  key: string;
  base: ReadonlySet<string>;
}

/** Add a host to the selection, or take it out; it becomes the new anchor. */
export function toggleSelection(
  selection: ReadonlySet<string>,
  key: string,
): { selection: Set<string>; anchor: TreeSelectionAnchor } {
  const next = new Set(selection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return { selection: next, anchor: { key, base: next } };
}

/**
 * The anchor's base plus every host from the anchor to `key` in visible
 * order. An anchor that is no longer visible, such as one inside a folder
 * collapsed since, starts the range at `key` itself.
 */
export function rangeSelection(
  rows: readonly VisibleNode[],
  anchor: TreeSelectionAnchor,
  key: string,
): Set<string> {
  const to = rows.findIndex((row) => row.key === key);
  const anchorIndex = rows.findIndex((row) => row.key === anchor.key);
  const from = anchorIndex >= 0 ? anchorIndex : to;
  const next = new Set(anchor.base);
  if (to < 0) return next;
  const [low, high] = from <= to ? [from, to] : [to, from];
  for (const row of rows.slice(low, high + 1)) {
    if (row.node.kind === 'host') next.add(row.key);
  }
  return next;
}

/** Every visible host, for Ctrl/Cmd+A. */
export function visibleHostKeys(rows: readonly VisibleNode[]): Set<string> {
  return new Set(rows.filter((row) => row.node.kind === 'host').map((row) => row.key));
}
