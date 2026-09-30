import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import TerminalIcon from '@mui/icons-material/Terminal';
import { hostSessionTabs } from '../../host-sessions.js';
import {
  managedHostDisplayName,
  managedHostKey,
  type ManagedHost,
} from '../../managed-hosts.js';
import { IS_MAC } from '../../platform.js';
import { connectManagedHost } from '../../session-actions.js';
import { tabsInOrder, useTabsStore, type SessionTab } from '../../state/tabs.js';
import { terminalHandle } from '../../terminal/terminal-registry.js';
import { hostKindIcon } from '../host-kind-icon.js';

export interface HostSessionsMenuState {
  anchor: HTMLElement;
  host: ManagedHost;
  /** `performance.now()` when the row was clicked. */
  openedAt: number;
}

/**
 * The second click of a double-click lands on the menu's backdrop. Treating it
 * as "click away" would shut the menu before it was ever seen, so a backdrop
 * click this soon after opening is ignored.
 */
const DOUBLE_CLICK_GRACE_MS = 500;

/** Output lines shown per session: enough to tell same-named sessions apart. */
const PREVIEW_LINES = 2;

const MONO_FONT = '"JetBrains Mono", monospace';

const STATUS_COLOR: Record<SessionTab['status'], string> = {
  connected: 'success.main',
  connecting: 'warning.main',
  interrupted: 'warning.main',
  closed: 'text.disabled',
};

function statusDetail(tab: SessionTab): string | undefined {
  switch (tab.status) {
    case 'connected':
      return tab.terminalCwd;
    case 'connecting':
      return 'Connecting…';
    case 'interrupted':
      return tab.failureReason ?? 'Connection interrupted';
    case 'closed':
      return 'Disconnected — select to reconnect';
  }
}

/**
 * Clicking a host that already has sessions in this window lists them, the way
 * a taskbar button lists an app's open windows: pick one to jump to it, or
 * start another. Shift-click or middle-click on the row skips the list.
 */
