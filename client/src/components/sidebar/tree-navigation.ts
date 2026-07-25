import type { VisibleNode } from '../../host-tree.js';

export type TreeNavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export type TreeNavAction =
  | { kind: 'focus'; index: number }
  | { kind: 'expand'; key: string }
  | { kind: 'collapse'; key: string }
  | { kind: 'none' };

/**
 * Arrow-key semantics for a flattened tree, per the WAI-ARIA tree pattern.
 * Kept pure so the behaviour is testable without a DOM.
 */
export function treeNavAction(
  nodes: readonly VisibleNode[],
  index: number,
  key: TreeNavKey,
): TreeNavAction {
  if (nodes.length === 0) return { kind: 'none' };
  const current = nodes[index];

  switch (key) {
    case 'ArrowDown':
      return index < nodes.length - 1 ? { kind: 'focus', index: index + 1 } : { kind: 'none' };
    case 'ArrowUp':
      return index > 0 ? { kind: 'focus', index: index - 1 } : { kind: 'none' };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: nodes.length - 1 };
    case 'ArrowRight': {
      if (!current || current.expanded === undefined) return { kind: 'none' };
      if (!current.expanded) return { kind: 'expand', key: current.key };
      // An expanded container's first child is always the next visible row.
      const child = nodes[index + 1];
      return child && child.depth > current.depth
        ? { kind: 'focus', index: index + 1 }
        : { kind: 'none' };
    }
    case 'ArrowLeft': {
      if (!current) return { kind: 'none' };
      if (current.expanded) return { kind: 'collapse', key: current.key };
      const parent = parentIndex(nodes, index);
      return parent < 0 ? { kind: 'none' } : { kind: 'focus', index: parent };
    }
    default:
      return { kind: 'none' };
  }
}

/** Nearest preceding row one level shallower, or -1 at the top level. */
export function parentIndex(nodes: readonly VisibleNode[], index: number): number {
  const depth = nodes[index]?.depth;
  if (depth === undefined || depth === 0) return -1;
  for (let i = index - 1; i >= 0; i--) {
    if (nodes[i]!.depth < depth) return i;
  }
  return -1;
}

/**
 * Type-ahead: the next row after `from` whose label starts with `buffer`,
 * wrapping around. Returns -1 when nothing matches so the caller can leave
 * focus alone rather than jumping to the top.
 */
export function typeAheadIndex(
  labels: readonly string[],
  from: number,
  buffer: string,
): number {
  const needle = buffer.toLocaleLowerCase();
  if (!needle) return -1;
  for (let offset = 1; offset <= labels.length; offset++) {
    const index = (from + offset) % labels.length;
    if (labels[index]!.toLocaleLowerCase().startsWith(needle)) return index;
  }
  // Repeating the same letter cycles; a longer buffer should still match the
  // row already focused rather than reporting no match at all.
  return needle.length > 1 && labels[from]?.toLocaleLowerCase().startsWith(needle) ? from : -1;
}

/**
 * Where focus should land after the visible rows change. Keeping the same key
 * wins; otherwise the row that took its place, clamped to the list.
 */
export function focusAfterChange(
  nodes: readonly VisibleNode[],
  previousKey: string | undefined,
  previousIndex: number,
): string | undefined {
  if (nodes.length === 0) return undefined;
  if (previousKey && nodes.some((node) => node.key === previousKey)) return previousKey;
  const clamped = Math.min(Math.max(previousIndex, 0), nodes.length - 1);
  return nodes[clamped]?.key;
}
