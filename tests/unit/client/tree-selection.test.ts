import { describe, expect, it } from 'vitest';
import type { VisibleNode } from '../../../client/src/host-tree.js';
import {
  rangeSelection,
  toggleSelection,
  visibleHostKeys,
} from '../../../client/src/components/sidebar/tree-selection.js';

/** Only the fields selection reads; the node payload is irrelevant here. */
function row(key: string, kind: 'host' | 'folder'): VisibleNode {
  return { node: { kind, key } as never, key, depth: 0, level: 1, posInSet: 1, setSize: 1, ancestors: [] };
}

/** Folders interleave with hosts; a range runs through them and skips them. */
const ROWS: VisibleNode[] = [
  row('prod', 'folder'),
  row('a', 'host'),
  row('b', 'host'),
  row('lab', 'folder'),
  row('c', 'host'),
  row('d', 'host'),
];

describe('toggleSelection', () => {
  it('adds and removes a host, anchoring the next range on it', () => {
    const added = toggleSelection(new Set(['a']), 'c');
    expect([...added.selection]).toEqual(['a', 'c']);
    expect(added.anchor).toEqual({ key: 'c', base: new Set(['a', 'c']) });

    expect([...toggleSelection(added.selection, 'a').selection]).toEqual(['c']);
  });
});

describe('rangeSelection', () => {
  it('selects the hosts from the anchor to the target, skipping folders', () => {
    const anchor = { key: 'a', base: new Set(['a']) };
    expect([...rangeSelection(ROWS, anchor, 'c')]).toEqual(['a', 'b', 'c']);
  });

  it('works upwards and shrinks again when the target moves back', () => {
    const anchor = { key: 'd', base: new Set(['d']) };
    expect([...rangeSelection(ROWS, anchor, 'b')].sort()).toEqual(['b', 'c', 'd']);
    expect([...rangeSelection(ROWS, anchor, 'c')].sort()).toEqual(['c', 'd']);
  });

  it('keeps what was selected before the anchor was set', () => {
    const anchor = { key: 'c', base: new Set(['a', 'c']) };
    expect([...rangeSelection(ROWS, anchor, 'd')].sort()).toEqual(['a', 'c', 'd']);
  });

  it('starts at the target when the anchor is no longer visible', () => {
    const anchor = { key: 'hidden', base: new Set(['x']) };
    expect([...rangeSelection(ROWS, anchor, 'b')].sort()).toEqual(['b', 'x']);
  });
});

describe('visibleHostKeys', () => {
  it('collects only hosts', () => {
    expect([...visibleHostKeys(ROWS)]).toEqual(['a', 'b', 'c', 'd']);
  });
});
