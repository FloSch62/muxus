import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import { displayChildren, nodeLabel, type DataNode } from '../../management/data-tree.js';
import { MONO_FONT, valueColorSx, valueText } from './PathText.js';

const ROW_HEIGHT = 26;
const INDENT = 14;
const OVERSCAN = 12;

export interface TreeRow {
  node: DataNode;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  /** The row's parent, for ArrowLeft. */
  parentId?: string;
}

function isBranch(node: DataNode): boolean {
  return node.kind === 'container' || node.kind === 'list' || node.kind === 'entry' || node.kind === 'root';
}

function matches(node: DataNode, needle: string): boolean {
  if (nodeLabel(node).toLowerCase().includes(needle)) return true;
  if (node.kind === 'leaf' || node.kind === 'leaf-list') return valueText(node.value).toLowerCase().includes(needle);
  return false;
}

/**
 * Rows to draw, in order. With a filter, every match shows together with
 * its ancestors, expanded or not.
 */
export function visibleRows(
  root: DataNode,
  expanded: ReadonlySet<string>,
  filter: string,
  showRoot: boolean,
  lazy: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const needle = filter.trim().toLowerCase();
  const keep = new Map<DataNode, boolean>();
  const subtreeMatches = (node: DataNode): boolean => {
    const cached = keep.get(node);
    if (cached !== undefined) return cached;
    let result = matches(node, needle);
    for (const child of node.children) if (subtreeMatches(child)) result = true;
    keep.set(node, result);
    return result;
  };
  const visit = (node: DataNode, depth: number, parentId: string | undefined) => {
    const children = displayChildren(node);
    const expandable = isBranch(node) && (children.length > 0 || (lazy && !node.loaded));
    const open = needle ? true : expanded.has(node.id);
    rows.push({ node, depth, expandable, expanded: expandable && open, parentId });
    if (!open) return;
    for (const child of children) {
      if (needle && !subtreeMatches(child)) continue;
      visit(child, depth + 1, node.id);
    }
  };
  if (showRoot) visit(root, 0, undefined);
  else {
    for (const child of displayChildren(root)) {
      if (needle && !subtreeMatches(child)) continue;
      visit(child, 0, undefined);
    }
  }
  return rows;
}

function KindIcon({ node }: { node: DataNode }) {
  const sx = { fontSize: 14, color: 'text.secondary', flexShrink: 0 } as const;
  if (node.kind === 'list') return <ViewListOutlinedIcon sx={sx} />;
  if (node.kind === 'entry') return <LabelOutlinedIcon sx={sx} />;
  if (node.kind === 'container' || node.kind === 'root') return <DataObjectOutlinedIcon sx={sx} />;
  return (
    <Box
      component="span"
      sx={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0, color: 'text.disabled' }}
    >
      <Box component="span" sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'currentColor' }} />
    </Box>
  );
}

interface RowProps {
  row: TreeRow;
  selected: boolean;
  loading: boolean;
  error?: string;
  onToggle: (row: TreeRow) => void;
  onSelect: (row: TreeRow) => void;
  onActivate?: (node: DataNode) => void;
  onContextMenu?: (node: DataNode, event: MouseEvent) => void;
  actions?: ReactNode;
  highlight: string;
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <Box component="mark" sx={(theme) => ({ bgcolor: alpha(theme.palette.warning.main, 0.35), color: 'inherit', borderRadius: 0.5 })}>
        {text.slice(index, index + needle.length)}
      </Box>
      {text.slice(index + needle.length)}
    </>
  );
}

