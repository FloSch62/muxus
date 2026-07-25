import type { DragEvent, MouseEvent, ReactNode } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ListItemButton from '@mui/material/ListItemButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import type { VisibleNode } from '../../host-tree.js';
import { folderIcon } from './folder-icons.js';
import { TREE_BASE_INSET, indentPx, treeRowSx } from './tree-row-style.js';

export interface FolderRowProps {
  row: VisibleNode;
  /** Label to draw; folders show their last segment, file groups their name. */
  label: string;
  tooltip?: string;
  count: number;
  color?: string;
  iconId?: string;
  focused: boolean;
  /** Highlight the whole row as the "drop inside this folder" target. */
  dropInto?: boolean;
  /** Draw the insertion line above or below, for a "place beside" drop. */
  dropEdge?: 'before' | 'after';
  onToggle: () => void;
  /** Alt+Arrow reorder, the keyboard equivalent of dragging this folder. */
  onMove?: (delta: -1 | 1) => void;
  onLaunch: () => void;
  onMenu?: (anchor: HTMLElement, position?: { top: number; left: number }) => void;
  registerRef: (element: HTMLElement | null) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}

/**
 * A folder is a treeitem, not a list subheader: it has to be focusable, carry
 * aria-expanded, and take drops. The uppercase subheader treatment goes with
 * it — at four levels deep, letter-spaced caps stop being readable.
 */
export function FolderRow({
  row,
  label,
  tooltip,
  count,
  color,
  iconId,
  focused,
  dropInto,
  dropEdge,
  onToggle,
  onMove,
  onLaunch,
  onMenu,
  registerRef,
  draggable,
  onDragStart,
  onDragEnd,
  dragging,
}: FolderRowProps) {
  const expanded = row.expanded ?? false;
  const Icon = folderIcon(iconId, expanded);

  /** Actions inside the row must not start a drag or toggle the folder. */
  const swallow = (event: MouseEvent) => event.stopPropagation();

  const content: ReactNode = (
    <ListItemButton
      component="li"
      role="treeitem"
      dense
      ref={registerRef}
      data-node-key={row.key}
      aria-label={label}
      aria-level={row.level}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={expanded}
      aria-selected={focused}
      tabIndex={focused ? 0 : -1}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onToggle}
      aria-keyshortcuts={onMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      onKeyDown={(event) => {
        if (!onMove || !event.altKey) return;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.stopPropagation();
        onMove(event.key === 'ArrowUp' ? -1 : 1);
      }}
      onContextMenu={(event) => {
        if (!onMenu) return;
        event.preventDefault();
        onMenu(event.currentTarget, { top: event.clientY, left: event.clientX });
      }}
      sx={[
        treeRowSx(row.depth, row.railColor),
        {
          gap: 0.5,
          opacity: dragging ? 0.45 : 1,
          '&:hover .folder-action, & .folder-action:focus-visible': { opacity: 1 },
          ...(dropInto && {
            bgcolor: 'action.selected',
            boxShadow: (theme) => `inset 2px 0 ${theme.palette.primary.main}`,
          }),
          ...(dropEdge && {
            [`&::${dropEdge === 'before' ? 'before' : 'after'}`]: {
              content: '""',
              position: 'absolute',
              // Inset to this row's own indent so the line reads as "at this
              // level", not "somewhere in the tree".
              left: indentPx(row.depth),
              right: TREE_BASE_INSET,
              [dropEdge === 'before' ? 'top' : 'bottom']: -1,
              height: 2,
              borderRadius: 2,
              bgcolor: 'primary.main',
              zIndex: 2,
            },
          }),
        },
      ]}
    >
      <ChevronRightIcon
        sx={{
          fontSize: 16,
          flexShrink: 0,
          color: 'text.disabled',
          transition: 'transform 150ms ease',
          transform: expanded || dropInto ? 'rotate(90deg)' : 'none',
        }}
      />
      <Icon sx={{ fontSize: 16, flexShrink: 0, color: color ?? 'text.secondary' }} />
      <Box
        component="span"
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Box>
      <Tooltip title={count > 0 ? `Launch all ${count} hosts…` : ''} disableInteractive>
        <span>
          <IconButton
            className="folder-action"
            size="small"
            tabIndex={-1}
            aria-label={`Launch ${label}`}
            disabled={count === 0}
            onMouseDown={swallow}
            onClick={(event) => {
              swallow(event);
              onLaunch();
            }}
            sx={{ p: 0.125, opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms ease' }}
          >
            <PlayArrowOutlinedIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </span>
      </Tooltip>
      {onMenu && (
        <IconButton
          className="folder-action"
          size="small"
          tabIndex={-1}
          aria-label={`Options for ${label}`}
          onMouseDown={swallow}
          onClick={(event) => {
            swallow(event);
            onMenu(event.currentTarget);
          }}
          sx={{ p: 0.125, opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms ease' }}
        >
          <MoreVertIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
      <Typography
        component="span"
        sx={{ fontSize: 11, color: 'text.disabled', minWidth: 14, textAlign: 'right' }}
      >
        {count}
      </Typography>
    </ListItemButton>
  );

  return tooltip ? (
    <Tooltip title={tooltip} placement="right" enterDelay={600} disableInteractive>
      {content}
    </Tooltip>
  ) : (
    content
  );
}
