import { memo, type DragEvent } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useSavedHostProfiles } from '../../api/queries.js';
import { folderSegments, type VisibleNode } from '../../host-tree.js';
import {
  managedHostAddress,
  managedHostDisplayName,
  type ManagedHost,
} from '../../managed-hosts.js';
import { loadTerminalViewImpl } from '../../lazy-features.js';
import { hostKindIcon } from '../host-kind-icon.js';
import { hostDetailLines } from './host-details.js';
import type { HostActivation } from './row-clicks.js';
import { TREE_BASE_INSET, indentPx, treeLabelSx, treeRowSx } from './tree-row-style.js';
import type { LiveCounts } from './useLiveHostCounts.js';

export interface HostRowProps {
  row: VisibleNode;
  host: ManagedHost;
  live?: LiveCounts;
  focused: boolean;
  /** Part of the multi-selection that bulk actions apply to. */
  selected?: boolean;
  /** The row the search box's Enter would connect. */
  match?: boolean;
  /** Its open-sessions menu is showing. */
  sessionsOpen?: boolean;
  /** Click or Enter: jump to one of the host's sessions, or open a new one. */
  onActivate: (host: ManagedHost, anchor: HTMLElement | undefined, gesture: HostActivation) => void;
  onMenu: (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) => void;
  onMove: (row: VisibleNode, delta: -1 | 1) => void;
  reorderEnabled: boolean;
  /** Side the hover card opens on, toward the panes. */
  hoverPlacement: 'left' | 'right';
  registerRef: (element: HTMLElement | null) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>, row: VisibleNode) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
  dropEdge?: 'before' | 'after';
}

/**
 * One line per host. The address, jump chain, key and forwards are reference
 * material you read rather than act on, so they all live in the hover card and
 * the row spends its width on the name.
 *
 * Memoized, and every callback takes the row or host it acts on, so the tree
 * can pass the same functions to every row and an unrelated update (a tab
 * connecting, the focus moving) re-renders only the rows it touches.
 */
