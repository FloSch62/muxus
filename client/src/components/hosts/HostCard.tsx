import { memo, type DragEvent } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import { alpha } from '@mui/material/styles';
import CheckIcon from '@mui/icons-material/Check';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { managedHostAddress, managedHostDisplayName, type ManagedHost } from '../../managed-hosts.js';
import { EnvironmentBadges } from '../environments/EnvironmentBadges.js';
import { managedHostIcon } from '../host-icon.js';
import type { HostActivation } from '../sidebar/row-clicks.js';
import type { LiveCounts } from '../sidebar/useLiveHostCounts.js';

export const HOST_CARD_HEIGHT = 52;

export interface HostCardProps {
  hostKey: string;
  host: ManagedHost;
  live?: LiveCounts;
  selected: boolean;
  /** The roving tab stop of the list. */
  focused: boolean;
  dragging: boolean;
  onActivate: (host: ManagedHost, anchor: HTMLElement | undefined, gesture: HostActivation) => void;
  onMenu: (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) => void;
  onDragStart: (event: DragEvent<HTMLElement>, hostKey: string) => void;
  onDragEnd: () => void;
  registerRef: (element: HTMLElement | null) => void;
}

/**
 * One host as a card: what it is, what it is called and where it lives. A
 * click follows the sidebar's rules — it connects, or selects where hosts
 * open on a double-click — and the card can be dragged to another folder, to
 * the sidebar, or onto a pane.
 *
 * Memoized, and every callback takes the host it acts on, so the list hands
 * the same functions to every card.
 */
export const HostCard = memo(function HostCard({
  hostKey,
  host,
  live,
  selected,
  focused,
  dragging,
  onActivate,
  onMenu,
  onDragStart,
  onDragEnd,
  registerRef,
}: HostCardProps) {
  const title = managedHostDisplayName(host);
  const address = managedHostAddress(host);
  const color = host.entry.metadata?.color;
  const Icon = managedHostIcon(host);
  const connected = live?.connected ?? 0;
  const connecting = live?.connecting ?? 0;

  return (
    <ButtonBase
      component="div"
      ref={registerRef}
      data-host-key={hostKey}
      aria-label={title}
      aria-pressed={selected}
      tabIndex={focused ? 0 : -1}
      draggable
      onDragStart={(event: DragEvent<HTMLElement>) => onDragStart(event, hostKey)}
      onDragEnd={onDragEnd}
      onClick={(event) =>
        onActivate(host, event.currentTarget, {
          newSession: event.shiftKey && event.detail === 0,
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
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(host, event.currentTarget, { top: event.clientY, left: event.clientX });
      }}
      sx={(theme) => ({
        minWidth: 0,
        height: HOST_CARD_HEIGHT,
        px: 1.25,
        gap: 1.25,
        justifyContent: 'flex-start',
        textAlign: 'left',
        borderRadius: '8px',
        border: '1px solid',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? alpha(theme.palette.primary.main, 0.1) : 'background.paper',
        opacity: dragging ? 0.4 : 1,
        cursor: 'pointer',
        userSelect: 'none',
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${HOST_CARD_HEIGHT}px`,
        transition: 'border-color 120ms ease, background-color 120ms ease, opacity 120ms ease',
        '&:hover': { borderColor: selected ? 'primary.main' : alpha(theme.palette.primary.main, 0.6) },
        '&.Mui-focusVisible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 1,
        },
        '&:hover .host-card-menu, & .host-card-menu:focus-visible': { opacity: 1 },
      })}
    >
      <Box
        sx={{
          position: 'relative',
          width: 30,
          height: 30,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '7px',
          bgcolor: 'action.hover',
        }}
      >
        {selected ? (
          <CheckIcon sx={{ fontSize: 17, color: 'primary.main' }} />
        ) : (
          <Icon sx={{ fontSize: 17, color: color ?? 'text.secondary' }} />
        )}
        {connected + connecting > 0 ? (
          <Box
            sx={(theme) => ({
              position: 'absolute',
              right: -2,
              bottom: -2,
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor: connected > 0 ? 'success.main' : 'warning.main',
              boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
            })}
          />
        ) : null}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          <Box
            component="span"
            sx={{
              minWidth: 0,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: -0.1,
              color: 'text.primary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </Box>
          {connected > 1 ? (
            <Box component="span" sx={{ fontSize: 10, flexShrink: 0, color: 'success.main' }}>
              ×{connected}
            </Box>
          ) : null}
        </Box>
        <Box
          component="span"
          sx={{
            display: 'block',
            fontSize: 11.5,
            letterSpacing: -0.1,
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {address}
        </Box>
      </Box>
      <EnvironmentBadges hostKey={hostKey} />
      <IconButton
        className="host-card-menu"
        size="small"
        tabIndex={-1}
        aria-label={`Options for ${title}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onMenu(host, event.currentTarget);
        }}
        sx={{ flexShrink: 0, p: 0.25, mr: -0.5, opacity: 0, transition: 'opacity 120ms ease' }}
      >
        <MoreVertIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </ButtonBase>
  );
});
