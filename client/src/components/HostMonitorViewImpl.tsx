import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha, type Theme } from '@mui/material/styles';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ArrowDropUpIcon from '@mui/icons-material/ArrowDropUp';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import SearchIcon from '@mui/icons-material/Search';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import type { MonitoredHost } from '@muxus/shared';
import { retryMonitoredHost, useHostMonitorStore, useHostMonitorStream } from '../api/host-monitor.js';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { copyToClipboard } from '../clipboard.js';
import { environmentHostForManaged, environmentHostForProfile, showHostEnvironments } from '../environments.js';
import { meterLevel } from '../host-stats.js';
import {
  HOST_MONITOR_INTERVALS_MS,
  LATENCY_CRITICAL_MS,
  LATENCY_WARNING_MS,
  MONITOR_COLUMN_HINTS,
  MONITOR_COLUMN_LABELS,
  MONITOR_COLUMNS,
  MONITOR_TEXT_COLUMNS,
  monitorCell,
  monitorIntervalLabel,
  nextMonitorSort,
  sortMonitorRows,
  withMonitorColumn,
  type MonitorColumn,
  type MonitorSortKey,
} from '../host-monitor.js';
import {
  connectKeptHost,
  releaseKeptHosts,
  syncKeptHosts,
  useKeptHostsStore,
} from '../host-monitor-keep.js';
import {
  buildMonitorRows,
  forcedConnections,
  monitorRowMatches,
  type MonitorRow,
} from '../host-monitor-rows.js';
import { groupManagedHosts, managedHostKey } from '../managed-hosts.js';
import { openLocalTerminal, openSessionProfile } from '../session-actions.js';
import type { EnvironmentHost } from '../state/environments.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { layout, statusTextColor } from '../theme.js';
import { AuthPromptDialog, type AuthPromptRequest, type AuthPromptResult } from './AuthPromptDialog.js';
import { LineAction, LineMenu, MONO, type MenuEntry } from './environments/EnvironmentTree.js';
import { useSessionHostIcon } from './host-icon.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';

const ROW_HEIGHT = 30;
/** An ad-hoc target on the keep-connected list, which no sidebar host stands for. */
const TARGET_KEY = 'target:';

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/**
 * The host monitor: this computer and every host Muxus is connected to in
 * one sortable table, read over the connections that already exist. Hosts
 * on the keep-connected list get a connection of their own while the
 * monitor is open; nothing else is ever dialed for it.
 */