export const HostRow = memo(function HostRow({
  row,
  host,
  live,
  focused,
  selected = false,
  match,
  sessionsOpen,
  onActivate,
  onMenu,
  onMove,
  reorderEnabled,
  hoverPlacement,
  registerRef,
  draggable,
  onDragStart,
  onDragEnd,
  dragging,
  dropEdge,
}: HostRowProps) {
  const title = managedHostDisplayName(host);
  const address = managedHostAddress(host);
  const color = host.entry.metadata?.color;
  const Icon = hostKindIcon(host.kind === 'ssh' ? 'ssh' : host.entry.kind);
  // Saved jump hosts read by name in the hover card.
  const { data: savedData } = useSavedHostProfiles();
  const details = hostDetailLines(host, savedData?.profiles);
  const connected = live?.connected ?? 0;
  const connecting = live?.connecting ?? 0;
  const folderPath = folderSegments(host.entry.metadata?.group);
  const hoverCard = (
    <Stack spacing={0.25} sx={{ py: 0.25 }}>
      {folderPath.length > 0 && (
        <Box sx={{ opacity: 0.6, fontSize: 11 }}>{folderPath.join(' / ')}</Box>
      )}
      <Box sx={{ fontWeight: 600 }}>{title}</Box>
      {address !== title && <Box sx={{ opacity: 0.7 }}>{address}</Box>}
      {details.length > 0 && (
        <Stack spacing={0.25} sx={{ pt: 0.5, opacity: 0.7 }}>
          {details.map((line) => (
            <Box key={line}>{line}</Box>
          ))}
        </Stack>
      )}
    </Stack>
  );

  return (
    <Tooltip
      placement={hoverPlacement}
      enterDelay={400}
      enterNextDelay={200}
      disableInteractive
      // The sessions menu opens on the same side and the card would cover it.
      title={sessionsOpen ? '' : hoverCard}
    >
      <ListItemButton
        component="li"
        role="treeitem"
        dense
        ref={registerRef}
        data-node-key={row.key}
        aria-label={title}
        aria-level={row.level}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-selected={selected}
        selected={selected}
        tabIndex={focused ? 0 : -1}
        aria-keyshortcuts={
          reorderEnabled ? 'Shift+Space Alt+ArrowUp Alt+ArrowDown' : 'Shift+Space'
        }
        draggable={draggable}
        onDragStart={onDragStart ? (event) => onDragStart(event, row) : undefined}
        onDragEnd={onDragEnd}
        onMouseEnter={() => void loadTerminalViewImpl()}
        onFocus={() => void loadTerminalViewImpl()}
        onClick={(event) =>
          onActivate(host, event.currentTarget, {
            newSession: event.shiftKey,
            repeat: event.detail > 1,
            clicks: event.detail,
            toggleSelection: event.ctrlKey || event.metaKey,
            extendSelection: event.shiftKey,
          })
        }
        onMouseDown={(event) => {
          // Middle-click opens a session; it must not start autoscroll first.
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onActivate(host, event.currentTarget, { newSession: true, repeat: false });
        }}
        onKeyUp={(event) => {
          // Shift+Space toggles the selection (Ctrl+Space opens the saved
          // command menu). The row's own Space click is synthesized without
          // modifiers and would connect, so claim the key before it fires.
          if (event.key !== ' ' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
            return;
          }
          event.preventDefault();
          onActivate(host, event.currentTarget, {
            newSession: false,
            repeat: false,
            toggleSelection: true,
          });
        }}
        onKeyDown={(event) => {
          if (!reorderEnabled || !event.altKey) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          event.stopPropagation();
          onMove(row, event.key === 'ArrowUp' ? -1 : 1);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          // The panel offers its own menu on empty space; this row has one.
          event.stopPropagation();
          onMenu(host, event.currentTarget, { top: event.clientY, left: event.clientX });
        }}
        sx={[
          treeRowSx(row.depth, row.railColor),
          {
            gap: 0.75,
            opacity: dragging ? 0.45 : 1,
            cursor: draggable ? 'grab' : 'pointer',
            ...((match || sessionsOpen) && { bgcolor: 'action.selected' }),
            '&:hover .host-row-menu, & .host-row-menu:focus-visible': { opacity: 1 },
            ...(dropEdge && {
              [`&::${dropEdge === 'before' ? 'before' : 'after'}`]: {
                content: '""',
                position: 'absolute',
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
        <Box sx={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
          <Icon sx={{ fontSize: 16, color: color ?? 'text.secondary' }} />
          {connected + connecting > 0 && (
            <Box
              sx={{
                position: 'absolute',
                right: -3,
                bottom: -2,
                width: 7,
                height: 7,
                borderRadius: '50%',
                bgcolor: connected > 0 ? 'success.main' : 'warning.main',
                boxShadow: (theme) => `0 0 0 2px ${theme.palette.sidebar}`,
                ...(connected === 0 && {
                  animation: 'muxus-pulse 1.2s ease-in-out infinite',
                  '@keyframes muxus-pulse': { '50%': { opacity: 0.3 } },
                }),
              }}
            />
          )}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Box component="span" sx={{ ...treeLabelSx, minWidth: 0 }}>
              {title}
            </Box>
            {connected > 1 && (
              <Typography component="span" sx={{ fontSize: 10, flexShrink: 0, color: 'success.main' }}>
                ×{connected}
              </Typography>
            )}
          </Stack>
        </Box>
        {match ? (
          <Typography
            component="span"
            aria-hidden
            sx={{ fontSize: 11, flexShrink: 0, color: 'text.secondary' }}
          >
            ⏎
          </Typography>
        ) : null}
        <IconButton
          className="host-row-menu"
          size="small"
          edge="end"
          tabIndex={-1}
          aria-label={`Options for ${title}`}
          sx={{
            flexShrink: 0,
            p: 0.125,
            opacity: { xs: 1, md: 0 },
            transition: 'opacity 120ms ease',
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onMenu(host, event.currentTarget);
          }}
        >
          <MoreVertIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </ListItemButton>
    </Tooltip>
  );
});
