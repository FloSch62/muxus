import { memo, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import { alpha, type Theme } from '@mui/material/styles';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { useHostStats, type HostStatsSource } from '../api/host-stats.js';
import {
  describeUsers,
  formatBytes,
  formatPercent,
  formatRate,
  formatUptime,
  memoryUsed,
  meterLevel,
  STATUS_BAR_ITEM_LABELS,
  STATUS_BAR_ITEMS,
  withStatusBarItem,
  type HostStatsView,
  type StatusBarItem,
} from '../host-stats.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore, type TerminalTab } from '../state/tabs.js';
import { statusTextColor } from '../theme.js';

export const STATUS_BAR_HEIGHT = 26;

/** The active tab's statistics source, or why it has none. */
function tabSource(tab: TerminalTab | undefined): HostStatsSource | string {
  if (!tab?.profile) return 'No session in this tab';
  const { kind } = tab.profile;
  if (kind !== 'ssh' && kind !== 'local') return 'Statistics are shown for SSH and local sessions';
  if (tab.status !== 'connected') return 'Not connected';
  if (kind === 'local') return { kind: 'local' };
  return tab.connId ? { kind: 'ssh', connId: tab.connId } : 'Not connected';
}

/**
 * The active session's host at a glance, along the bottom of the window:
 * name, system, CPU, memory, disk, traffic, uptime and logins. Only the tab
 * in front is polled; right-click or the tune button picks the items.
 */
export const StatusBar = memo(function StatusBar() {
  const show = usePrefsStore((state) => state.showStatusBar);
  if (!show) return null;
  return <StatusBarContent />;
});

function StatusBarContent() {
  const items = usePrefsStore((state) => state.statusBarItems);
  const setPrefs = usePrefsStore((state) => state.set);
  const activeTab = useTabsStore((state) => state.tabs.find((tab) => tab.id === state.activeId));
  const source = tabSource(activeTab);
  const stats = useHostStats(typeof source === 'string' || items.length === 0 ? undefined : source);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);

  let content: ReactNode;
  if (typeof source === 'string') {
    content = <Muted>{source}</Muted>;
  } else if (items.length === 0) {
    content = <Muted>No statistics selected</Muted>;
  } else if (!stats || stats.status === 'loading') {
    content = <Muted>Reading host statistics…</Muted>;
  } else if (stats.status === 'unsupported') {
    content = (
      <Tooltip
        placement="top"
        title="Muxus reads statistics with a short sh script over the SSH connection. This host did not run it; network devices and Windows servers have no POSIX shell."
      >
        <Box component="span" sx={mutedSx}>
          This host does not report statistics
        </Box>
      </Tooltip>
    );
  } else if (stats.status === 'error') {
    content = (
      <Tooltip placement="top" title={stats.message}>
        <Box component="span" sx={mutedSx}>
          Statistics unavailable
        </Box>
      </Tooltip>
    );
  } else {
    content = (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          minWidth: 0,
          opacity: stats.stale ? 0.55 : 1,
          transition: 'opacity 200ms',
        }}
      >
        {items.map((item) => (
          <StatItem key={item} item={item} view={stats.view} />
        ))}
      </Box>
    );
  }

  return (
    <Box
      component="footer"
      aria-label="Status bar"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ top: event.clientY, left: event.clientX });
      }}
      sx={{
        height: STATUS_BAR_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        pl: 1.5,
        pr: 0.5,
        bgcolor: 'sidebar',
        borderTop: 1,
        borderColor: 'divider',
        fontSize: 12,
        fontWeight: 450,
        letterSpacing: -0.1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
        {content}
      </Box>
      <Tooltip title="Status bar items" placement="top">
        <IconButton
          size="small"
          aria-label="Status bar items"
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ top: rect.top, left: rect.left });
          }}
          sx={{ p: 0.25, color: 'text.secondary' }}
        >
          <TuneOutlinedIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Menu
        open={!!menu}
        anchorReference="anchorPosition"
        anchorPosition={menu ?? undefined}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        onClose={() => setMenu(null)}
      >
        {STATUS_BAR_ITEMS.map((item) => {
          const shown = items.includes(item);
          return (
            <MenuItem
              key={item}
              dense
              role="menuitemcheckbox"
              aria-checked={shown}
              // Stays open, so several items can be switched in one go.
              onClick={() => setPrefs({ statusBarItems: withStatusBarItem(items, item, !shown) })}
            >
              <ListItemIcon>
                {shown ? (
                  <CheckBoxIcon fontSize="small" color="primary" />
                ) : (
                  <CheckBoxOutlineBlankIcon fontSize="small" />
                )}
              </ListItemIcon>
              <ListItemText>{STATUS_BAR_ITEM_LABELS[item]}</ListItemText>
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem
          dense
          onClick={() => {
            setMenu(null);
            setPrefs({ showStatusBar: false });
          }}
        >
          <ListItemIcon>
            <VisibilityOffOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Hide status bar</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}

const mutedSx = { color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis' } as const;

function Muted({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={mutedSx}>
      {children}
    </Box>
  );
}

/** A label in the secondary ink followed by its value. */
function Stat({
  label,
  tooltip,
  meter,
  shrink,
  children,
}: {
  label?: string;
  tooltip: ReactNode;
  meter?: number;
  /** Long free text (a host or system name) gives way first when space runs out. */
  shrink?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip placement="top" title={tooltip}>
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          flexShrink: shrink ? 1 : 0,
          minWidth: shrink ? 24 : undefined,
        }}
      >
        {label ? (
          <Box component="span" sx={{ color: 'text.secondary' }}>
            {label}
          </Box>
        ) : null}
        {meter !== undefined ? <Meter fraction={meter} /> : null}
        <Box
          component="span"
          sx={{ color: 'sidebarInk', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {children}
        </Box>
      </Box>
    </Tooltip>
  );
}

function meterColor(fraction: number) {
  const level = meterLevel(fraction);
  return (theme: Theme) =>
    level === 'critical'
      ? statusTextColor('error')(theme)
      : level === 'warning'
        ? statusTextColor('warning')(theme)
        : alpha(theme.palette.text.secondary, 0.75);
}

/** A small usage bar; neutral until usage gets high. */
function Meter({ fraction }: { fraction: number }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <Box
      aria-hidden
      sx={{
        width: 32,
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        bgcolor: (theme) => alpha(theme.palette.text.secondary, 0.2),
      }}
    >
      <Box
        sx={{
          width: `${clamped * 100}%`,
          height: '100%',
          bgcolor: meterColor(clamped),
          transition: 'width 300ms ease-out',
        }}
      />
    </Box>
  );
}

/** Tooltip lines that exist, on one line. */
function details(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

function StatItem({ item, view }: { item: StatusBarItem; view: HostStatsView }) {
  const { sample } = view;
  switch (item) {
    case 'hostname':
      return sample.hostname ? (
        <Stat shrink tooltip={details(sample.hostname, sample.kernel)}>
          {sample.hostname}
        </Stat>
      ) : null;
    case 'os':
      return sample.os ? (
        <Stat shrink tooltip={sample.kernel ?? sample.os}>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            {sample.os}
          </Box>
        </Stat>
      ) : null;
    case 'cpu': {
      const load = sample.loadAverage
        ? `Load average ${sample.loadAverage.map((value) => value.toFixed(2)).join(' ')}`
        : undefined;
      const cores = sample.cores
        ? `${sample.cores} ${sample.cores === 1 ? 'core' : 'cores'}`
        : undefined;
      if (view.cpu === undefined && !sample.cpuTime && sample.loadAverage) {
        // No CPU counters (macOS and BSD hosts): the load average stands in.
        return (
          <Stat label="Load" tooltip={details(load, cores)}>
            {sample.loadAverage[0].toFixed(2)}
          </Stat>
        );
      }
      if (!sample.cpuTime) return null;
      return (
        <Stat
          label="CPU"
          meter={view.cpu ?? 0}
          tooltip={details(
            view.cpu === undefined ? 'Measuring CPU usage…' : `CPU usage ${formatPercent(view.cpu)}`,
            cores,
            load,
          )}
        >
          {view.cpu === undefined ? '…' : formatPercent(view.cpu)}
        </Stat>
      );
    }
    case 'memory': {
      const memory = sample.memory;
      if (!memory?.totalBytes) return null;
      const used = memoryUsed(memory);
      const { totalBytes, availableBytes, swapTotalBytes, swapFreeBytes } = memory;
      const swap =
        swapTotalBytes && swapFreeBytes !== undefined
          ? `Swap ${formatBytes(swapTotalBytes - swapFreeBytes)} of ${formatBytes(swapTotalBytes)}`
          : undefined;
      return (
        <Stat
          label="RAM"
          meter={used / totalBytes}
          tooltip={details(
            `Memory ${formatBytes(used)} used of ${formatBytes(totalBytes)}, ` +
              `${formatBytes(availableBytes)} available`,
            swap,
          )}
        >
          {formatBytes(used)} / {formatBytes(totalBytes)}
        </Stat>
      );
    }
    case 'disk': {
      const disk = sample.disk;
      if (!disk?.totalBytes) return null;
      // Like df: the share of the space users can have, so root's reserve counts as full.
      const usable = disk.usedBytes + disk.availableBytes;
      const fraction = usable > 0 ? disk.usedBytes / usable : 0;
      return (
        <Stat
          label="Disk"
          meter={fraction}
          tooltip={details(
            disk.mount,
            `${formatBytes(disk.usedBytes)} used of ${formatBytes(disk.totalBytes)}, ` +
              `${formatBytes(disk.availableBytes)} free`,
          )}
        >
          {formatPercent(fraction)}
        </Stat>
      );
    }
    case 'network': {
      const network = sample.network;
      if (!network) return null;
      return (
        <Stat
          tooltip={details(
            network.interface,
            `${formatBytes(network.receivedBytes)} received, ` +
              `${formatBytes(network.sentBytes)} sent since it came up`,
          )}
        >
          <Box component="span" sx={{ color: 'text.secondary' }}>
            ↓
          </Box>{' '}
          {view.receiveRate === undefined ? '…' : formatRate(view.receiveRate)}{' '}
          <Box component="span" sx={{ color: 'text.secondary', ml: 0.75 }}>
            ↑
          </Box>{' '}
          {view.sendRate === undefined ? '…' : formatRate(view.sendRate)}
        </Stat>
      );
    }
    case 'uptime':
      return sample.uptimeSeconds !== undefined ? (
        <Stat
          label="Up"
          tooltip={`Up since ${new Date(Date.now() - sample.uptimeSeconds * 1000).toLocaleString()}`}
        >
          {formatUptime(sample.uptimeSeconds)}
        </Stat>
      ) : null;
    case 'users':
      return sample.users ? (
        <Stat
          label="Users"
          tooltip={sample.users.length > 0 ? describeUsers(sample.users) : 'Nobody is logged in'}
        >
          {sample.users.length}
        </Stat>
      ) : null;
  }
}