export function HostMonitorViewImpl({ visible }: { visible: boolean }) {
  const columns = usePrefsStore((state) => state.monitorColumns);
  const sort = usePrefsStore((state) => state.monitorSort);
  const intervalMs = usePrefsStore((state) => state.monitorIntervalMs);
  const keptKeys = usePrefsStore((state) => state.monitorKeptHosts);
  const setPrefs = usePrefsStore((state) => state.set);
  const hosts = useHostMonitorStore((state) => state.hosts);
  const readings = useHostMonitorStore((state) => state.readings);
  const live = useHostMonitorStore((state) => state.live);
  const keptStates = useKeptHostsStore((state) => state.hosts);
  const { data: config } = useSshConfig();
  const { data: saved } = useSavedHostProfiles();
  const documentVisible = useDocumentVisible();
  const [filter, setFilter] = useState('');
  /** Rows the user told to read although nothing ran a command there yet. */
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null);
  const [keepAnchor, setKeepAnchor] = useState<HTMLElement | null>(null);
  const [dialAuth, setDialAuth] = useState<{
    request: AuthPromptRequest;
    resolve: (result: AuthPromptResult | null) => void;
  } | null>(null);
  const [dialHostKey, setDialHostKey] = useState<{
    request: HostKeyRequest;
    resolve: (accept: boolean) => void;
  } | null>(null);

  const sshHosts = config?.hosts;
  const savedProfiles = saved?.profiles;
  const groups = useMemo(
    () => groupManagedHosts(sshHosts ?? [], savedProfiles ?? [], config?.files ?? [], config?.path),
    [sshHosts, savedProfiles, config?.files, config?.path],
  );
  /** Every SSH host of the sidebar, by key: what the keep-connected list can name. */
  const sidebarHosts = useMemo(() => {
    const byKey = new Map<string, EnvironmentHost>();
    for (const group of groups) {
      for (const host of group.hosts) {
        const environmentHost = environmentHostForManaged(host);
        if (environmentHost) byKey.set(managedHostKey(host), environmentHost);
      }
    }
    return byKey;
  }, [groups]);
  const catalogReady = config !== undefined && saved !== undefined;
  const keptHosts = useMemo(
    () =>
      keptKeys.flatMap((key): EnvironmentHost[] => {
        const host = sidebarHosts.get(key);
        if (host) return [host];
        if (!key.startsWith(TARGET_KEY)) return [];
        const target = key.slice(TARGET_KEY.length);
        return [{ key, label: target, profile: { kind: 'ssh', target } }];
      }),
    [keptKeys, sidebarHosts],
  );

  // The monitor's own connections follow the list, and end with the monitor.
  useEffect(() => {
    if (catalogReady) syncKeptHosts(keptHosts);
  }, [catalogReady, keptHosts]);
  useEffect(() => releaseKeptHosts, []);

  const rows = useMemo(
    () =>
      buildMonitorRows({
        hosts,
        readings,
        keptHosts,
        keptStates,
        resolve: (host: MonitoredHost) =>
          host.target
            ? environmentHostForProfile(
                {
                  kind: 'ssh',
                  target: host.target,
                  ...(host.profileId ? { profileId: host.profileId } : {}),
                  ...(host.useConfig === false ? { useConfig: false } : {}),
                },
                sshHosts ?? [],
                savedProfiles ?? [],
              )
            : undefined,
      }),
    [hosts, readings, keptHosts, keptStates, sshHosts, savedProfiles],
  );
  const force = useMemo(() => forcedConnections(rows, asked), [rows, asked]);

  useHostMonitorStream(
    visible && documentVisible ? { intervalMs, gpu: columns.includes('gpu'), force } : undefined,
  );

  const query = filter.trim().toLowerCase();
  const shown = useMemo(
    () => sortMonitorRows(rows.filter((row) => monitorRowMatches(row, query)), sort),
    [rows, query, sort],
  );
  const remote = rows.filter((row) => !row.local).length;

  // The rows keep these across readings, so only a row whose numbers changed is drawn again.
  const setKept = useCallback((key: string, keep: boolean) => {
    const prefs = usePrefsStore.getState();
    const others = prefs.monitorKeptHosts.filter((entry) => entry !== key);
    prefs.set({ monitorKeptHosts: keep ? [...others, key] : others });
  }, []);
  const connect = useCallback(
    (key: string) =>
      void connectKeptHost(key, {
        onAuthPrompt: (request) => new Promise((resolve) => setDialAuth({ request, resolve })),
        onHostKey: (request) => new Promise((resolve) => setDialHostKey({ request, resolve })),
      }),
    [],
  );
  const readAnyway = useCallback((id: string) => setAsked((current) => new Set(current).add(id)), []);
  const sortBy = (key: MonitorSortKey) => setPrefs({ monitorSort: nextMonitorSort(sort, key) });

  const template = `minmax(200px, 1.6fr) ${columns
    .map((column) => (MONITOR_TEXT_COLUMNS.has(column) && column !== 'users' ? 'minmax(120px, 1fr)' : 'max-content'))
    .join(' ')} max-content`;

  return (
    <Box
      aria-label="Host monitor"
      sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default', minWidth: 0 }}
    >
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{
          minHeight: layout.tabStripHeight,
          flexShrink: 0,
          px: 1.5,
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <MonitorHeartOutlinedIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
          Host monitor
        </Typography>
        <Typography variant="caption" color="textSecondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {remote === 0 ? 'No host connected' : `${remote} host${remote === 1 ? '' : 's'}`}
          {live ? '' : visible && documentVisible ? ' · connecting…' : ' · paused'}
        </Typography>
        <TextField
          size="small"
          placeholder="Filter hosts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter) {
              event.stopPropagation();
              setFilter('');
            }
          }}
          sx={{ width: 200 }}
          slotProps={{
            htmlInput: { 'aria-label': 'Filter hosts' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
              sx: { fontSize: 13, height: 28 },
            },
          }}
        />
        <TextField
          select
          size="small"
          value={intervalMs}
          onChange={(event) => setPrefs({ monitorIntervalMs: Number(event.target.value) })}
          slotProps={{
            htmlInput: { 'aria-label': 'How often hosts are read' },
            input: { sx: { fontSize: 13, height: 28 } },
          }}
        >
          {HOST_MONITOR_INTERVALS_MS.map((value) => (
            <MenuItem key={value} value={value} sx={{ fontSize: 13 }}>
              Every {monitorIntervalLabel(value)}
            </MenuItem>
          ))}
        </TextField>
        <Button
          size="small"
          color="inherit"
          startIcon={keptKeys.length > 0 ? <PushPinIcon /> : <PushPinOutlinedIcon />}
          onClick={(event) => setKeepAnchor(event.currentTarget)}
          sx={{ flexShrink: 0, minWidth: 0 }}
        >
          Keep connected{keptHosts.length > 0 ? ` (${keptHosts.length})` : ''}
        </Button>
        <Button
          size="small"
          color="inherit"
          startIcon={<ViewColumnOutlinedIcon />}
          onClick={(event) => setColumnsAnchor(event.currentTarget)}
          sx={{ flexShrink: 0, minWidth: 0 }}
        >
          Columns
        </Button>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {/* A real table, laid out as a grid so its columns can share the width. */}
        <Box
          component="table"
          aria-label="Hosts"
          sx={{
            display: 'grid',
            gridTemplateColumns: template,
            minWidth: 'max-content',
            width: '100%',
            borderSpacing: 0,
            '& thead, & tbody, & tr': { display: 'contents' },
            '& th, & td': { py: 0, textAlign: 'left' },
          }}
        >
          <thead>
            <tr>
              <HeaderCell label="Host" sortKey="host" sort={sort} pinned onSort={sortBy} />
              {columns.map((column) => (
                <HeaderCell
                  key={column}
                  label={MONITOR_COLUMN_LABELS[column]}
                  hint={MONITOR_COLUMN_HINTS[column]}
                  sortKey={column}
                  sort={sort}
                  numeric={!MONITOR_TEXT_COLUMNS.has(column)}
                  onSort={sortBy}
                />
              ))}
              <Box component="th" scope="col" aria-label="Actions" sx={[headerSx, { right: 0, zIndex: 3 }]} />
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <HostRow
                key={row.id}
                row={row}
                columns={columns}
                onReadAnyway={readAnyway}
                onKeep={setKept}
                onConnect={connect}
              />
            ))}
          </tbody>
        </Box>
        {remote === 0 ? (
          <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 2, maxWidth: 640 }}>
            Hosts appear here while a session to them is connected, and are read over that connection. To
            watch a host without a session, add it under Keep connected.
          </Typography>
        ) : shown.length === 0 ? (
          <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 2 }}>
            No host matches “{filter.trim()}”.
          </Typography>
        ) : null}
      </Box>

      <Menu anchorEl={columnsAnchor} open={!!columnsAnchor} onClose={() => setColumnsAnchor(null)}>
        {MONITOR_COLUMNS.map((column) => {
          const on = columns.includes(column);
          return (
            <MenuItem
              key={column}
              dense
              role="menuitemcheckbox"
              aria-checked={on}
              onClick={() => setPrefs({ monitorColumns: withMonitorColumn(columns, column, !on) })}
              sx={{ py: 0 }}
            >
              <Checkbox size="small" checked={on} tabIndex={-1} disableRipple sx={{ p: 0.5, mr: 1 }} />
              <ListItemText
                primary={MONITOR_COLUMN_LABELS[column]}
                secondary={MONITOR_COLUMN_HINTS[column]}
                slotProps={{ primary: { sx: { fontSize: 13 } }, secondary: { sx: { fontSize: 11 } } }}
              />
            </MenuItem>
          );
        })}
      </Menu>

      <KeepConnectedPopover
        anchorEl={keepAnchor}
        onClose={() => setKeepAnchor(null)}
        groups={groups}
        keptKeys={keptKeys}
        onToggle={setKept}
      />

      <AuthPromptDialog
        request={dialAuth?.request ?? null}
        onSubmit={(result) => {
          dialAuth?.resolve(result);
          setDialAuth(null);
        }}
      />
      <HostKeyDialog
        request={dialHostKey?.request ?? null}
        onAnswer={(accept) => {
          dialHostKey?.resolve(accept);
          setDialHostKey(null);
        }}
      />
    </Box>
  );
}

