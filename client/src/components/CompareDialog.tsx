import { useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { useSessionHistory } from '../api/queries.js';
import {
  historyCompareLabel,
  historyCompareText,
  remoteFileCompareText,
  terminalCompareText,
  type CompareText,
} from '../compare-sources.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { promptForText } from '../state/dialogs.js';
import { useTabsStore } from '../state/tabs.js';
import { showErrorToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';
import { terminalHandle } from '../terminal/terminal-registry.js';
import { prepareCompareText, unifiedDiff } from '../text-compare.js';
import { DiffViewer } from './management/CodeEditor.js';

/** Local files above this size are refused, as the editor refuses them. */
const MAX_LOCAL_FILE_BYTES = 8 * 1024 * 1024;

const labelSx = {
  flex: 1,
  minWidth: 0,
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 12.5,
} as const;

/**
 * Compares the text "Compare with…" was chosen on with a second text picked
 * here: a terminal's output or selection, a session history record, or a file.
 */
export function CompareDialog({ source }: { source: CompareText }) {
  const close = () => useUiStore.getState().setCompareSource(false);
  const [second, setSecond] = useState<CompareText>();
  const [swapped, setSwapped] = useState(false);
  const [inline, setInline] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreTimestamps, setIgnoreTimestamps] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tabs = useTabsStore((state) => state.tabs);
  const { data: history } = useSessionHistory('', undefined, !!menuAnchor);

  const [left, right]: [CompareText, CompareText | undefined] =
    second && swapped ? [second, source] : [source, second];
  const original = useMemo(
    () => prepareCompareText(left.text, { ignoreTimestamps, ignoreWhitespace }),
    [left, ignoreTimestamps, ignoreWhitespace],
  );
  const modified = useMemo(
    () => (right ? prepareCompareText(right.text, { ignoreTimestamps, ignoreWhitespace }) : ''),
    [right, ignoreTimestamps, ignoreWhitespace],
  );
  const diff = useMemo(
    () =>
      right
        ? unifiedDiff(original, modified, { originalLabel: left.label, modifiedLabel: right.label, ignoreWhitespace })
        : '',
    [left, right, original, modified, ignoreWhitespace],
  );

  const pick = (load: () => Promise<CompareText> | CompareText) => {
    setMenuAnchor(null);
    setLoading(true);
    void Promise.resolve()
      .then(load)
      .then(setSecond)
      .catch(showErrorToast)
      .finally(() => setLoading(false));
  };

  const terminals = tabs.filter((tab) => terminalHandle(tab.id));
  // The first side's connection is offered even without a terminal for it, as in the SFTP window.
  const remoteHosts = new Map<string, string>();
  if (source.remote) remoteHosts.set(source.remote.connId, source.remote.host);
  for (const tab of tabs) {
    if (tab.connId && tab.sftpAvailable !== false) remoteHosts.set(tab.connId, tab.title);
  }
  const pickRemoteFile = (connId: string, host: string) => {
    setMenuAnchor(null);
    void promptForText({
      title: `Compare with a file on ${host}`,
      label: 'Path',
      initialValue: source.remote?.connId === connId ? source.remote.path : '',
      confirmLabel: 'Compare',
    }).then((path) => {
      if (path) pick(() => remoteFileCompareText(connId, host, path));
    });
  };

  return (
    <Dialog open onClose={close} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: 'min(780px, 90vh)' } } }}>
      <DialogTitle sx={{ pb: 1 }}>Compare</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography noWrap title={left.label} sx={labelSx}>
            {left.label}
          </Typography>
          <Tooltip title="Swap sides">
            <span>
              <IconButton size="small" aria-label="Swap sides" disabled={!second} onClick={() => setSwapped((value) => !value)}>
                <SwapHorizIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Typography noWrap title={right?.label} color={right ? undefined : 'textSecondary'} sx={labelSx}>
            {right?.label ?? 'Choose the text to compare with'}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={loading}
            startIcon={loading ? <CircularProgress size={14} /> : undefined}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            Compare with…
          </Button>
        </Stack>
        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={inline ? 'inline' : 'side-by-side'}
            onChange={(_event, value: string | null) => {
              if (value) setInline(value === 'inline');
            }}
            sx={{ '& .MuiToggleButton-root': { py: 0.25, textTransform: 'none' } }}
          >
            <ToggleButton value="side-by-side">Side by side</ToggleButton>
            <ToggleButton value="inline">Inline</ToggleButton>
          </ToggleButtonGroup>
          <FormControlLabel
            control={<Switch size="small" checked={ignoreWhitespace} onChange={(_event, checked) => setIgnoreWhitespace(checked)} />}
            label="Ignore whitespace"
          />
          <FormControlLabel
            control={<Switch size="small" checked={ignoreTimestamps} onChange={(_event, checked) => setIgnoreTimestamps(checked)} />}
            label="Ignore leading timestamps"
          />
        </Stack>
        {right && !diff && <Alert severity="info">No differences.</Alert>}
        <Box sx={{ flex: 1, minHeight: 200 }}>
          {right ? (
            <DiffViewer
              original={original}
              modified={modified}
              language="plaintext"
              inline={inline}
              ignoreTrimWhitespace={ignoreWhitespace}
            />
          ) : (
            <Typography variant="body2" color="textSecondary">
              Use Compare with… to pick a terminal’s output, a session history record or a file.
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          startIcon={<FileDownloadOutlinedIcon />}
          disabled={!diff}
          onClick={() => {
            if (right) saveTextFile(exportFilename(`${left.label} vs ${right.label}`, 'diff'), diff, 'text/x-diff');
          }}
        >
          Export diff
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={close}>Close</Button>
      </DialogActions>
      <Menu open={!!menuAnchor} anchorEl={menuAnchor} onClose={() => setMenuAnchor(null)}>
        {terminals.length > 0 && <ListSubheader>Terminals</ListSubheader>}
        {terminals.flatMap((tab) => {
          const handle = terminalHandle(tab.id)!;
          return [
            <MenuItem key={`${tab.id}-output`} onClick={() => pick(() => terminalCompareText(tab.title, handle.bufferText(), false))}>
              {tab.title}
            </MenuItem>,
            handle.hasSelection() ? (
              <MenuItem key={`${tab.id}-selection`} onClick={() => pick(() => terminalCompareText(tab.title, handle.getSelection(), true))}>
                {tab.title} (selection)
              </MenuItem>
            ) : null,
          ];
        })}
        {!!history?.sessions.length && <ListSubheader>Session history</ListSubheader>}
        {history?.sessions.map((session) => (
          <MenuItem key={session.id} onClick={() => pick(() => historyCompareText(session))}>
            {historyCompareLabel(session)}
          </MenuItem>
        ))}
        <ListSubheader>Files</ListSubheader>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            fileInputRef.current?.click();
          }}
        >
          Local file…
        </MenuItem>
        {[...remoteHosts].map(([connId, host]) => (
          <MenuItem key={connId} onClick={() => pickRemoteFile(connId, host)}>
            File on {host}…
          </MenuItem>
        ))}
      </Menu>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          pick(async () => {
            if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error('Files larger than 8 MiB cannot be compared.');
            return { label: file.name, text: await file.text() };
          });
        }}
      />
    </Dialog>
  );
}
