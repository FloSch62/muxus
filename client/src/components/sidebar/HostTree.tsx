import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type Ref,
  type RefObject,
} from 'react';
import Box from '@mui/material/Box';
import {
  flattenVisibleTree,
  type ContainerNode,
  type HostTree as HostTreeModel,
  type VisibleNode,
} from '../../host-tree.js';
import { managedHostDisplayName, type ManagedHost } from '../../managed-hosts.js';
import { FolderRow } from './FolderRow.js';
import { HostRow } from './HostRow.js';
import { focusAfterChange } from './tree-navigation.js';
import { TREE_ROW_GAP, TREE_ROW_HEIGHT, TREE_ROW_PITCH } from './tree-row-style.js';
import {
  TREE_OVERSCAN,
  nextRowWindow,
  renderedRowIndices,
  rowSegments,
  visibleRowSpan,
  type RowWindow,
} from './tree-window.js';
import { useTreeKeyboard } from './useTreeKeyboard.js';
import type { LiveCounts } from './useLiveHostCounts.js';

export interface HostTreeHandle {
  /** Move focus to the first row, scrolling it into view. */
  focusFirst: () => void;
}

export interface HostTreeProps {
  tree: HostTreeModel;
  /** The element that scrolls the tree; rows far outside its viewport are not mounted. */
  scrollContainer: RefObject<HTMLElement | null>;
  ref?: Ref<HostTreeHandle>;
  /** Host the search box would connect on Enter, marked so it can be seen. */
  matchKey?: string;
  isExpanded: (key: string) => boolean;
  setExpanded: (key: string, expanded: boolean) => void;
  folderColor: (key: string) => string | undefined;
  folderIconId: (key: string) => string | undefined;
  liveByKey: Map<string, LiveCounts>;
  reorderEnabled: boolean;
  onConnect: (host: ManagedHost) => void;
  onHostMenu: (
    host: ManagedHost,
    anchor: HTMLElement,
    position?: { top: number; left: number },
  ) => void;
  onFolderMenu: (
    node: ContainerNode,
    anchor: HTMLElement,
    position?: { top: number; left: number },
  ) => void;
  onLaunch: (node: ContainerNode) => void;
  onMoveHost: (row: VisibleNode, delta: -1 | 1) => void;
  onMoveFolder: (row: VisibleNode, delta: -1 | 1) => void;
  onEscape?: () => void;
  /** Drag & drop wiring; absent until the tree is interactive. */
  dnd?: TreeDndBinding;
}

export interface TreeDndBinding {
  containerProps: {
    onDragOver: (event: React.DragEvent<HTMLElement>) => void;
    onDragLeave: (event: React.DragEvent<HTMLElement>) => void;
    onDrop: (event: React.DragEvent<HTMLElement>) => void;
  };
  draggable: boolean;
  onDragStart: (event: React.DragEvent<HTMLElement>, row: VisibleNode) => void;
  onDragEnd: () => void;
  isDragging: (key: string) => boolean;
  dropIntoKey?: string;
  dropEdgeFor: (key: string) => 'before' | 'after' | undefined;
  /** Folders auto-expanded during a drag, on top of the persisted state. */
  isDragExpanded: (key: string) => boolean;
  /** Hit-testing needs the same flattened rows the tree is rendering. */
  observeRows: (rows: readonly VisibleNode[]) => void;
  /** True while something is being dragged, so the root target can be shown. */
  dragging: boolean;
}

/** Enough rows for a tall window before the viewport has been measured. */
function initialRowWindow(): RowWindow {
  const height = typeof window === 'undefined' ? 1080 : window.innerHeight;
  return { start: 0, end: Math.ceil(height / TREE_ROW_PITCH) + TREE_OVERSCAN };
}

/**
 * The whole host list as a single flat `role="tree"`. One flattened array backs
 * rendering, arrow keys, type-ahead and drop hit-testing, so they can never
 * disagree about what is on screen.
 *
 * Only the rows near the viewport are mounted — every row is a handful of MUI
 * components, and a few hundred hosts rendered in full made every sidebar
 * update cost seconds. Rows have a fixed pitch, so spacers stand in for the
 * rest and the scrollbar still spans the whole list. aria-setsize/posinset
 * keep the full size of each level visible to assistive technology.
 */