const headerSx = (theme: Theme) =>
  ({
    position: 'sticky',
    top: 0,
    // Above the pinned cells of the rows that scroll beneath it.
    zIndex: 2,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    px: 1.25,
    fontSize: 11,
    fontWeight: 550,
    color: theme.palette.text.secondary,
    backgroundColor: theme.palette.background.default,
    borderBottom: `1px solid ${theme.palette.divider}`,
    whiteSpace: 'nowrap',
  }) as const;

function HeaderCell({
  label,
  hint,
  sortKey,
  sort,
  numeric = false,
  pinned = false,
  onSort,
}: {
  label: string;
  hint?: string;
  sortKey: MonitorSortKey;
  sort: { key: MonitorSortKey; descending: boolean };
  numeric?: boolean;
  /** Stays in view when the table scrolls sideways. */
  pinned?: boolean;
  onSort: (key: MonitorSortKey) => void;
}) {
  const sorted = sort.key === sortKey;
  const Arrow = sort.descending ? ArrowDropDownIcon : ArrowDropUpIcon;
  return (
    <Box
      component="th"
      scope="col"
      aria-sort={sorted ? (sort.descending ? 'descending' : 'ascending') : 'none'}
      sx={[
        headerSx,
        { justifyContent: numeric ? 'flex-end' : 'flex-start', px: 0 },
        pinned ? { left: 0, zIndex: 3 } : {},
      ]}
    >
      <Tooltip title={hint ?? ''} disableInteractive enterDelay={600}>
        <ButtonBase
          onClick={() => onSort(sortKey)}
          aria-label={`Sort by ${label}`}
          sx={{
            height: '100%',
            px: 1.25,
            font: 'inherit',
            color: sorted ? 'text.primary' : 'inherit',
            flexDirection: numeric ? 'row-reverse' : 'row',
            '&:hover': { color: 'text.primary' },
          }}
        >
          {label}
          {/* The arrow keeps its room, so a click never shifts the header. */}
          <Arrow sx={{ fontSize: 16, visibility: sorted ? 'visible' : 'hidden' }} />
        </ButtonBase>
      </Tooltip>
    </Box>
  );
}

