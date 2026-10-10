import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha, useTheme } from '@mui/material/styles';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import PauseRoundedIcon from '@mui/icons-material/PauseRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import SearchIcon from '@mui/icons-material/Search';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import SyncIcon from '@mui/icons-material/Sync';
import { stripModulePrefix, tryParseGnmiPath, type GnmiPath } from '@muxus/shared';
import { formatRate, formatSi, type LiveRow, type LiveTable } from '../../management/live-table.js';
import { nonEmptyPaths, type GnmiDraft } from '../../management/requests.js';
import type { RunRecord } from '../../management/workbench-store.js';
import { exportFilename, saveTextFile } from '../../save-file.js';
import { useWorkbench } from './context.js';
import { MONO_FONT, PathText, valueColorSx, valueText } from './PathText.js';

const ROW_HEIGHT = 28;
const FLASH_MS = 1200;
type SortKey = 'path' | 'rate' | 'updated' | 'updates';

/** Elements every subscribed path shares exactly (no wildcards), shown once above the table. */
function commonPrefix(paths: readonly string[]): GnmiPath | undefined {
  const parsed = paths.map((path) => tryParseGnmiPath(path)).filter((path): path is GnmiPath => !!path);
  if (parsed.length === 0) return undefined;
  const first = parsed[0]!;
  let length = 0;
  for (; length < first.elems.length; length++) {
    const elem = first.elems[length]!;
    const wildcard = Object.values(elem.keys ?? {}).some((value) => value === '*');
    if (wildcard) break;
    const same = parsed.every((path) => {
      const other = path.elems[length];
      return (
        other &&
        stripModulePrefix(other.name) === stripModulePrefix(elem.name) &&
        JSON.stringify(other.keys ?? {}) === JSON.stringify(elem.keys ?? {})
      );
    });
    if (!same) break;
  }
  // Keep at least the leaf visible: never fold a whole single-leaf path away.
  if (parsed.length === 1 && length === first.elems.length) length = Math.max(0, length - 1);
  return { elems: first.elems.slice(0, length) };
}

