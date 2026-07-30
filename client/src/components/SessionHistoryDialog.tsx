import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { alpha, type Theme } from '@mui/material/styles';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import SearchIcon from '@mui/icons-material/Search';
import {
  SNIPPET_MATCH_END,
  SNIPPET_MATCH_START,
  type SessionLogSummary,
} from '@muxus/shared';
import {
  useSessionHistory,
  useSessionLog,
} from '../api/queries.js';
import { useSetSessionPinned } from '../api/session-history.js';
import { apiFetch, apiFetchRaw } from '../api/http.js';
import { copyToClipboard } from '../clipboard.js';
import { confirmAction } from '../state/dialogs.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { findTranscriptMatchesInChunks } from '../session-history-matches.js';
import { showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';

const MAX_PREVIEW_EVENTS = 5_000;
/** Highlighting stops here so a one-letter query cannot flood the preview. */
const MAX_PREVIEW_MATCHES = 1_000;

const matchSx = {
  borderRadius: '2px',
  color: 'inherit',
  bgcolor: (theme: Theme) => alpha(theme.palette.warning.main, 0.35),
} as const;
const activeMatchSx = {
  ...matchSx,
  bgcolor: (theme: Theme) => alpha(theme.palette.warning.main, 0.75),
} as const;

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
  const { data: detail, isLoading: detailLoading } = useSessionLog(
    selected?.id,
    debouncedQuery,
  );

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const previewModel = useMemo(() => {
    let text = '';
    const chunks: { text: string; offset: number }[] = [];
    if (!detail) return { text, chunks };
    const events = detail.events.slice(-MAX_PREVIEW_EVENTS);
    for (const event of events) {
      const marker =
        event.direction === 'input'
          ? '› '
          : event.direction === 'system'
            ? '• '
            : '';
      chunks.push({ text: event.text, offset: text.length + marker.length });
      text += `${marker}${event.text}`;
    }
    return { text, chunks };
  }, [detail]);
  const preview = previewModel.text;

  const matches = useMemo(
    () => findTranscriptMatchesInChunks(
      previewModel.chunks,
      debouncedQuery,
      MAX_PREVIEW_MATCHES,
    ),
    [previewModel, debouncedQuery],
  );
  const [activeMatch, setActiveMatch] = useState(0);
  useEffect(() => setActiveMatch(0), [matches]);
  const previewRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!matches.length) return;
    previewRef.current
      ?.querySelector(`[data-match="${activeMatch}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [matches, activeMatch]);

  const previewContent = useMemo<ReactNode>(() => {
    if (!matches.length) return preview;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    matches.forEach((match, index) => {
      if (match.start > cursor) nodes.push(preview.slice(cursor, match.start));
      nodes.push(
        <Box
          key={index}
          component="mark"
          data-match={index}
          sx={index === activeMatch ? activeMatchSx : matchSx}
        >
          {preview.slice(match.start, match.end)}
        </Box>,
      );
      cursor = match.end;
    });
    nodes.push(preview.slice(cursor));
    return nodes;
  }, [preview, matches, activeMatch]);

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
              {debouncedQuery && !detailLoading ? (
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <Typography variant="caption" color="text.secondary">
                    {matches.length
                      ? `Match ${activeMatch + 1} of ${
                          matches.length >= MAX_PREVIEW_MATCHES
                            ? `${MAX_PREVIEW_MATCHES.toLocaleString()}+`
                            : matches.length
                        } in this preview`
                      : 'No exact match in the previewed output.'}
                  </Typography>
                  <IconButton
                    size="small"
                    disabled={matches.length < 2}
                    aria-label="Previous match"
                    onClick={() =>
                      setActiveMatch(
                        (current) => (current - 1 + matches.length) % matches.length,
                      )
                    }
                  >
                    <KeyboardArrowUpIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    disabled={matches.length < 2}
                    aria-label="Next match"
                    onClick={() =>
                      setActiveMatch((current) => (current + 1) % matches.length)
                    }
                  >
                    <KeyboardArrowDownIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ) : null}
              <Paper
                ref={previewRef}
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
                  : previewContent || 'No normalized terminal output was retained.'}
              </Paper>
              {detail?.eventsTruncated ? (
                <Typography variant="caption" color="text.secondary">
                  Previewing {detail.events.length.toLocaleString()} of the
                  retained events
                  {debouncedQuery ? ' around the first match' : ' (newest first)'}.
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
        <Button variant="contained" onClick={() => setOpen(false)}>
          Done
        </Button>
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
            {session.matchCount
              ? ` · ${session.matchCount.toLocaleString()} ${
                  session.matchCount === 1 ? 'matching chunk' : 'matching chunks'
                }`
              : null}
            {session.snippet ? (
              <Box
                component="span"
                sx={{
                  mt: 0.5,
                  display: 'block',
                  color: 'text.secondary',
                  typography: 'caption',
                  overflowWrap: 'anywhere',
                }}
              >
                {snippetNodes(session.snippet)}
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
            void confirmAction({
              title: `Delete the retained log for “${session.title}”?`,
              description:
                'The recorded output and its transcript are removed from the history database. This cannot be undone.',
              confirmLabel: 'Delete',
              destructive: true,
            }).then((confirmed) => {
              if (!confirmed) return;
              void apiFetch(`/api/session-history/${session.id}`, { method: 'DELETE' })
                .then(() => {
                  void client.invalidateQueries({ queryKey: ['session-history'] });
                  showToast('success', 'Session log deleted.');
                })
                .catch((err: Error) => showToast('error', err.message));
            });
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
      <span>
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
      </span>
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

/** Snippet text with the server's sentinel-marked ranges rendered as marks. */
function snippetNodes(snippet: string): ReactNode[] {
  const [head = '', ...rest] = snippet.split(SNIPPET_MATCH_START);
  const nodes: ReactNode[] = [head];
  rest.forEach((part, index) => {
    const end = part.indexOf(SNIPPET_MATCH_END);
    if (end === -1) {
      nodes.push(part);
      return;
    }
    nodes.push(
      <Box key={index} component="mark" sx={matchSx}>
        {part.slice(0, end)}
      </Box>,
      part.slice(end + 1),
    );
  });
  return nodes;
}

// One formatter for the whole list, and each timestamp rendered once: the
// list re-renders on every keystroke, selection, and background refetch.
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
});
const dateLabels = new Map<string, string>();

function formatDate(value: string): string {
  const cached = dateLabels.get(value);
  if (cached !== undefined) return cached;
  const date = new Date(value);
  const label = Number.isNaN(date.valueOf()) ? value : DATE_FORMAT.format(date);
  if (dateLabels.size > 1_000) dateLabels.clear();
  dateLabels.set(value, label);
  return label;
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