const cellSx = (theme: Theme) =>
  ({
    height: ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    px: 1.25,
    minWidth: 0,
    borderBottom: `1px solid ${theme.palette.divider}`,
    whiteSpace: 'nowrap',
  }) as const;

/**
 * The host's name and the row's actions stay in view while the numbers
 * between them scroll sideways. They cover what scrolls beneath, so a hovered
 * row tints them with a layer on top of the page colour, not instead of it.
 */
const pinnedCellSx = (theme: Theme) =>
  ({
    position: 'sticky',
    zIndex: 1,
    backgroundColor: theme.palette.background.default,
  }) as const;

const numberSx = { ...MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums' } as const;

function meterColor(fraction: number) {
  const level = meterLevel(fraction);
  return (theme: Theme) =>
    level === 'critical'
      ? statusTextColor('error')(theme)
      : level === 'warning'
        ? statusTextColor('warning')(theme)
        : alpha(theme.palette.text.secondary, 0.75);
}

function latencyColor(latencyMs: number | undefined) {
  return (theme: Theme) =>
    latencyMs === undefined || latencyMs < LATENCY_WARNING_MS
      ? theme.palette.sidebarInk
      : statusTextColor(latencyMs < LATENCY_CRITICAL_MS ? 'warning' : 'error')(theme);
}

function Cell({ column, row, stale }: { column: MonitorColumn; row: MonitorRow; stale: boolean }) {
  const cell = monitorCell(column, row.reading);
  const numeric = !MONITOR_TEXT_COLUMNS.has(column);
  let content: ReactNode;
  if (cell.kind === 'empty') {
    content = (
      <Box component="span" sx={{ color: 'text.disabled' }}>
        –
      </Box>
    );
  } else if (cell.kind === 'meter') {
    const { fraction, text } = cell.meter;
    content = (
      <>
        <Box
          aria-hidden
          sx={{
            width: 44,
            height: 4,
            borderRadius: 2,
            overflow: 'hidden',
            flexShrink: 0,
            bgcolor: (theme) => alpha(theme.palette.text.secondary, 0.2),
          }}
        >
          <Box
            sx={{
              width: `${fraction * 100}%`,
              height: '100%',
              bgcolor: meterColor(fraction),
              transition: 'width 300ms ease-out',
            }}
          />
        </Box>
        <Box component="span" sx={{ ...numberSx, width: '4ch', textAlign: 'right' }}>
          {text}
        </Box>
      </>
    );
  } else {
    content = (
      <Box
        component="span"
        sx={
          numeric
            ? { ...numberSx, whiteSpace: 'pre', ...(column === 'latency' ? { color: latencyColor(row.reading.latencyMs) } : {}) }
            : { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }
        }
      >
        {cell.text}
      </Box>
    );
  }
  const detail = cell.kind === 'empty' ? undefined : cell.detail;
  return (
    <Tooltip
      title={detail ? <Box sx={{ whiteSpace: 'pre-line' }}>{detail}</Box> : ''}
      disableInteractive
      enterDelay={400}
    >
      <Box
        component="td"
        sx={[
          cellSx,
          {
            gap: 0.75,
            justifyContent: numeric ? 'flex-end' : 'flex-start',
            color: 'sidebarInk',
            opacity: stale ? 0.5 : 1,
          },
        ]}
      >
        {content}
      </Box>
    </Tooltip>
  );
}

interface RowNote {
  text: string;
  /** The longer story, shown when the pointer rests on the note. */
  detail?: string;
  tone?: 'warning' | 'error';
  busy?: boolean;
  action?: 'read' | 'retry' | 'connect';
}

/** Why a row has no numbers, and what the user can do about it. */
function rowNote(row: MonitorRow): RowNote | undefined {
  if (!row.host) {
    const state = row.keptState;
    if (!state || state.status === 'connecting' || state.status === 'connected') return { text: 'Connecting…', busy: true };
    if (state.status === 'sign-in') {
      return {
        text: 'Sign-in needed',
        detail: 'Muxus does not ask for passwords, codes or host key answers by itself. Connect asks for them now.',
        tone: 'warning',
        action: 'connect',
      };
    }
    return {
      text: `Not connected: ${state.message ?? 'the connection failed'}`,
      detail: 'Muxus tries again by itself. Connect tries now, and asks for whatever the login needs.',
      tone: 'error',
      action: 'connect',
    };
  }
  const { reading } = row;
  if (reading.status === 'ok' || reading.view) return undefined;
  if (reading.status === 'waiting') return { text: 'Reading…', busy: true };
  if (reading.status === 'idle') {
    return {
      text: 'Not read: no command has run on this connection yet',
      detail:
        'A reading runs a command on the host, and some network devices drop the whole connection when asked. Muxus therefore only reads hosts whose shell session already ran one. Read anyway asks this host once.',
      action: 'read',
    };
  }
  if (reading.status === 'unsupported') {
    return {
      text: 'No statistics: the host does not run the commands they are read with',
      action: 'retry',
    };
  }
  return { text: reading.message ?? 'The last reading failed', detail: 'Muxus tries again by itself.', tone: 'error' };
}

interface HostRowProps {
  row: MonitorRow;
  columns: readonly MonitorColumn[];
  onReadAnyway: (id: string) => void;
  onKeep: (key: string, keep: boolean) => void;
  onConnect: (key: string) => void;
}

/**
 * Rows are built anew with every reading of any host. One whose own host,
 * reading and name are the same objects as before shows the same thing.
 */
function sameRow(before: HostRowProps, after: HostRowProps): boolean {
  if (
    before.columns !== after.columns ||
    before.onReadAnyway !== after.onReadAnyway ||
    before.onKeep !== after.onKeep ||
    before.onConnect !== after.onConnect
  ) {
    return false;
  }
  const a = before.row;
  const b = after.row;
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.address === b.address &&
    a.color === b.color &&
    a.kept === b.kept &&
    a.host === b.host &&
    a.reading === b.reading &&
    a.keptState === b.keptState &&
    a.source?.key === b.source?.key &&
    a.source?.systemOpenSsh === b.source?.systemOpenSsh
  );
}