function Sparkline({ points, color }: { points: readonly number[]; color: string }) {
  if (points.length < 2) return <Box sx={{ width: 84, height: 18 }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = 84 / (points.length - 1);
  const coordinates = points.map((point, index) => `${(index * step).toFixed(1)},${(17 - ((point - min) / span) * 15).toFixed(1)}`);
  return (
    <svg width={84} height={18} aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={`0,18 ${coordinates.join(' ')} 84,18`} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={coordinates.join(' ')} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

function ago(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function useTableVersion(table: LiveTable, paused: boolean): number {
  const [version, setVersion] = useState(table.version);
  useEffect(() => {
    if (paused) return;
    let frame = 0;
    let last = 0;
    const schedule = () => {
      if (frame) return;
      const wait = Math.max(0, 250 - (performance.now() - last));
      frame = window.setTimeout(() => {
        frame = 0;
        last = performance.now();
        setVersion(table.version);
      }, wait);
    };
    setVersion(table.version);
    const unsubscribe = table.subscribe(schedule);
    return () => {
      unsubscribe();
      if (frame) clearTimeout(frame);
    };
  }, [table, paused]);
  return version;
}

export function LiveView({ run }: { run: RunRecord }) {
  const { controller, title } = useWorkbench();
  const theme = useTheme();
  const table = run.live!;
  const draft = run.draft as GnmiDraft;
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'path', descending: false });
  const [now, setNow] = useState(() => Date.now());
  const version = useTableVersion(table, paused);
  const streaming = run.status === 'streaming';
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });

  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const prefix = useMemo(() => commonPrefix(nonEmptyPaths(draft.paths)), [draft.paths]);
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list = [...table.rows.values()];
    if (needle) {
      list = list.filter(
        (row) => row.path.toLowerCase().includes(needle) || valueText(row.value).toLowerCase().includes(needle),
      );
    }
    const direction = sort.descending ? -1 : 1;
    list.sort((a, b) => {
      switch (sort.key) {
        case 'rate':
          return direction * ((a.rate ?? -1) - (b.rate ?? -1));
        case 'updated':
          return direction * (a.receivedAt - b.receivedAt);
        case 'updates':
          return direction * (a.updates - b.updates);
        default:
          return direction * a.path.localeCompare(b.path, undefined, { numeric: true });
      }
    });
    return list;
    // `version` stands for in-place changes of the table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, version, filter, sort]);

  const elapsedSeconds = Math.max(1, (now - table.startedAt) / 1000);
  const flashCutoff = performance.now() - FLASH_MS;
  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 10);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + 10);
  const accent = theme.palette.primary.main;

  const exportCsv = () => {
    const lines = ['path,value,rate_per_second,updated,updates'];
    for (const row of rows) {
      const cells = [row.path, valueText(row.value), row.rate?.toString() ?? '', new Date(row.updatedAt).toISOString(), String(row.updates)];
      lines.push(cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','));
    }
    saveTextFile(exportFilename(`${title} telemetry`, 'csv'), lines.join('\n'), 'text/csv');
  };

  const header = (key: SortKey, label: string, width?: number | string, align: 'left' | 'right' = 'left') => (
    <Box
      component="button"
      type="button"
      onClick={() =>
        setSort((current) =>
          current.key === key ? { key, descending: !current.descending } : { key, descending: key !== 'path' },
        )
      }
      sx={{
        all: 'unset',
        cursor: 'pointer',
        width,
        flex: width === undefined ? 1 : undefined,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 0.25,
        fontSize: 10.5,
        fontWeight: 650,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: sort.key === key ? 'text.primary' : 'text.secondary',
        '&:focus-visible': { outline: `1px solid ${accent}` },
      }}
    >
      {label}
      {sort.key === key && (
        <ArrowDownwardIcon sx={{ fontSize: 12, transform: sort.descending ? 'none' : 'rotate(180deg)' }} />
      )}
    </Box>
  );

  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', px: 1.5, py: 0.5, borderBottom: 1, borderColor: 'divider', minHeight: 40, flexWrap: 'wrap' }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: streaming ? (paused ? 'warning.main' : 'success.main') : 'text.disabled',
            boxShadow: streaming && !paused ? `0 0 0 3px ${alpha(theme.palette.success.main, 0.2)}` : 'none',
            animation: streaming && !paused ? 'muxus-pulse 1.6s ease-in-out infinite' : 'none',
            '@keyframes muxus-pulse': { '50%': { boxShadow: `0 0 0 5px ${alpha(theme.palette.success.main, 0.05)}` } },
          }}
        />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {streaming ? (paused ? 'Paused' : table.synced ? 'Live' : 'Receiving initial state …') : 'Stopped'}
        </Typography>
        <Typography variant="caption" color="textSecondary" sx={{ whiteSpace: 'nowrap' }}>
          {rows.length} leaves · {formatSi(table.leafUpdates)} updates · {formatSi(table.bytes / elapsedSeconds)}B/s
        </Typography>
        {prefix && prefix.elems.length > 0 && (
          <Typography variant="caption" color="textSecondary" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            under <PathText path={prefix} />
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1,
            height: 28,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            width: 200,
          }}
        >
          <SearchIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          <InputBase
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter"
            inputProps={{ 'aria-label': 'Filter values' }}
            sx={{ fontSize: 12.5, flex: 1 }}
          />
        </Box>
        {draft.subscribe.listMode === 'poll' && streaming && (
          <Button size="small" startIcon={<SyncIcon />} onClick={() => controller.poll(run.id)}>
            Poll
          </Button>
        )}
        {streaming && (
          <Tooltip title={paused ? 'Resume the display' : 'Freeze the display (updates keep arriving)'}>
            <IconButton size="small" aria-label={paused ? 'Resume' : 'Pause'} onClick={() => setPaused((value) => !value)}>
              {paused ? <PlayArrowRoundedIcon fontSize="small" /> : <PauseRoundedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Clear values">
          <IconButton size="small" aria-label="Clear values" onClick={() => table.clear()}>
            <DeleteSweepOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Export as CSV">
          <IconButton size="small" aria-label="Export as CSV" onClick={exportCsv} disabled={rows.length === 0}>
            <FileDownloadOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {streaming && (
          <Button size="small" color="error" variant="outlined" startIcon={<StopRoundedIcon />} onClick={() => controller.cancel(run.id)}>
            Stop
          </Button>
        )}
      </Stack>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ px: 1.5, height: 26, alignItems: 'center', borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', flexShrink: 0 }}
      >
        {header('path', 'Path')}
        <Box sx={{ width: '22%', minWidth: 90 }}>{header('path', 'Value', '100%')}</Box>
        {header('rate', 'Rate', 96, 'right')}
        <Box sx={{ width: 84, fontSize: 10.5, fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.4, color: 'text.secondary' }}>
          Trend
        </Box>
        {header('updated', 'Age', 44, 'right')}
        {header('updates', '#', 48, 'right')}
      </Stack>
      <Box
        ref={scrollRef}
        onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
        sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        {rows.length === 0 ? (
          <Stack spacing={1} sx={{ p: 3, alignItems: 'center', color: 'text.secondary' }}>
            <Typography variant="body2">
              {streaming ? 'Waiting for the first update …' : filter ? 'Nothing matches the filter.' : 'No values were received.'}
            </Typography>
            {streaming && draft.subscribe.mode === 'on-change' && (
              <Typography variant="caption">On-change subscriptions only report when a value changes.</Typography>
            )}
          </Stack>
        ) : (
          <Box sx={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            <Box sx={{ position: 'absolute', top: start * ROW_HEIGHT, left: 0, right: 0 }}>
              {rows.slice(start, end).map((row) => (
                <LiveRowView
                  key={row.path}
                  row={row}
                  skip={prefix?.elems.length ?? 0}
                  // Counters change with every sample; only state changes deserve attention.
                  flashing={!row.counter && row.changedAt !== undefined && row.changedAt > flashCutoff}
                  now={now}
                />
              ))}
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function LiveRowView({ row, skip, flashing, now }: { row: LiveRow; skip: number; flashing: boolean; now: number }) {
  const theme = useTheme();
  const trendColor = row.counter ? theme.palette.primary.main : theme.palette.secondary.main;
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        px: 1.5,
        height: ROW_HEIGHT,
        alignItems: 'center',
        fontSize: 12.5,
        borderBottom: 1,
        borderColor: 'divider',
        opacity: row.deleted ? 0.45 : 1,
        textDecoration: row.deleted ? 'line-through' : 'none',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.path}>
        <PathText path={row.path} skip={skip} sx={{ whiteSpace: 'nowrap', wordBreak: 'normal', overflowWrap: 'normal' }} />
      </Box>
      <Box
        title={valueText(row.value)}
        sx={{
          width: '22%',
          minWidth: 90,
          fontFamily: MONO_FONT,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: valueColorSx(row.value),
          borderRadius: 0.75,
          px: 0.5,
          mx: -0.5,
          transition: 'background-color 900ms ease',
          bgcolor: flashing ? alpha(theme.palette.warning.main, 0.28) : 'transparent',
        }}
      >
        {valueText(row.value)}
      </Box>
      <Box sx={{ width: 96, textAlign: 'right', fontFamily: MONO_FONT, fontSize: 12, color: row.rate ? 'text.primary' : 'text.disabled', whiteSpace: 'nowrap' }}>
        {row.rate !== undefined ? formatRate(row.path, row.rate) : '—'}
      </Box>
      <Box sx={{ width: 84 }}>
        <Sparkline points={row.history} color={trendColor} />
      </Box>
      <Box sx={{ width: 44, textAlign: 'right', color: 'text.secondary', fontSize: 11.5 }}>{ago(row.receivedAt, now)}</Box>
      <Box sx={{ width: 48, textAlign: 'right', color: 'text.secondary', fontSize: 11.5, fontFamily: MONO_FONT }}>
        {row.updates}
      </Box>
    </Stack>
  );
}