const Row = memo(function Row({
  row,
  selected,
  loading,
  error,
  onToggle,
  onSelect,
  onActivate,
  onContextMenu,
  actions,
  highlight,
}: RowProps) {
  const { node } = row;
  const leaf = node.kind === 'leaf' || node.kind === 'leaf-list';
  const label = nodeLabel(node);
  const childCount = node.kind === 'list' ? node.children.length : undefined;
  return (
    <Box
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      data-node-id={node.id}
      title={node.kind === 'entry' ? `Key: ${Object.keys(node.keys ?? {}).join(', ')}${node.guessedKeys ? ' (guessed from the data)' : ''}` : undefined}
      onClick={() => onSelect(row)}
      onDoubleClick={() => (row.expandable ? onToggle(row) : onActivate?.(node))}
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        onSelect(row);
        onContextMenu(node, event);
      }}
      sx={(theme) => ({
        height: ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        pl: `${6 + row.depth * INDENT}px`,
        pr: 0.75,
        cursor: 'default',
        fontSize: 12.5,
        whiteSpace: 'nowrap',
        position: 'relative',
        borderRadius: 1,
        mx: 0.5,
        bgcolor: selected ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.22 : 0.12) : 'transparent',
        '&:hover': {
          bgcolor: selected
            ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.26 : 0.15)
            : theme.palette.action.hover,
        },
        '&:hover .tree-row-actions, & .tree-row-actions:focus-within': { opacity: 1, pointerEvents: 'auto' },
        '& .tree-row-actions': { opacity: 0, pointerEvents: 'none' },
      })}
    >
      <Box
        component="span"
        onClick={(event) => {
          event.stopPropagation();
          if (row.expandable) onToggle(row);
          else onSelect(row);
        }}
        sx={{ width: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      >
        {loading ? (
          <CircularProgress size={11} thickness={6} />
        ) : row.expandable ? (
          <ChevronRightIcon
            sx={{
              fontSize: 16,
              color: 'text.secondary',
              transition: 'transform 120ms ease',
              transform: row.expanded ? 'rotate(90deg)' : 'none',
            }}
          />
        ) : null}
      </Box>
      <KindIcon node={node} />
      <Box
        component="span"
        sx={{
          fontFamily: MONO_FONT,
          fontWeight: node.kind === 'entry' ? 600 : leaf ? 400 : 500,
          color: leaf ? 'text.secondary' : 'text.primary',
          flexShrink: leaf ? 0 : 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: leaf ? '55%' : undefined,
        }}
      >
        <Highlight text={label} needle={highlight} />
      </Box>
      {childCount !== undefined && (
        <Box
          component="span"
          sx={{
            fontSize: 10.5,
            lineHeight: '16px',
            px: 0.75,
            borderRadius: 8,
            bgcolor: 'action.selected',
            color: 'text.secondary',
            flexShrink: 0,
          }}
        >
          {childCount}
        </Box>
      )}
      {leaf && (
        <Box
          component="span"
          title={valueText(node.value)}
          sx={{
            fontFamily: MONO_FONT,
            color: valueColorSx(node.value),
            minWidth: 0,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <Highlight text={valueText(node.value) || '""'} needle={highlight} />
        </Box>
      )}
      {!leaf && <Box sx={{ flex: 1 }} />}
      {error && (
        <Tooltip title={error}>
          <ErrorOutlineIcon sx={{ fontSize: 15, color: 'error.main', flexShrink: 0 }} />
        </Tooltip>
      )}
      {actions && (
        <Box
          className="tree-row-actions"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          sx={(theme) => ({
            // Floats over the row so hidden buttons never take width from the label.
            position: 'absolute',
            right: 4,
            top: 2,
            bottom: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            px: 0.25,
            borderRadius: 1,
            bgcolor: 'background.paper',
            boxShadow: theme.shadows[1],
            transition: 'opacity 100ms ease',
            pointerEvents: 'auto',
          })}
        >
          {actions}
        </Box>
      )}
    </Box>
  );
});

export interface DataTreeViewProps {
  root: DataNode;
  expanded: ReadonlySet<string>;
  /** Bumped whenever the tree or `expanded` change in place. */
  version: number;
  onToggle: (node: DataNode, expand: boolean) => void;
  selectedId?: string;
  onSelect?: (node: DataNode) => void;
  onActivate?: (node: DataNode) => void;
  onContextMenu?: (node: DataNode, event: MouseEvent) => void;
  renderRowActions?: (node: DataNode) => ReactNode;
  loading?: ReadonlySet<string>;
  errors?: ReadonlyMap<string, string>;
  filter?: string;
  showRoot?: boolean;
  /** Branches may have children still to fetch (the explorer). */
  lazy?: boolean;
  empty?: ReactNode;
  ariaLabel: string;
}

/** A virtualized tree for device data: hundreds of thousands of nodes scroll smoothly. */
export function DataTreeView({
  root,
  expanded,
  version,
  onToggle,
  selectedId,
  onSelect,
  onActivate,
  onContextMenu,
  renderRowActions,
  loading,
  errors,
  filter = '',
  showRoot = false,
  lazy = false,
  empty,
  ariaLabel,
}: DataTreeViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [localSelected, setLocalSelected] = useState<string | undefined>(undefined);
  const selected = selectedId ?? localSelected;
  const rows = useMemo(
    () => visibleRows(root, expanded, filter, showRoot, lazy),
    // `version` stands in for in-place changes of the tree and the expanded set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, expanded, filter, showRoot, lazy, version],
  );
  const highlight = filter.trim().toLowerCase();

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const select = useCallback(
    (row: TreeRow) => {
      setLocalSelected(row.node.id);
      onSelect?.(row.node);
    },
    [onSelect],
  );
  const toggle = useCallback((row: TreeRow) => onToggle(row.node, !row.expanded), [onToggle]);

  // Keep the selected row in view when moving with the keyboard.
  const scrollToIndex = (index: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (rows.length === 0) return;
    const index = Math.max(0, rows.findIndex((row) => row.node.id === selected));
    const row = rows[index]!;
    const move = (next: number) => {
      const clamped = Math.min(rows.length - 1, Math.max(0, next));
      select(rows[clamped]!);
      scrollToIndex(clamped);
    };
    switch (event.key) {
      case 'ArrowDown':
        move(selected === undefined ? 0 : index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'PageDown':
        move(index + Math.floor(viewport.height / ROW_HEIGHT));
        break;
      case 'PageUp':
        move(index - Math.floor(viewport.height / ROW_HEIGHT));
        break;
      case 'ArrowRight':
        if (row.expandable && !row.expanded) toggle(row);
        else if (row.expanded) move(index + 1);
        break;
      case 'ArrowLeft':
        if (row.expanded) toggle(row);
        else if (row.parentId !== undefined) {
          const parent = rows.findIndex((candidate) => candidate.node.id === row.parentId);
          if (parent >= 0) move(parent);
        }
        break;
      case 'Enter':
        if (row.expandable) toggle(row);
        else onActivate?.(row.node);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  useEffect(() => {
    // A filter that hides the selection should not leave the view scrolled into nowhere.
    if (scrollRef.current && scrollRef.current.scrollTop > rows.length * ROW_HEIGHT) scrollRef.current.scrollTop = 0;
  }, [rows.length]);

  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);

  return (
    <Box
      ref={scrollRef}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        const element = event.currentTarget;
        setViewport({ top: element.scrollTop, height: element.clientHeight });
      }}
      sx={(theme) => ({
        height: '100%',
        overflow: 'auto',
        outline: 'none',
        py: 0.5,
        '&:focus-visible': { boxShadow: `inset 0 0 0 1px ${alpha(theme.palette.primary.main, 0.5)}` },
      })}
    >
      {rows.length === 0 ? (
        <Box sx={{ p: 2 }}>
          {empty ?? (
            <Typography variant="body2" color="textSecondary">
              {highlight ? 'Nothing matches the filter.' : 'No data.'}
            </Typography>
          )}
        </Box>
      ) : (
        <Box sx={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          <Box sx={{ position: 'absolute', top: start * ROW_HEIGHT, left: 0, right: 0 }}>
            {rows.slice(start, end).map((row) => (
              <Row
                key={row.node.id || '/'}
                row={row}
                selected={row.node.id === selected}
                loading={loading?.has(row.node.id) ?? false}
                error={errors?.get(row.node.id)}
                onToggle={toggle}
                onSelect={select}
                onActivate={onActivate}
                onContextMenu={onContextMenu}
                actions={renderRowActions?.(row.node)}
                highlight={highlight}
              />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
