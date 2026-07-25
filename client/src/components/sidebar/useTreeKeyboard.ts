import { useCallback, useRef, type KeyboardEvent } from 'react';
import type { VisibleNode } from '../../host-tree.js';
import { treeNavAction, typeAheadIndex, type TreeNavKey } from './tree-navigation.js';

const NAV_KEYS = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);

/** Long enough to type a word, short enough that a pause starts a new search. */
const TYPE_AHEAD_RESET_MS = 700;

export interface TreeKeyboardOptions {
  nodes: readonly VisibleNode[];
  focusedIndex: number;
  focusKey: (key: string) => void;
  setExpanded: (key: string, expanded: boolean) => void;
  /** Enter/Space on a row: connect a host, toggle a container. */
  activate: (row: VisibleNode) => void;
  /** Labels aligned with `nodes`, for type-ahead. */
  labels: readonly string[];
  onEscape?: () => void;
}

/**
 * Tree keyboard handling for the container element. Every decision comes from
 * `tree-navigation.ts`; this only owns focus effects and the type-ahead timer.
 */
export function useTreeKeyboard({
  nodes,
  focusedIndex,
  focusKey,
  setExpanded,
  activate,
  labels,
  onEscape,
}: TreeKeyboardOptions) {
  const buffer = useRef({ text: '', at: 0 });

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const index = Math.max(focusedIndex, 0);
      const current = nodes[index];

      if (NAV_KEYS.has(event.key)) {
        // Alt+Arrow is the host reorder shortcut and belongs to the row.
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const action = treeNavAction(nodes, index, event.key as TreeNavKey);
        if (action.kind === 'none') {
          // Still swallow it: an arrow key must never scroll the sidebar out
          // from under the row that has focus.
          event.preventDefault();
          return;
        }
        event.preventDefault();
        if (action.kind === 'focus') focusKey(nodes[action.index]!.key);
        else setExpanded(action.key, action.kind === 'expand');
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        if (!current || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        activate(current);
        return;
      }

      if (event.key === 'Escape') {
        if (!onEscape) return;
        event.preventDefault();
        onEscape();
        return;
      }

      // Type-ahead: single printable characters only, so shortcuts still work.
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      const now = event.timeStamp;
      const fresh = now - buffer.current.at > TYPE_AHEAD_RESET_MS;
      const text = (fresh ? '' : buffer.current.text) + event.key;
      buffer.current = { text, at: now };
      const match = typeAheadIndex(labels, index, text);
      if (match < 0) return;
      event.preventDefault();
      focusKey(nodes[match]!.key);
    },
    [nodes, focusedIndex, focusKey, setExpanded, activate, labels, onEscape],
  );
}