export function HostTree({
  tree,
  scrollContainer,
  ref,
  matchKey,
  isExpanded,
  setExpanded,
  folderColor,
  folderIconId,
  liveByKey,
  reorderEnabled,
  onConnect,
  onHostMenu,
  onFolderMenu,
  onLaunch,
  onMoveHost,
  onMoveFolder,
  onEscape,
  dnd,
}: HostTreeProps) {
  const [focusedKey, setFocusedKey] = useState<string | undefined>();
  const [rowWindow, setRowWindow] = useState(initialRowWindow);
  const listRef = useRef<HTMLUListElement>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  /** A row focused before it was mounted; focused once it renders. */
  const pendingFocus = useRef<string | undefined>(undefined);
  const lastIndex = useRef(0);

  // Depend on the callback, not on the binding object: an inline `dnd` prop
  // would otherwise re-flatten the whole tree on every parent render.
  const isDragExpanded = dnd?.isDragExpanded;
  const expandedFor = useCallback(
    (key: string) => isExpanded(key) || (isDragExpanded?.(key) ?? false),
    [isExpanded, isDragExpanded],
  );

  const nodes = useMemo(
    () => flattenVisibleTree(tree, expandedFor, folderColor),
    [tree, expandedFor, folderColor],
  );
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const labels = useMemo(
    () =>
      nodes.map((row) =>
        row.node.kind === 'host' ? managedHostDisplayName(row.node.host) : row.node.label,
      ),
    [nodes],
  );

  const focusedIndex = nodes.findIndex((row) => row.key === focusedKey);
  // The first row is the tab stop until something has been focused, so the
  // tree is always reachable with a single Tab.
  const activeIndex = focusedIndex >= 0 ? focusedIndex : nodes.length > 0 ? 0 : -1;
  const activeKey = nodes[activeIndex]?.key;

  useEffect(() => {
    if (focusedIndex >= 0) lastIndex.current = focusedIndex;
  }, [focusedIndex]);

  /** Re-measure which rows the viewport shows; a no-op while the window still covers them. */
  const syncWindow = useCallback(() => {
    const list = listRef.current;
    const scroller = scrollContainer.current;
    if (!list || !scroller) return;
    const scrolledPast = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const visible = visibleRowSpan(
      scrolledPast,
      scroller.clientHeight,
      TREE_ROW_PITCH,
      nodesRef.current.length,
    );
    setRowWindow((current) => nextRowWindow(current, visible));
  }, [scrollContainer]);

  // After every commit: rows above the tree (a quick-connect row, an alert)
  // can move it without any scroll event.
  useLayoutEffect(syncWindow);

  useEffect(() => {
    const scroller = scrollContainer.current;
    if (!scroller) return;
    scroller.addEventListener('scroll', syncWindow, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncWindow);
    resize?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', syncWindow);
      resize?.disconnect();
    };
  }, [scrollContainer, syncWindow]);

  /** Scroll the container just enough to show a row, mounted or not. */
  const scrollToIndex = useCallback(
    (index: number) => {
      const list = listRef.current;
      const scroller = scrollContainer.current;
      if (!list || !scroller) return;
      const top =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        index * TREE_ROW_PITCH;
      if (top < 0) scroller.scrollBy({ top, behavior: 'instant' });
      else if (top + TREE_ROW_HEIGHT > scroller.clientHeight) {
        scroller.scrollBy({ top: top + TREE_ROW_HEIGHT - scroller.clientHeight, behavior: 'instant' });
      }
    },
    [scrollContainer],
  );

  // Drop hit-testing resolves a row key back to its node, so it has to read the
  // same flattened array this component is rendering.
  const observeRows = dnd?.observeRows;
  useEffect(() => observeRows?.(nodes), [observeRows, nodes]);

  // Deleting a host or collapsing its parent must not strand the tab stop on a
  // row that no longer exists.
  useEffect(() => {
    setFocusedKey((current) =>
      current === undefined ? current : focusAfterChange(nodes, current, lastIndex.current),
    );
  }, [nodes]);

  // Scrolling only — focus belongs to the search box the query is being typed
  // into, and taking it would end the search. The rows are a dependency because
  // the winner is scored a keystroke before the filtered tree catches up, so
  // the row to scroll to often does not exist yet on the first run.
  useEffect(() => {
    if (!matchKey) return;
    const index = nodes.findIndex((row) => row.key === matchKey);
    if (index >= 0) scrollToIndex(index);
  }, [matchKey, nodes, scrollToIndex]);

  const focusKey = useCallback(
    (key: string) => {
      const index = nodesRef.current.findIndex((row) => row.key === key);
      if (index >= 0) scrollToIndex(index);
      setFocusedKey(key);
      // A row outside the window mounts on the next commit as the tab stop.
      const element = refs.current.get(key);
      if (element) element.focus({ preventScroll: true });
      else pendingFocus.current = key;
    },
    [scrollToIndex],
  );

  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const element = refs.current.get(key);
    if (!element) return;
    pendingFocus.current = undefined;
    element.focus({ preventScroll: true });
  });

  // A row focused with the mouse becomes the tab stop as well, so it stays
  // mounted — and keeps focus — when the list scrolls it out of the window.
  const followFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-node-key]')?.dataset
      .nodeKey;
    if (key) setFocusedKey(key);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focusFirst: () => {
        const first = nodesRef.current[0];
        if (first) focusKey(first.key);
      },
    }),
    [focusKey],
  );

  const activate = useCallback(
    (row: VisibleNode) => {
      if (row.node.kind === 'host') onConnect(row.node.host);
      else setExpanded(row.key, !expandedFor(row.key));
    },
    [onConnect, setExpanded, expandedFor],
  );

  const onKeyDown = useTreeKeyboard({
    nodes,
    focusedIndex: focusedIndex >= 0 ? focusedIndex : 0,
    focusKey,
    setExpanded,
    activate,
    labels,
    onEscape,
  });

  // One callback per key for the lifetime of the tree: a fresh ref callback on
  // every render would defeat the row memo and re-attach every row's ref.
  const registerRef = useCallback((key: string) => {
    let callback = refCallbacks.current.get(key);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        if (element) refs.current.set(key, element);
        else refs.current.delete(key);
      };
      refCallbacks.current.set(key, callback);
    }
    return callback;
  }, []);

  const toggleFolder = useCallback(
    (row: VisibleNode) => setExpanded(row.key, !expandedFor(row.key)),
    [setExpanded, expandedFor],
  );
  const launchFolder = useCallback(
    (row: VisibleNode) => {
      if (row.node.kind !== 'host') onLaunch(row.node);
    },
    [onLaunch],
  );
  const openFolderMenu = useCallback(
    (row: VisibleNode, anchor: HTMLElement, position?: { top: number; left: number }) => {
      if (row.node.kind !== 'host') onFolderMenu(row.node, anchor, position);
    },
    [onFolderMenu],
  );

  const renderRow = (row: VisibleNode) => {
    const focused = row.key === activeKey;
    if (row.node.kind === 'host') {
      return (
        <HostRow
          key={row.key}
          row={row}
          host={row.node.host}
          live={liveByKey.get(row.key)}
          focused={focused}
          match={row.key === matchKey}
          onConnect={onConnect}
          onMenu={onHostMenu}
          onMove={onMoveHost}
          reorderEnabled={reorderEnabled}
          registerRef={registerRef(row.key)}
          draggable={dnd?.draggable}
          onDragStart={dnd?.onDragStart}
          onDragEnd={dnd?.onDragEnd}
          dragging={dnd?.isDragging(row.key)}
          dropEdge={dnd?.dropEdgeFor(row.key)}
        />
      );
    }

    const node = row.node;
    const isFolder = node.kind === 'folder';
    return (
      <FolderRow
        key={row.key}
        row={row}
        label={node.label}
        tooltip={isFolder ? undefined : node.tooltip}
        count={node.descendantHostCount}
        color={isFolder ? folderColor(row.key) : undefined}
        iconId={isFolder ? folderIconId(row.key) : 'server'}
        focused={focused}
        dropInto={dnd?.dropIntoKey === row.key}
        dropEdge={isFolder ? dnd?.dropEdgeFor(row.key) : undefined}
        onToggle={toggleFolder}
        onMove={isFolder && reorderEnabled ? onMoveFolder : undefined}
        onLaunch={launchFolder}
        onMenu={isFolder ? openFolderMenu : undefined}
        registerRef={registerRef(row.key)}
        // ssh_config file groups are defined by the config, not by drags.
        draggable={isFolder && (dnd?.draggable ?? false)}
        onDragStart={isFolder ? dnd?.onDragStart : undefined}
        onDragEnd={dnd?.onDragEnd}
        dragging={dnd?.isDragging(row.key)}
      />
    );
  };

  const segments = rowSegments(
    renderedRowIndices(rowWindow, nodes.length, activeIndex),
    nodes.length,
  );

  return (
    <Box
      ref={listRef}
      component="ul"
      role="tree"
      aria-label="Hosts"
      // The rows carry the roving tab stop; the container is only ever focused
      // programmatically, never by tabbing.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={followFocus}
      {...dnd?.containerProps}
      sx={{ m: 0, p: 0, listStyle: 'none' }}
    >
      {segments.map((segment, index) =>
        segment.kind === 'row' ? (
          renderRow(nodes[segment.index]!)
        ) : (
          // A spacer carries a row's margins too, so they collapse exactly as
          // the rows it stands in for would and nothing shifts as rows mount.
          <li
            key={`gap-${index}`}
            aria-hidden
            style={{
              height: segment.rows * TREE_ROW_PITCH - TREE_ROW_GAP,
              margin: `${TREE_ROW_GAP}px 0`,
            }}
          />
        ),
      )}
      {dnd?.dragging && (
        <Box
          component="li"
          aria-hidden
          sx={{
            m: '4px 8px 0',
            height: 22,
            borderRadius: 1,
            border: '1px dashed',
            borderColor: 'divider',
            color: 'text.disabled',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          Drop here for no folder
        </Box>
      )}
    </Box>
  );
}
