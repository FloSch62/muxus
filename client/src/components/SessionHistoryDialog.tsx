import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import SearchIcon from '@mui/icons-material/Search';
import type { SessionLogSummary } from '@muxus/shared';
import {
  useSessionHistory,
  useSessionLog,
} from '../api/queries.js';
import { useSetSessionPinned } from '../api/session-history.js';
import { apiFetch, apiFetchRaw } from '../api/http.js';
import { copyToClipboard } from '../clipboard.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';

const MAX_PREVIEW_EVENTS = 5_000;

export function SessionHistoryDialog() {
  const setOpen = useUiStore((state) => state.setHistoryOpen);
  const initialQuery = useUiStore((state) => state.historyQuery);
  const initialSelectedId = useUiStore((state) => state.historySelectedId);
  const [query, setQuery] = useState(initialQuery);
  const [host, setHost] = useState('');
  const [kind, setKind] = useState('');
  const [startedAfter, setStartedAfter] = useState('');
  const [startedBefore, setStartedBefore] = useState('');
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const debouncedHost = useDebouncedValue(host.trim(), 300);
  const filters = useMemo(
    () => ({
      host: debouncedHost || undefined,
      kind: (kind || undefined) as 'ssh' | 'local' | 'serial' | 'telnet' | undefined,
      startedAfter: dateBoundary(startedAfter, false),
      startedBefore: dateBoundary(startedBefore, true),
    }),
    [debouncedHost, kind, startedAfter, startedBefore],
  );
  const {
    data,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useSessionHistory(debouncedQuery, filters);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId);
  const selected =
    data?.sessions.find((session) => session.id === selectedId) ??
    data?.sessions[0];
  const { data: detail, isLoading: detailLoading } = useSessionLog(selected?.id);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const preview = useMemo(() => {
    if (!detail) return '';
    const events = detail.events.slice(-MAX_PREVIEW_EVENTS);
    return events
      .map((event) => {
        const marker =
          event.direction === 'input'
            ? '› '
            : event.direction === 'system'
              ? '• '
              : '';
        return `${marker}${event.text}`;
      })
      .join('');
  }, [detail]);

  return (
    <Dialog
      open
      onClose={() => setOpen(false)}
      fullWidth
      maxWidth="lg"
      slotProps={{ paper: { sx: { height: 'min(820px, 90vh)' } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        Session history
        <Chip
          size="small"
          label={`${data?.sessions.length ?? 0}${hasNextPage ? '+' : ''} loaded`}
          variant="outlined"
        />
        <IconButton
          size="small"
          aria-label="Close session history"
          onClick={() => setOpen(false)}
          sx={{ ml: 'auto' }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{
          p: 0,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '340px minmax(0, 1fr)' },
          minHeight: 0,
        }}
      >
        <Box
          sx={{
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: { md: 1 },
            borderColor: 'divider',
          }}
        >
          <Box sx={{ p: 1.5, display: 'grid', gap: 1 }}>
            <TextField
              fullWidth
              size="small"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search all retained output"
              slotProps={{
                input: {
                  startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1 }} />,
                },
              }}
            />
            <TextField
              fullWidth
              size="small"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="Filter host"
            />
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 1,
              }}
            >
              <FormControl size="small" sx={{ gridColumn: '1 / -1' }}>
                <InputLabel id="history-kind-label">Connection</InputLabel>
                <Select
                  labelId="history-kind-label"
                  value={kind}
                  label="Connection"
                  onChange={(event) => setKind(event.target.value)}
                >
                  <MenuItem value="">All</MenuItem>
                  <MenuItem value="ssh">SSH</MenuItem>
                  <MenuItem value="local">Local</MenuItem>
                  <MenuItem value="serial">Serial</MenuItem>
                  <MenuItem value="telnet">Telnet</MenuItem>
                </Select>
              </FormControl>
              <TextField
                size="small"
                type="date"
                label="From"
                value={startedAfter}
                onChange={(event) => setStartedAfter(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                size="small"
                type="date"
                label="To"
                value={startedBefore}
                onChange={(event) => setStartedBefore(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Box>
          </Box>
          <Divider />
          <List dense disablePadding sx={{ overflowY: 'auto', minHeight: 0 }}>
            {data?.sessions.map((session) => (
              <HistoryListItem
                key={session.id}
                session={session}
                selected={session.id === selected?.id}
                onSelect={() => setSelectedId(session.id)}
              />
            ))}
            {hasNextPage ? (
              <Button
                fullWidth
                size="small"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load older sessions'}
              </Button>
            ) : null}
          </List>
          {isLoading ? (
            <Typography sx={{ p: 2 }} color="text.secondary">
              Loading history…
            </Typography>
          ) : null}
          {!isLoading && !data?.sessions.length ? (
            <Typography sx={{ p: 2 }} color="text.secondary">
              {debouncedQuery
                ? 'No retained sessions match this search.'
                : 'Logs will appear here after a logging-enabled terminal starts.'}
            </Typography>
          ) : null}
        </Box>

        <Box
          sx={{
            minWidth: 0,
            minHeight: 0,
            p: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
          }}
        >
          {error ? <Alert severity="error">{error.message}</Alert> : null}
          {selected ? (
            <>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="h6" noWrap>
                    {selected.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {selected.host} · {formatDate(selected.startedAt)} ·{' '}
                    {formatBytes(selected.rawBytes)} raw
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  sx={{ ml: 'auto' }}
                  color={selected.status === 'active' ? 'success' : 'default'}
                  label={selected.paused ? 'paused' : selected.status}
                />
              </Stack>
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<CodeOutlinedIcon />}
                  onClick={() => void download(selected, 'replay')}
                >
                  HTML replay
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<DescriptionOutlinedIcon />}
                  onClick={() => void download(selected, 'clean')}
                >
                  Clean log
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<DescriptionOutlinedIcon />}
                  onClick={() => void download(selected, 'raw')}
                >
                  Raw log
                </Button>
                <Tooltip title="Copy the complete clean log">
                  <IconButton
                    size="small"
                    aria-label="Copy complete clean log"
                    onClick={() => void copyCleanLog(selected)}
                  >
                    <ContentCopyOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <PinSessionButton session={selected} />
                <DeleteSessionButton session={selected} />
              </Stack>
              <Paper
                variant="outlined"
                component="pre"
                aria-label="Normalized session transcript"
                sx={{
                  m: 0,
                  p: 1.5,
                  flex: 1,
                  minHeight: 180,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  fontFamily: 'monospace',
                  fontSize: 12,
                  lineHeight: 1.5,
                  bgcolor: 'background.default',
                }}
              >
                {detailLoading
                  ? 'Loading transcript…'
                  : preview || 'No normalized terminal output was retained.'}
              </Paper>
              {detail?.eventsTruncated ? (
                <Typography variant="caption" color="text.secondary">
                  Previewing the newest {MAX_PREVIEW_EVENTS.toLocaleString()} events.
                  Exports contain the complete retained log.
                </Typography>
              ) : null}
            </>
          ) : (
            <Typography color="text.secondary">
              Choose a session to inspect its transcript.
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setOpen(false)}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function HistoryListItem({
  session,
  selected,
  onSelect,
}: {
  session: SessionLogSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <ListItemButton
      selected={selected}
      onClick={onSelect}
      sx={{ alignItems: 'flex-start', contentVisibility: 'auto' }}
    >
      <ListItemText
        primary={session.title}
        secondary={
          <>
            {formatDate(session.startedAt)} · {formatBytes(session.rawBytes)}
            {session.snippet ? (
              <Box
                component="span"
                sx={{
                  mt: 0.5,
                  display: 'block',
                  color: 'text.secondary',
                  typography: 'caption',
                }}
              >
                {session.snippet}
              </Box>
            ) : null}
          </>
        }
        slotProps={{ primary: { noWrap: true } }}
      />
    </ListItemButton>
  );
}

function DeleteSessionButton({ session }: { session: SessionLogSummary }) {
  const client = useQueryClient();
  return (
    <Tooltip title={session.status === 'active' ? 'A live log cannot be deleted safely.' : 'Delete retained session'}>
      <span>
        <IconButton
          size="small"
          color="error"
          disabled={session.status === 'active'}
          aria-label="Delete retained session"
          onClick={() => {
            if (!window.confirm(`Delete the retained log for “${session.title}”?`)) return;
            void apiFetch(`/api/session-history/${session.id}`, { method: 'DELETE' })
              .then(() => {
                void client.invalidateQueries({ queryKey: ['session-history'] });
                showToast('success', 'Session log deleted.');
              })
              .catch((err: Error) => showToast('error', err.message));
          }}
        >
          <DeleteOutlinedIcon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );
}

function PinSessionButton({ session }: { session: SessionLogSummary }) {
  const pin = useSetSessionPinned();
  return (
    <Tooltip
      title={
        session.pinned
          ? 'Allow this session to be removed by retention'
          : 'Protect this session from quota and age cleanup'
      }
    >
      <IconButton
        size="small"
        aria-label={session.pinned ? 'Unpin retained session' : 'Pin retained session'}
        disabled={pin.isPending}
        onClick={() => pin.mutate({ id: session.id, pinned: !session.pinned })}
      >
        {session.pinned ? (
          <PushPinIcon fontSize="small" />
        ) : (
          <PushPinOutlinedIcon fontSize="small" />
        )}
      </IconButton>
    </Tooltip>
  );
}

async function download(
  session: SessionLogSummary,
  format: 'clean' | 'raw' | 'replay',
): Promise<void> {
  try {
    const suffix =
      format === 'replay'
        ? 'replay.html'
        : format;
    const response = await apiFetchRaw(`/api/session-history/${session.id}/${suffix}`);
    const text = await response.text();
    const extension =
      format === 'raw'
        ? 'muxlog'
        : format === 'replay'
          ? 'html'
          : 'txt';
    const mime =
      format === 'raw'
        ? 'application/x-ndjson'
        : format === 'replay'
          ? 'text/html'
          : 'text/plain';
    saveTextFile(
      exportFilename(session.title, extension),
      text,
      mime,
    );
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err));
  }
}

async function copyCleanLog(session: SessionLogSummary): Promise<void> {
  try {
    const response = await apiFetchRaw(`/api/session-history/${session.id}/clean`);
    const text = await response.text();
    if (!text) {
      showToast('info', 'The clean log is empty.');
      return;
    }
    const copied = await copyToClipboard(text);
    showToast(
      copied ? 'success' : 'error',
      copied ? 'Clean log copied.' : 'Could not copy the clean log.',
    );
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err));
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function dateBoundary(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const date = new Date(`${value}${suffix}`);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}
