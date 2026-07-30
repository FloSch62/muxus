import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import type { AppLogEntry, AppLogLevel } from '@muxus/shared';
import { clearAppLogs, formatLogEntry, useAppLogs } from '../api/logs.js';
import { copyToClipboard } from '../clipboard.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';

type LevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';

/** Minimum severity per filter choice; 'all' shows trace upward. */
const LEVEL_RANK: Record<AppLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const FILTER_RANK: Record<LevelFilter, number> = {
  all: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function levelColor(level: AppLogLevel): string {
  if (level === 'error' || level === 'fatal') return 'error.main';
  if (level === 'warn') return 'warning.main';
  if (level === 'debug' || level === 'trace') return 'text.secondary';
  return 'text.primary';
}

function matches(entry: AppLogEntry, filter: LevelFilter, query: string): boolean {
  if (LEVEL_RANK[entry.level] < FILTER_RANK[filter]) return false;
  if (!query) return true;
  return formatLogEntry(entry).toLowerCase().includes(query);
}

/** Diagnostic log viewer over the server's in-memory buffer (settings → debug). */
export function LogViewerDialog() {
  const open = useUiStore((s) => s.logViewerOpen);
  const setOpen = useUiStore((s) => s.setLogViewerOpen);
  const { data, refetch } = useAppLogs(open);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToEnd = useRef(true);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.entries ?? []).filter((entry) => matches(entry, filter, needle));
  }, [data?.entries, filter, query]);

  // Follow new output like a terminal until the user scrolls back up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToEnd.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const exportText = () =>
    [
      `# Muxus diagnostic log — exported ${new Date().toISOString()}`,
      `# ${entries.length} entries, debug logging ${data?.debugEnabled ? 'on' : 'off'}`,
      ...entries.map(formatLogEntry),
    ].join('\n');

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      maxWidth="lg"
      fullWidth
      slotProps={{ paper: { sx: { height: '80vh' } } }}
      aria-labelledby="log-viewer-title"
    >
      <DialogTitle id="log-viewer-title" sx={{ pb: 1 }}>
        Logs
      </DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 2 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <TextField
            select
            size="small"
            label="Level"
            value={filter}
            onChange={(e) => setFilter(e.target.value as LevelFilter)}
            sx={{ width: 130 }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="debug">Debug +</MenuItem>
            <MenuItem value="info">Info +</MenuItem>
            <MenuItem value="warn">Warning +</MenuItem>
            <MenuItem value="error">Error</MenuItem>
          </TextField>
          <TextField
            size="small"
            label="Filter"
            placeholder="host, message, error …"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ flex: 1, maxWidth: 360 }}
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {entries.length} of {data?.entries.length ?? 0} entries
          </Typography>
        </Stack>
        {data && !data.debugEnabled ? (
          <Alert severity="info" sx={{ py: 0 }}>
            Debug logging is off — only informational messages, warnings and errors are
            captured. Turn on debug mode in the settings for connection-level detail.
          </Alert>
        ) : null}
        <Box
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
            p: 1.5,
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {entries.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Nothing captured yet. Connection attempts, warnings and errors show up
              here as they happen.
            </Typography>
          ) : (
            entries.map((entry, index) => (
              <Box
                key={`${entry.ts}-${index}`}
                sx={{
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  color: levelColor(entry.level),
                  contentVisibility: 'auto',
                }}
              >
                {formatLogEntry(entry)}
              </Box>
            ))
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button
          size="small"
          startIcon={<DeleteOutlineOutlinedIcon />}
          onClick={() => {
            clearAppLogs()
              .then(() => refetch())
              .catch(showErrorToast);
          }}
        >
          Clear
        </Button>
        <Button
          size="small"
          startIcon={<ContentCopyOutlinedIcon />}
          disabled={entries.length === 0}
          onClick={() => {
            void copyToClipboard(exportText()).then((ok) => {
              if (ok) showToast('success', 'Log copied to the clipboard.');
            });
          }}
        >
          Copy
        </Button>
        <Button
          size="small"
          startIcon={<DownloadOutlinedIcon />}
          disabled={entries.length === 0}
          onClick={() => saveTextFile(exportFilename('debug log', 'log'), exportText())}
        >
          Export
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" onClick={() => setOpen(false)}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