const HostRow = memo(function HostRow({ row, columns, onReadAnyway, onKeep, onConnect }: HostRowProps) {
  const tabs = useTabsStore((state) => state.tabs);
  const activate = useTabsStore((state) => state.activate);
  const sessionHostIcon = useSessionHostIcon();
  const connIds = row.host?.connIds ?? [];
  const tab = row.local
    ? tabs.find((candidate) => candidate.profile?.kind === 'local' && !candidate.profile.environment)
    : tabs.find((candidate) => !!candidate.connId && connIds.includes(candidate.connId));
  const profile = row.source?.profile;
  const openTerminal = row.local
    ? () => void openLocalTerminal()
    : profile
      ? () => void openSessionProfile(profile, row.label, row.color)
      : undefined;
  /** The session that is already open, or a new one. */
  const open = tab ? () => activate(tab.id) : openTerminal;
  const note = rowNote(row);
  const stale = row.reading.status !== 'ok' && !!row.reading.view;
  const HostIcon = row.local
    ? ComputerOutlinedIcon
    : profile
      ? sessionHostIcon(profile)
      : DnsOutlinedIcon;
  const sourceKey = row.source?.key;
  const canKeep = !row.local && !!row.source?.profile && !row.source.systemOpenSsh;
  // LineAction applies it through sx, where a palette path resolves.
  const pinColor = row.kept ? 'primary.main' : undefined;
  const menu: MenuEntry[] = [
    ...(tab ? [{ label: 'Go to its tab', onClick: () => activate(tab.id) }] : []),
    ...(openTerminal ? [{ label: 'New terminal', onClick: openTerminal, divider: true }] : []),
    ...(row.source ? [{ label: 'Containers & VMs', onClick: () => showHostEnvironments(row.source!) }] : []),
    ...(row.address ? [{ label: 'Copy address', onClick: () => void copyToClipboard(row.address!) }] : []),
  ];

  return (
    <Box
      component="tr"
      aria-label={row.label}
      onDoubleClick={open}
      sx={(theme) => ({
        display: 'contents',
        '&:hover > *': {
          backgroundImage: `linear-gradient(${theme.palette.action.hover}, ${theme.palette.action.hover})`,
        },
        '&:hover .monitor-row-actions, &:focus-within .monitor-row-actions': { opacity: 1 },
      })}
    >
      <Box component="th" scope="row" sx={[cellSx, pinnedCellSx, { left: 0, gap: 0.75, fontWeight: 'inherit' }]}>
        <HostIcon sx={{ fontSize: 16, flexShrink: 0, color: row.color ?? 'text.secondary' }} />
        <Tooltip
          title={open ? (tab ? `Go to ${row.label}’s tab` : `Open a terminal on ${row.label}`) : ''}
          disableInteractive
          enterDelay={600}
        >
          <ButtonBase
            disabled={!open}
            onClick={open}
            sx={{
              minWidth: 0,
              justifyContent: 'flex-start',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 450,
              letterSpacing: '-0.1px',
              color: 'sidebarInk',
              borderRadius: 0.5,
              '&:hover': { color: 'primary.main' },
            }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {row.label}
            </Box>
          </ButtonBase>
        </Tooltip>
        {row.address ? (
          <Box
            component="span"
            sx={{ ...MONO, fontSize: 11, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}
          >
            {row.address}
          </Box>
        ) : null}
        {stale ? (
          <Tooltip title={`${row.reading.message ?? 'The last reading failed'}. These values are older.`} disableInteractive>
            <WarningAmberOutlinedIcon sx={(theme) => ({ fontSize: 14, flexShrink: 0, color: statusTextColor('warning')(theme) })} />
          </Tooltip>
        ) : null}
      </Box>
      {note ? (
        <Box
          component="td"
          colSpan={columns.length}
          sx={[
            cellSx,
            (theme) => ({
              gridColumn: `span ${columns.length}`,
              // The note takes the width the numbers of other rows give the
              // columns, and is cut short there: it never widens the table,
              // which would push its own button out of view.
              contain: 'inline-size',
              gap: 1,
              fontSize: 12,
              color: note.tone ? statusTextColor(note.tone)(theme) : theme.palette.text.secondary,
            }),
          ]}
        >
          {note.busy ? <CircularProgress size={12} sx={{ flexShrink: 0 }} /> : null}
          <Tooltip title={note.detail ?? ''} disableInteractive enterDelay={400}>
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {note.text}
            </Box>
          </Tooltip>
          {note.action === 'read' ? (
            <NoteButton onClick={() => onReadAnyway(row.id)}>Read anyway</NoteButton>
          ) : note.action === 'retry' && row.host ? (
            <NoteButton onClick={() => retryMonitoredHost(row.id)}>Try again</NoteButton>
          ) : note.action === 'connect' && sourceKey ? (
            <NoteButton onClick={() => onConnect(sourceKey)}>Connect</NoteButton>
          ) : null}
        </Box>
      ) : (
        columns.map((column) => <Cell key={column} column={column} row={row} stale={stale} />)
      )}
      <Box component="td" sx={[cellSx, pinnedCellSx, { right: 0, px: 0.5, justifyContent: 'flex-end' }]}>
        <Box
          className="monitor-row-actions"
          onDoubleClick={(event) => event.stopPropagation()}
          sx={{ display: 'flex', opacity: row.kept ? 1 : 0.55, transition: 'opacity 120ms ease' }}
        >
          {openTerminal ? (
            <LineAction label={`New terminal on ${row.label}`} Icon={TerminalOutlinedIcon} onClick={openTerminal} />
          ) : null}
          {canKeep ? (
            <LineAction
              label={
                row.kept
                  ? 'Kept connected for the monitor. Click to stop.'
                  : 'Keep connected for the monitor, without a session'
              }
              Icon={row.kept ? PushPinIcon : PushPinOutlinedIcon}
              color={pinColor}
              onClick={() => sourceKey && onKeep(sourceKey, !row.kept)}
            />
          ) : (
            // The same room as the pin, so the buttons of every row line up.
            <Box aria-hidden sx={{ width: 24 }} />
          )}
          {menu.length > 0 ? <LineMenu label={`More actions for ${row.label}`} entries={menu} /> : null}
        </Box>
      </Box>
    </Box>
  );
}, sameRow);

function NoteButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      size="small"
      onClick={onClick}
      sx={{ flexShrink: 0, minWidth: 0, py: 0, px: 0.75, fontSize: 12, lineHeight: 1.6 }}
    >
      {children}
    </Button>
  );
}

