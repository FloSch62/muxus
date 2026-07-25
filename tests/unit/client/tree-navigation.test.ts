import { describe, expect, it } from 'vitest';
import type { VisibleNode } from '../../../client/src/host-tree.js';
import {
  focusAfterChange,
  parentIndex,
  treeNavAction,
  typeAheadIndex,
} from '../../../client/src/components/sidebar/tree-navigation.js';

/** Only the fields navigation reads; the node payload is irrelevant here. */
function row(key: string, depth: number, expanded?: boolean): VisibleNode {
  return {
    node: { kind: 'host', key, host: null as never, depth, parentKey: '' },
    key,
    depth,
    level: depth + 1,
    posInSet: 1,
    setSize: 1,
    expanded,
    ancestors: [],
  };
}

/**
 *  0 prod            folder, expanded
 *  1   eu            folder, expanded
 *  2     host-a
 *  3   us            folder, collapsed
 *  4 lab             folder, expanded
 *  5   host-b
 */
const NODES: VisibleNode[] = [
  row('prod', 0, true),
  row('eu', 1, true),
  row('host-a', 2),
  row('us', 1, false),
  row('lab', 0, true),
  row('host-b', 1),
];

describe('treeNavAction', () => {
  it('steps down and up through visible rows and stops at the ends', () => {
    expect(treeNavAction(NODES, 0, 'ArrowDown')).toEqual({ kind: 'focus', index: 1 });
    expect(treeNavAction(NODES, 5, 'ArrowDown')).toEqual({ kind: 'none' });
    expect(treeNavAction(NODES, 3, 'ArrowUp')).toEqual({ kind: 'focus', index: 2 });
    expect(treeNavAction(NODES, 0, 'ArrowUp')).toEqual({ kind: 'none' });
  });

  it('jumps to the first and last visible rows', () => {
    expect(treeNavAction(NODES, 3, 'Home')).toEqual({ kind: 'focus', index: 0 });
    expect(treeNavAction(NODES, 3, 'End')).toEqual({ kind: 'focus', index: 5 });
  });

  it('expands a collapsed folder, then steps into it', () => {
    expect(treeNavAction(NODES, 3, 'ArrowRight')).toEqual({ kind: 'expand', key: 'us' });
    expect(treeNavAction(NODES, 1, 'ArrowRight')).toEqual({ kind: 'focus', index: 2 });
  });

  it('does nothing on a host or an expanded but childless folder', () => {
    expect(treeNavAction(NODES, 2, 'ArrowRight')).toEqual({ kind: 'none' });
    const childless = [row('empty', 0, true), row('sibling', 0, true)];
    expect(treeNavAction(childless, 0, 'ArrowRight')).toEqual({ kind: 'none' });
  });

  it('collapses an expanded folder, otherwise walks to the parent', () => {
    expect(treeNavAction(NODES, 1, 'ArrowLeft')).toEqual({ kind: 'collapse', key: 'eu' });
    expect(treeNavAction(NODES, 2, 'ArrowLeft')).toEqual({ kind: 'focus', index: 1 });
    // A collapsed folder steps out rather than collapsing again.
    expect(treeNavAction(NODES, 3, 'ArrowLeft')).toEqual({ kind: 'focus', index: 0 });
    expect(treeNavAction(NODES, 0, 'ArrowLeft')).toEqual({ kind: 'collapse', key: 'prod' });
  });

  it('has nothing to do in an empty tree', () => {
    expect(treeNavAction([], 0, 'ArrowDown')).toEqual({ kind: 'none' });
  });
});

describe('parentIndex', () => {
  it('finds the nearest shallower row above', () => {
    expect(parentIndex(NODES, 2)).toBe(1);
    expect(parentIndex(NODES, 3)).toBe(0);
    expect(parentIndex(NODES, 5)).toBe(4);
  });

  it('reports no parent at the top level', () => {
    expect(parentIndex(NODES, 0)).toBe(-1);
    expect(parentIndex(NODES, 4)).toBe(-1);
  });
});

describe('typeAheadIndex', () => {
  const labels = ['Production', 'edge-1', 'edge-2', 'Lab'];

  it('finds the next prefix match after the current row', () => {
    expect(typeAheadIndex(labels, 0, 'e')).toBe(1);
    expect(typeAheadIndex(labels, 1, 'e')).toBe(2);
  });

  it('wraps around the end of the list', () => {
    expect(typeAheadIndex(labels, 2, 'e')).toBe(1);
    expect(typeAheadIndex(labels, 3, 'p')).toBe(0);
  });

  it('ignores case', () => {
    expect(typeAheadIndex(labels, 3, 'PROD')).toBe(0);
  });

  it('reports no match rather than moving focus', () => {
    expect(typeAheadIndex(labels, 0, 'zz')).toBe(-1);
    expect(typeAheadIndex(labels, 0, '')).toBe(-1);
  });

  it('keeps the focused row when a growing buffer still matches it', () => {
    // Typing "e", "d", "g" must not hop away from the row it already selected.
    expect(typeAheadIndex(labels, 1, 'edg')).toBe(2);
    expect(typeAheadIndex(labels, 1, 'edge-1')).toBe(1);
  });
});

describe('focusAfterChange', () => {
  it('keeps the focused row when it survives', () => {
    expect(focusAfterChange(NODES, 'host-a', 2)).toBe('host-a');
  });

  it('falls back to whatever took its place', () => {
    expect(focusAfterChange(NODES, 'deleted', 3)).toBe('us');
  });

  it('clamps past the end of a shorter list', () => {
    expect(focusAfterChange(NODES.slice(0, 2), 'deleted', 5)).toBe('eu');
  });

  it('reports nothing to focus in an empty tree', () => {
    expect(focusAfterChange([], 'gone', 0)).toBeUndefined();
  });
});
