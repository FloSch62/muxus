import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import { openLocalTerminal } from '../session-actions.js';
import { useTabsStore, type TabStatus } from '../state/tabs.js';
import { layout, statusTextColor } from '../theme.js';

const statusDot: Record<TabStatus, 'warning' | 'success' | 'error'> = {
  connecting: 'warning',
  connected: 'success',
  closed: 'error',
};

/** Browser-style terminal tab strip with a status dot per session. */
export function TabStrip() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);

  return (
    <Stack
      direction="row"
      sx={{
        height: layout.tabStripHeight,
        flexShrink: 0,
        alignItems: 'stretch',
        bgcolor: 'sidebar',
        borderBottom: 1,
        borderColor: 'divider',
        overflowX: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <Stack
            key={tab.id}
            direction="row"
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => activate(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') activate(tab.id);
            }}
            onAuxClick={(e) => {
              // Middle-click closes, the browser-tab convention.
              if (e.button === 1) close(tab.id);
            }}
            sx={{
              alignItems: 'center',
              gap: 0.75,
              px: 1.25,
              minWidth: 0,
              maxWidth: 220,
              cursor: 'pointer',
              userSelect: 'none',
              borderRight: 1,
              borderColor: 'divider',
              bgcolor: active ? 'background.default' : 'transparent',
              borderBottom: active ? 'none' : undefined,
              '&:hover .muxus-tab-close': { visibility: 'visible' },
            }}
          >
            {tab.profile.kind === 'local' ? <TerminalIcon sx={{ fontSize: 15, color: 'text.secondary' }} /> : <DnsOutlinedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />}
            <Typography
              variant="body2"
              noWrap
              sx={{ fontWeight: active ? 600 : 500, color: active ? 'text.primary' : 'text.secondary', flex: 1, minWidth: 0 }}
            >
              {tab.title}
            </Typography>
            <Box
              sx={(theme) => ({
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                bgcolor: statusTextColor(statusDot[tab.status])(theme),
              })}
            />
            <IconButton
              className="muxus-tab-close"
              size="small"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                close(tab.id);
              }}
              sx={{ p: 0.25, visibility: active ? 'visible' : 'hidden' }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
        );
      })}
      <Tooltip title="New local terminal (Ctrl+Shift+T)">
        <IconButton size="small" aria-label="New local terminal" onClick={() => openLocalTerminal()} sx={{ alignSelf: 'center', mx: 0.75 }}>
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