function KeepConnectedPopover({
  anchorEl,
  onClose,
  groups,
  keptKeys,
  onToggle,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  groups: ReturnType<typeof groupManagedHosts>;
  keptKeys: readonly string[];
  onToggle: (key: string, keep: boolean) => void;
}) {
  const [filter, setFilter] = useState('');
  const open = !!anchorEl;
  useEffect(() => {
    if (!open) setFilter('');
  }, [open]);
  const query = filter.trim().toLowerCase();
  const sections = open
    ? groups
        .map((group) => ({
          label: group.label,
          hosts: group.hosts.flatMap((host) => {
            const environmentHost = environmentHostForManaged(host);
            if (!environmentHost || (query && !environmentHost.label.toLowerCase().includes(query))) return [];
            return [{ key: managedHostKey(host), host: environmentHost }];
          }),
        }))
        .filter((group) => group.hosts.length > 0)
    : [];
  // Ad-hoc targets have no sidebar entry to tick, so they are listed here to untick.
  const adHoc = keptKeys.filter((key) => key.startsWith(TARGET_KEY));

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 340, maxHeight: 'min(520px, calc(100vh - 96px))', display: 'flex', flexDirection: 'column' } } }}
    >
      <Box sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography variant="body2" color="textSecondary" sx={{ fontSize: 12, mb: 1 }}>
          Muxus connects to the hosts ticked here while the monitor is open, so they are read without a
          session. It never asks for a password or code by itself: such a host waits for you to connect it.
        </Typography>
        <TextField
          size="small"
          fullWidth
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- The list just opened on the user's click; typing narrows it.
          autoFocus
          placeholder="Search hosts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          slotProps={{ htmlInput: { 'aria-label': 'Search hosts to keep connected' }, input: { sx: { fontSize: 13 } } }}
        />
      </Box>
      <List dense disablePadding sx={{ overflowY: 'auto', flex: 1 }} aria-label="Hosts to keep connected">
        {adHoc.map((key) => (
          <KeepItem key={key} label={key.slice(TARGET_KEY.length)} checked onToggle={() => onToggle(key, false)} />
        ))}
        {sections.map((group) => (
          <Box key={group.label} component="li" sx={{ listStyle: 'none' }}>
            <List dense disablePadding>
              <ListSubheader sx={{ lineHeight: '26px', fontSize: 11, bgcolor: 'background.paper' }}>{group.label}</ListSubheader>
              {group.hosts.map(({ key, host }) => (
                <KeepItem
                  key={key}
                  label={host.label}
                  checked={keptKeys.includes(key)}
                  disabled={host.systemOpenSsh === true}
                  note={host.systemOpenSsh ? 'Uses system OpenSSH, which only connects in a terminal' : undefined}
                  onToggle={() => onToggle(key, !keptKeys.includes(key))}
                />
              ))}
            </List>
          </Box>
        ))}
        {sections.length === 0 && adHoc.length === 0 ? (
          <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 1.5, fontSize: 12 }}>
            {query ? 'No SSH host matches.' : 'No SSH hosts saved yet.'}
          </Typography>
        ) : null}
      </List>
    </Popover>
  );
}

function KeepItem({
  label,
  note,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  note?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    // The whole line is the checkbox's label, so a click anywhere on it ticks the box.
    <ListItemButton component="label" dense disabled={disabled} sx={{ py: 0 }}>
      <Checkbox
        size="small"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        disableRipple
        sx={{ p: 0.5, mr: 1 }}
      />
      <ListItemText
        primary={label}
        secondary={note}
        slotProps={{ primary: { sx: { fontSize: 13 }, noWrap: true }, secondary: { sx: { fontSize: 11 } } }}
      />
    </ListItemButton>
  );
}
