import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  folderKey,
  rootFolderKeys,
  siblingFolderKeys,
  siblingHostKeys,
  TREE_ROOT_KEY,
  type HostTree,
  type VisibleNode,
} from '../../host-tree.js';
import type { TreeDndBinding } from './HostTree.js';
import {
  canDrop,
  containerFor,
  dragSourceForRow,
  dropTargetForRow,
  droppedFolderPath,
  folderOrderAfterDrop,
  isPureReorder,
  sameTarget,
  targetPath,
  type DragSource,
  type DropTarget,
} from './tree-dnd.js';

/** Where a dragged folder lands among its new siblings. */
export interface FolderPlacement {
  parentKey: string;
  keys: string[];
}

/** Long enough not to fire while passing over, short enough to feel intentional. */
const AUTO_EXPAND_MS = 500;

export interface TreeDndOptions {
  tree: HostTree;
  enabled: boolean;
  /**
   * Settle a host's order among its new siblings. `path` is the folder it moves
   * into ('' clears the folder); `undefined` means the container did not change
   * and only the order should be written.
   */
  onDropHost: (hostKey: string, path: string | undefined, siblingOrder: string[]) => void;
  /**
   * Re-parent a whole folder subtree, and settle its position among its new
   * siblings when the drop named one. `fromPath === toPath` is a pure reorder.
   */
  onDropFolder: (fromPath: string, toPath: string, placement?: FolderPlacement) => void;
  hostOrderAfterDrop: (
    keys: readonly string[],
    sourceKey: string,
    targetKey: string | undefined,
    edge: 'before' | 'after',
  ) => string[];
}

export interface TreeDnd {
  binding: TreeDndBinding | undefined;
  /** Rendered by the sidebar under the tree while a drag is in flight. */
  dragging: boolean;
}

/**
 * Drag and drop for the host tree.
 *
 * One set of listeners lives on the tree container rather than on every row:
 * per-row dragleave handlers flicker as the pointer crosses child elements, and
 * a few hundred of them is a lot of listeners for a list this long.
 */