export function HostSessionsMenu({
  menu,
  placement,
  onClose,
}: {
  menu: HostSessionsMenuState | null;
  /** Side the menu opens on, toward the panes. */
  placement: 'left' | 'right';
  onClose: () => void;
}) {
  const tabs = useTabsStore((s) => s.tabs);
  const root = useTabsStore((s) => s.root);
  const activeId = useTabsStore((s) => s.activeId);
  const hostKey = menu ? managedHostKey(menu.host) : undefined;
  const sessions = useMemo(
    () => (hostKey ? hostSessionTabs(root, tabs, hostKey) : []),
    [root, tabs, hostKey],
  );
  // The numbers the tab strips show, which Alt+N also answers to.
  const tabNumbers = useMemo(
    () => new Map(tabsInOrder(root, tabs).map((tab, index) => [tab.id, index + 1])),
    [root, tabs],
  );

  const jumpTo = (tab: SessionTab) => {
    onClose();
    const state = useTabsStore.getState();
    state.activate(tab.id);
    if (tab.status === 'closed') state.reconnect([tab.id]);
    // After the menu hands focus back to the row it was opened from.
    requestAnimationFrame(() => terminalHandle(tab.id)?.focus());
  };

  const toward = placement === 'right' ? 'right' : 'left';
  const away = placement === 'right' ? 'left' : 'right';
  const hostName = menu ? managedHostDisplayName(menu.host) : '';

  return (
    <Menu
      open={!!menu}
      anchorEl={menu?.anchor}
      anchorOrigin={{ vertical: 'top', horizontal: toward }}
      transformOrigin={{ vertical: 'top', horizontal: away }}
      onClose={(_event, reason) => {
        if (
          reason === 'backdropClick' &&
          menu &&
          performance.now() - menu.openedAt < DOUBLE_CLICK_GRACE_MS
        ) {
          return;
        }
        onClose();
      }}
      slotProps={{
        // Pressing on the backdrop would drop focus to the page, leaving a menu
        // kept open by the grace period above deaf to Escape and arrow keys.
        backdrop: { onMouseDown: (event) => event.preventDefault() },
        list: { 'aria-label': `Open sessions on ${hostName}`, dense: true },
        paper: { sx: { minWidth: 260, maxWidth: 380, maxHeight: 'min(560px, 80vh)' } },
      }}
    >
      <ListSubheader
        sx={{
          lineHeight: '28px',
          fontSize: 11,
          fontWeight: 500,
          color: 'text.secondary',
          bgcolor: 'background.paper',
        }}
      >
        {sessions.length === 1 ? '1 open session' : `${sessions.length} open sessions`}
      </ListSubheader>
      {sessions.map((tab) => {
        const Icon =
          tab.profile.kind === 'local' ? TerminalIcon : hostKindIcon(tab.profile.kind);
        const detail = statusDetail(tab);
        const preview = terminalHandle(tab.id)?.recentLines(PREVIEW_LINES) ?? [];
        const current = tab.id === activeId;
        return (
          <MenuItem
            key={tab.id}
            selected={current}
            aria-current={current ? 'page' : undefined}
            onClick={() => jumpTo(tab)}
            sx={{ alignItems: 'flex-start', gap: 1.25, py: 0.75 }}
          >
            <Box sx={{ position: 'relative', display: 'flex', flexShrink: 0, mt: '2px' }}>
              <Icon sx={{ fontSize: 16, color: tab.color ?? 'text.secondary' }} />
              <Box
                sx={{
                  position: 'absolute',
                  right: -3,
                  bottom: -2,
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  bgcolor: STATUS_COLOR[tab.status],
                  boxShadow: (theme) => `0 0 0 2px ${theme.palette.background.paper}`,
                  ...(tab.status === 'connecting' && {
                    animation: 'muxus-pulse 1.2s ease-in-out infinite',
                    '@keyframes muxus-pulse': { '50%': { opacity: 0.3 } },
                  }),
                }}
              />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
                <Typography
                  component="span"
                  noWrap
                  sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 450 }}
                >
                  {tab.title}
                </Typography>
                <Typography
                  component="span"
                  sx={{ flexShrink: 0, fontSize: 11, color: 'text.secondary' }}
                >
                  {current ? 'Current tab' : `Tab ${tabNumbers.get(tab.id) ?? ''}`}
                </Typography>
              </Box>
              {detail ? (
                <Typography
                  component="div"
                  noWrap
                  title={detail}
                  sx={{ fontSize: 11.5, color: 'text.secondary' }}
                >
                  {detail}
                </Typography>
              ) : null}
              {preview.length > 0 ? (
                <Box
                  aria-hidden
                  sx={{
                    mt: 0.5,
                    px: 0.75,
                    py: 0.25,
                    borderRadius: 0.75,
                    bgcolor: 'action.hover',
                    fontFamily: MONO_FONT,
                    fontSize: 10.5,
                    lineHeight: 1.5,
                    color: 'text.secondary',
                  }}
                >
                  {preview.map((line, index) => (
                    <Box
                      key={index}
                      sx={{ whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {line}
                    </Box>
                  ))}
                </Box>
              ) : null}
            </Box>
          </MenuItem>
        );
      })}
      <Divider />
      <MenuItem
        onClick={() => {
          const host = menu?.host;
          onClose();
          if (host) connectManagedHost(host);
        }}
        sx={{ gap: 1.25 }}
      >
        <ListItemIcon sx={{ minWidth: 'auto !important' }}>
          <AddIcon sx={{ fontSize: 16 }} />
        </ListItemIcon>
        <Typography component="span" sx={{ flex: 1, fontSize: 13 }}>
          New session
        </Typography>
        <Typography component="span" sx={{ fontSize: 11, color: 'text.secondary' }}>
          {IS_MAC ? '⇧ Click' : 'Shift+Click'}
        </Typography>
      </MenuItem>
    </Menu>
  );
}
