import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useTreeKeyboard } from './useTreeKeyboard.js';
import type { LiveCounts } from './useLiveHostCounts.js';

export interface HostTreeProps {
  tree: HostTreeModel;
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

/**
 * The whole host list as a single flat `role="tree"`. One flattened array backs
 * rendering, arrow keys, type-ahead and drop hit-testing, so they can never
 * disagree about what is on screen.
 */
export function HostTree({
  tree,
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
  const refs = useRef(new Map<string, HTMLElement>());
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
  const activeKey = focusedIndex >= 0 ? focusedKey : nodes[0]?.key;

  useEffect(() => {
    if (focusedIndex >= 0) lastIndex.current = focusedIndex;
  }, [focusedIndex]);

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
    if (matchKey) refs.current.get(matchKey)?.scrollIntoView({ block: 'nearest' });
  }, [matchKey, nodes]);

  const focusKey = useCallback((key: string) => {
    setFocusedKey(key);
    const element = refs.current.get(key);
    element?.focus();
    element?.scrollIntoView({ block: 'nearest' });
  }, []);

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

  const registerRef = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) refs.current.set(key, element);
      else refs.current.delete(key);
    },
    [],
  );

  return (
    <Box
      component="ul"
      role="tree"
      aria-label="Hosts"
      // The rows carry the roving tab stop; the container is only ever focused
      // programmatically, never by tabbing.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      {...dnd?.containerProps}
      sx={{ m: 0, p: 0, listStyle: 'none' }}
    >
      {nodes.map((row) => {
        const focused = row.key === activeKey;
        if (row.node.kind === 'host') {
          const host = row.node.host;
          return (
            <HostRow
              key={row.key}
              row={row}
              host={host}
              live={liveByKey.get(row.key)}
              focused={focused}
              match={row.key === matchKey}
              onConnect={() => onConnect(host)}
              onMenu={onHostMenu}
              onMove={(delta) => onMoveHost(row, delta)}
              reorderEnabled={reorderEnabled}
              registerRef={registerRef(row.key)}
              draggable={dnd?.draggable}
              onDragStart={dnd ? (event) => dnd.onDragStart(event, row) : undefined}
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
            onToggle={() => setExpanded(row.key, !expandedFor(row.key))}
            onMove={
              isFolder && reorderEnabled ? (delta) => onMoveFolder(row, delta) : undefined
            }
            onLaunch={() => onLaunch(node)}
            onMenu={
              isFolder
                ? (anchor, position) => onFolderMenu(node, anchor, position)
                : undefined
            }
            registerRef={registerRef(row.key)}
            // ssh_config file groups are defined by the config, not by drags.
            draggable={isFolder && (dnd?.draggable ?? false)}
            onDragStart={
              isFolder && dnd ? (event) => dnd.onDragStart(event, row) : undefined
            }
            onDragEnd={dnd?.onDragEnd}
            dragging={dnd?.isDragging(row.key)}
          />
        );
      })}
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