export function useTreeDnd({
  tree,
  enabled,
  onDropHost,
  onDropFolder,
  hostOrderAfterDrop,
}: TreeDndOptions): TreeDnd {
  const [source, setSource] = useState<DragSource | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [dragExpanded, setDragExpanded] = useState<ReadonlySet<string>>(new Set());
  const rowsRef = useRef<readonly VisibleNode[]>([]);
  const expandTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clearTimer = () => {
    if (expandTimer.current === undefined) return;
    clearTimeout(expandTimer.current);
    expandTimer.current = undefined;
  };

  const reset = useCallback(() => {
    clearTimer();
    setSource(null);
    setTarget(null);
    // Folders opened only to look inside during a drag close again: an
    // accidental hover must not permanently change what the sidebar shows.
    setDragExpanded(new Set());
  }, []);

  useEffect(() => clearTimer, []);

  /**
   * Which row the pointer is over, resolved purely from geometry.
   *
   * `event.target` is not trustworthy during a drag: Chrome keeps reporting the
   * element the drag last settled on, so a pointer sitting over one row can
   * arrive carrying another. Measuring against the rows' own boxes is the only
   * reading that always matches what the user sees under the cursor.
   */
  const rowFromEvent = useCallback(
    (event: DragEvent<HTMLElement>): { row: VisibleNode; ratio: number } | undefined => {
      const element = nearestRow(event.currentTarget, event.clientY);
      if (!element) return undefined;
      const row = rowsRef.current.find((candidate) => candidate.key === element.dataset.nodeKey);
      if (!row) return undefined;
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0) return { row, ratio: 0.5 };
      // Clamped only for the couple of pixels of gap between adjacent rows.
      const ratio = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
      return { row, ratio };
    },
    [],
  );

  const onDragStart = useCallback((event: DragEvent<HTMLElement>, row: VisibleNode) => {
    const next = dragSourceForRow(row);
    if (!next) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    // getData is unreadable during dragover in every browser, so the source
    // lives in state; this payload is only for the drag image and stray drops.
    event.dataTransfer.setData('text/plain', row.key);
    setSource(next);
    setTarget(null);
  }, []);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!source) return;
      const hit = rowFromEvent(event);
      const next = hit ? dropTargetForRow(hit.row, hit.ratio) : { kind: 'root' as const };
      if (!next || !canDrop(source, next, tree)) {
        clearTimer();
        setTarget((current) => (current ? null : current));
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setTarget((current) => (sameTarget(current, next) ? current : next));

      // Hovering a collapsed folder opens it so its children become targets.
      if (next.kind !== 'into-folder' || dragExpanded.has(next.folderKey)) return;
      const row = rowsRef.current.find((candidate) => candidate.key === next.folderKey);
      if (row?.expanded !== false) return;
      if (expandTimer.current !== undefined) return;
      expandTimer.current = setTimeout(() => {
        expandTimer.current = undefined;
        setDragExpanded((current) => new Set([...current, next.folderKey]));
      }, AUTO_EXPAND_MS);
    },
    [source, tree, rowFromEvent, dragExpanded],
  );

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    clearTimer();
    setTarget(null);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (!source || !target || !canDrop(source, target, tree)) {
        reset();
        return;
      }
      const destination = targetPath(target, tree);

      if (source.kind === 'folder') {
        if (destination !== undefined) {
          const toPath = droppedFolderPath(source, destination);
          // Only an edge drop names a position; dropping inside a folder just
          // joins it and sorts alphabetically among its unplaced siblings.
          let placement: FolderPlacement | undefined;
          if (target.kind === 'folder-edge') {
            const container = containerFor(target, tree);
            placement = {
              parentKey: container ? container.key : TREE_ROOT_KEY,
              keys: folderOrderAfterDrop(
                container ? siblingFolderKeys(container) : rootFolderKeys(tree),
                source.folderKey,
                folderKey(toPath),
                target.folderKey,
                target.edge,
              ),
            };
          }
          onDropFolder(source.path, toPath, placement);
        }
        reset();
        return;
      }

      // The order the host settles into among its new siblings. Dropping onto
      // the folder itself appends; dropping on an edge inserts there.
      const container = containerFor(target, tree);
      const siblings = container ? siblingHostKeys(container) : [];
      const order = hostOrderAfterDrop(
        siblings,
        source.hostKey,
        target.kind === 'host-edge' ? target.hostKey : undefined,
        target.kind === 'host-edge' ? target.edge : 'after',
      );
      onDropHost(source.hostKey, isPureReorder(source, target) ? undefined : destination, order);
      reset();
    },
    [source, target, tree, onDropHost, onDropFolder, hostOrderAfterDrop, reset],
  );

  const observeRows = useCallback((rows: readonly VisibleNode[]) => {
    rowsRef.current = rows;
  }, []);
  const isDragExpanded = useCallback((key: string) => dragExpanded.has(key), [dragExpanded]);
  const isDragging = useCallback(
    (key: string) =>
      !!source && (source.kind === 'host' ? source.hostKey : source.folderKey) === key,
    [source],
  );
  const dropEdgeFor = useCallback(
    (key: string) => {
      if (target?.kind === 'host-edge' && target.hostKey === key) return target.edge;
      if (target?.kind === 'folder-edge' && target.folderKey === key) return target.edge;
      return undefined;
    },
    [target],
  );

  const binding = useMemo<TreeDndBinding | undefined>(
    () =>
      enabled
        ? {
            containerProps: { onDragOver, onDragLeave, onDrop },
            draggable: true,
            onDragStart,
            onDragEnd: reset,
            isDragging,
            dropIntoKey: target?.kind === 'into-folder' ? target.folderKey : undefined,
            dropEdgeFor,
            isDragExpanded,
            observeRows,
            dragging: !!source,
          }
        : undefined,
    [
      enabled,
      onDragOver,
      onDragLeave,
      onDrop,
      onDragStart,
      reset,
      isDragging,
      target,
      dropEdgeFor,
      isDragExpanded,
      observeRows,
      source,
    ],
  );

  return { binding, dragging: !!source };
}

/** The row whose box is closest to `clientY`, within a row's height. */
function nearestRow(container: HTMLElement, clientY: number): HTMLElement | undefined {
  let best: { element: HTMLElement; distance: number } | undefined;
  for (const element of container.querySelectorAll<HTMLElement>('[data-node-key]')) {
    const rect = element.getBoundingClientRect();
    const distance =
      clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    if (!best || distance < best.distance) best = { element, distance };
    if (distance === 0) break;
  }
  // Past the end of the list means the root, not the last row.
  return best && best.distance <= 4 ? best.element : undefined;
}
