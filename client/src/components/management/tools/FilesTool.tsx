import { useEffect, useRef, useState, type DragEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { GRPC_METHODS, type ManagementError } from '@muxus/shared';
import { copyToClipboard } from '../../../clipboard.js';
import { languageForPath } from '../../../editor/language-detection.js';
import { permissionString } from '../../../management/tool-format.js';
import { confirmAction } from '../../../state/dialogs.js';
import { showToast } from '../../../state/toast.js';
import { FileTypeIcon } from '../../FileTypeIcon.js';
import { formatSize } from '../../TransferProgress.js';
import { CodeEditor } from '../CodeEditor.js';
import { MONO_FONT } from '../PathText.js';
import { deviceTime, ErrorAlert, errorOf, Section, ToolHeader, useGrpc, useToolState } from './common.js';

type EntryKind = 'dir' | 'file' | 'unknown';

interface Entry {
  path: string;
  name: string;
  size?: number;
  modified?: string;
  permissions?: number;
  kind: EntryKind;
}

interface Transfer {
  id: number;
  name: string;
  direction: 'up' | 'down';
  bytes: number;
  total?: number;
  done: boolean;
  error?: string;
  verified?: boolean;
}

interface FilesState {
  cwd: string;
  entries: Entry[];
  loading: boolean;
  error?: ManagementError;
  transfers: Transfer[];
}

const initialFiles = (): FilesState => ({ cwd: '/', entries: [], loading: false, transfers: [] });

/** Files bigger than this are downloaded rather than shown. */
const PREVIEW_LIMIT = 2 * 1024 * 1024;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/';
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, '')}/${name}`;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}


function entryFromStat(stat: Record<string, unknown>): Entry {
  const path = typeof stat.path === 'string' ? stat.path : '';
  const size = stat.size === undefined ? undefined : Number(stat.size);
  return {
    path,
    name: basename(path),
    ...(size !== undefined ? { size } : {}),
    ...(stat.last_modified !== undefined ? { modified: String(stat.last_modified as string | number) } : {}),
    ...(stat.permissions !== undefined ? { permissions: Number(stat.permissions) } : {}),
    kind: 'unknown',
  };
}

let transferCounter = 0;

export function FilesTool() {
  const grpc = useGrpc();
  const [state, setState] = useToolState('files', initialFiles);
  const [pathInput, setPathInput] = useState(state.cwd);
  const [preview, setPreview] = useState<{ path: string; text?: string; loading: boolean; error?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const listing = useRef(0);

  const stat = async (path: string) => {
    const response = await grpc!.grpcCall<{ stats?: Array<Record<string, unknown>> }>(GRPC_METHODS.fileStat, { path });
    return (response.stats ?? []).map(entryFromStat);
  };

  /** Directories are only told apart from files by statting them: a file stats as itself. */
  const classify = async (entries: Entry[], ticket: number) => {
    const queue = entries.filter((entry) => entry.kind === 'unknown').slice(0, 300);
    const worker = async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry || ticket !== listing.current) return;
        let kind: EntryKind = 'unknown';
        try {
          const children = await stat(entry.path);
          kind = children.length === 1 && children[0]!.path === entry.path ? 'file' : 'dir';
        } catch {
          kind = 'unknown';
        }
        if (ticket !== listing.current) return;
        setState((current) => ({
          ...current,
          entries: current.entries.map((candidate) => (candidate.path === entry.path ? { ...candidate, kind } : candidate)),
        }));
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  };

  const open = async (path: string) => {
    if (!grpc) return;
    const ticket = ++listing.current;
    setPathInput(path);
    setState({ cwd: path, loading: true, error: undefined });
    try {
      const entries = await stat(path);
      if (ticket !== listing.current) return;
      if (entries.length === 1 && entries[0]!.path === path.replace(/\/+$/, '')) {
        // A file: show its folder and open it.
        setState({ loading: false });
        void open(parentOf(path));
        void showPreview(entries[0]!);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      setState({ entries, loading: false });
      void classify(entries, ticket);
    } catch (err) {
      if (ticket === listing.current) setState({ loading: false, entries: [], error: errorOf(err) });
    }
  };

  useEffect(() => {
    if (grpc && state.entries.length === 0 && !state.loading && !state.error) void open(state.cwd);
    // Load the remembered folder once the session is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grpc]);

  const updateTransfer = (id: number, patch: Partial<Transfer>) =>
    setState((current) => ({
      ...current,
      transfers: current.transfers.map((transfer) => (transfer.id === id ? { ...transfer, ...patch } : transfer)),
    }));

  const download = async (entry: Entry) => {
    if (!grpc) return;
    const id = ++transferCounter;
    setState((current) => ({
      ...current,
      transfers: [{ id, name: entry.name, direction: 'down' as const, bytes: 0, total: entry.size, done: false }, ...current.transfers].slice(0, 8),
    }));
    try {
      const file = await grpc.downloadFile(entry.path, (bytes) => updateTransfer(id, { bytes })).promise;
      updateTransfer(id, { bytes: file.size, done: true, verified: file.verified });
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = entry.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      updateTransfer(id, { done: true, error: errorOf(err).message });
    }
  };

  const showPreview = async (entry: Entry) => {
    if (!grpc) return;
    if ((entry.size ?? 0) > PREVIEW_LIMIT) {
      void download(entry);
      return;
    }
    setPreview({ path: entry.path, loading: true });
    try {
      const file = await grpc.downloadFile(entry.path).promise;
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      // Binary content gets downloaded instead of shown as mojibake.
      const binary = bytes.subarray(0, 4096).some((byte) => byte === 0);
      if (binary) {
        setPreview(null);
        void download(entry);
        return;
      }
      setPreview({ path: entry.path, loading: false, text: new TextDecoder().decode(bytes) });
    } catch (err) {
      setPreview({ path: entry.path, loading: false, error: errorOf(err).message });
    }
  };

  const remove = async (entry: Entry) => {
    if (!grpc) return;
    const confirmed = await confirmAction({
      title: `Delete ${entry.name}?`,
      description: `${entry.path} is removed from the device.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.fileRemove, { remote_file: entry.path });
      showToast('success', `Deleted ${entry.name}.`);
      void open(state.cwd);
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  const upload = async (files: FileList | File[]) => {
    if (!grpc) return;
    const directory = state.cwd;
    for (const file of Array.from(files)) {
      const id = ++transferCounter;
      setState((current) => ({
        ...current,
        transfers: [{ id, name: file.name, direction: 'up' as const, bytes: 0, total: file.size, done: false }, ...current.transfers].slice(0, 8),
      }));
      try {
        const size = await grpc.uploadFile(joinPath(directory, file.name), file, 644, (bytes) => updateTransfer(id, { bytes })).promise;
        updateTransfer(id, { bytes: size, done: true, verified: true });
      } catch (err) {
        updateTransfer(id, { done: true, error: errorOf(err).message });
      }
    }
    void open(directory);
  };

  const crumbs = state.cwd.split('/').filter(Boolean);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
  };

  return (
    <Box>
      <ToolHeader
        icon={<FolderOpenOutlinedIcon fontSize="small" />}
        title="Files"
        service="gnoi.file.File"
        description="Browse the device's file system, read files, and move them in and out. Every transfer is checked against the hash the device reports."
      />
      <Section
        title="Browse"
        actions={
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="Up">
              <span>
                <IconButton size="small" aria-label="Up" disabled={state.cwd === '/'} onClick={() => void open(parentOf(state.cwd))}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Reload">
              <IconButton size="small" aria-label="Reload" onClick={() => void open(state.cwd)}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Button size="small" startIcon={<FileUploadOutlinedIcon />} disabled={!grpc} onClick={() => uploadRef.current?.click()}>
              Upload
            </Button>
            <input
              ref={uploadRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) void upload(event.target.files);
                event.target.value = '';
              }}
            />
          </Stack>
        }
      >
        <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
          <Button size="small" onClick={() => void open('/')} sx={{ minWidth: 0, px: 0.75, fontFamily: MONO_FONT }}>
            /
          </Button>
          {crumbs.map((crumb, index) => (
            <Stack key={index} direction="row" sx={{ alignItems: 'center' }}>
              <Button
                size="small"
                onClick={() => void open(`/${crumbs.slice(0, index + 1).join('/')}`)}
                sx={{ minWidth: 0, px: 0.75, fontFamily: MONO_FONT, textTransform: 'none' }}
              >
                {crumb}
              </Button>
              {index < crumbs.length - 1 && <Typography color="textSecondary">/</Typography>}
            </Stack>
          ))}
          <Box sx={{ flex: 1 }} />
          <InputBase
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void open(pathInput.trim() || '/');
            }}
            placeholder="Go to path"
            inputProps={{ 'aria-label': 'Path', spellCheck: false }}
            sx={{ fontFamily: MONO_FONT, fontSize: 12.5, border: 1, borderColor: 'divider', borderRadius: 1, px: 1, height: 28, width: 260 }}
          />
        </Stack>
        <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
        <Box
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          sx={(theme) => ({
            border: 1,
            borderColor: dragging ? 'primary.main' : 'divider',
            borderStyle: dragging ? 'dashed' : 'solid',
            borderRadius: 1.5,
            maxHeight: 420,
            overflow: 'auto',
            bgcolor: dragging ? alpha(theme.palette.primary.main, 0.06) : 'transparent',
          })}
        >
          <Stack
            direction="row"
            spacing={1.5}
            sx={{ px: 1.5, height: 30, alignItems: 'center', borderBottom: 1, borderColor: 'divider', position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1 }}
          >
            {['Name', 'Size', 'Modified', 'Permissions'].map((label, index) => (
              <Typography
                key={label}
                variant="caption"
                sx={{ fontWeight: 650, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5, ...(index === 0 ? { flex: 1 } : { width: index === 2 ? 170 : 90, textAlign: index === 1 ? 'right' : 'left' }) }}
              >
                {label}
              </Typography>
            ))}
            <Box sx={{ width: 96 }} />
          </Stack>
          {state.loading && state.entries.length === 0 ? (
            <Stack sx={{ p: 3, alignItems: 'center' }}>
              <CircularProgress size={20} />
            </Stack>
          ) : state.entries.length === 0 ? (
            <Typography variant="body2" color="textSecondary" sx={{ p: 2.5, textAlign: 'center' }}>
              {state.error ? 'Nothing to show.' : 'This folder is empty. Drop files here to upload them.'}
            </Typography>
          ) : (
            state.entries.map((entry) => (
              <Stack
                key={entry.path}
                direction="row"
                spacing={1.5}
                onDoubleClick={() => (entry.kind === 'file' ? void showPreview(entry) : void open(entry.path))}
                sx={{
                  px: 1.5,
                  height: 32,
                  alignItems: 'center',
                  cursor: 'default',
                  borderBottom: 1,
                  borderColor: 'divider',
                  '&:hover': { bgcolor: 'action.hover' },
                  '&:hover .file-actions': { opacity: 1 },
                }}
              >
                <Stack direction="row" spacing={1} sx={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
                  <Box sx={{ width: 20, display: 'flex', justifyContent: 'center', opacity: entry.kind === 'unknown' ? 0.5 : 1 }}>
                    <FileTypeIcon name={entry.name} type={entry.kind === 'dir' ? 'dir' : 'file'} />
                  </Box>
                  <Box
                    component="button"
                    type="button"
                    title={entry.kind === 'dir' ? `Open ${entry.name}` : entry.kind === 'file' ? `Preview ${entry.name}` : 'Could not look inside; open it to try'}
                    onClick={() => (entry.kind === 'file' ? void showPreview(entry) : void open(entry.path))}
                    sx={(theme) => ({
                      all: 'unset',
                      cursor: 'pointer',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 13,
                      fontWeight: entry.kind === 'dir' ? 600 : 400,
                      '&:hover': { textDecoration: 'underline' },
                      '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, borderRadius: 0.5 },
                    })}
                  >
                    {entry.name}
                  </Box>
                </Stack>
                <Typography sx={{ width: 90, textAlign: 'right', fontSize: 12, color: 'text.secondary', fontFamily: MONO_FONT }}>
                  {entry.kind === 'file' ? formatSize(entry.size ?? 0) : ''}
                </Typography>
                <Typography sx={{ width: 170, fontSize: 12, color: 'text.secondary' }} noWrap>
                  {deviceTime(entry.modified)}
                </Typography>
                <Typography sx={{ width: 90, fontSize: 12, color: 'text.secondary', fontFamily: MONO_FONT }}>
                  {permissionString(entry.permissions)}
                </Typography>
                <Stack direction="row" className="file-actions" sx={{ width: 96, justifyContent: 'flex-end', opacity: 0, transition: 'opacity 100ms ease' }}>
                  {entry.kind !== 'dir' && (
                    <Tooltip title="Download">
                      <IconButton size="small" aria-label={`Download ${entry.name}`} onClick={() => void download(entry)}>
                        <FileDownloadOutlinedIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Copy path">
                    <IconButton
                      size="small"
                      aria-label={`Copy the path of ${entry.name}`}
                      onClick={() => void copyToClipboard(entry.path).then((ok) => ok && showToast('success', 'Copied the path.'))}
                    >
                      <ContentCopyIcon sx={{ fontSize: 15 }} />
                    </IconButton>
                  </Tooltip>
                  {entry.kind !== 'dir' && (
                    <Tooltip title="Delete">
                      <IconButton size="small" aria-label={`Delete ${entry.name}`} onClick={() => void remove(entry)}>
                        <DeleteOutlineIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
              </Stack>
            ))
          )}
        </Box>
      </Section>
      {state.transfers.length > 0 && (
        <Section title="Transfers" actions={<Button size="small" color="inherit" onClick={() => setState({ transfers: state.transfers.filter((transfer) => !transfer.done) })}>Clear</Button>}>
          <Stack spacing={1}>
            {state.transfers.map((transfer) => (
              <Box key={transfer.id}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  {transfer.direction === 'up' ? <FileUploadOutlinedIcon sx={{ fontSize: 16 }} /> : <FileDownloadOutlinedIcon sx={{ fontSize: 16 }} />}
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                    {transfer.name}
                  </Typography>
                  <Typography variant="caption" color={transfer.error ? 'error' : 'textSecondary'}>
                    {transfer.error ?? `${formatSize(transfer.bytes)}${transfer.total ? ` of ${formatSize(transfer.total)}` : ''}`}
                  </Typography>
                  {transfer.done && !transfer.error && (
                    <Tooltip title={transfer.verified ? 'Hash checked' : 'The device sent no hash to check'}>
                      <CheckCircleRoundedIcon sx={{ fontSize: 16, color: transfer.verified ? 'success.main' : 'text.disabled' }} />
                    </Tooltip>
                  )}
                </Stack>
                {!transfer.done && (
                  <LinearProgress
                    variant={transfer.total ? 'determinate' : 'indeterminate'}
                    value={transfer.total ? (transfer.bytes / transfer.total) * 100 : undefined}
                    sx={{ mt: 0.5, borderRadius: 1 }}
                  />
                )}
              </Box>
            ))}
          </Stack>
        </Section>
      )}
      <Dialog open={!!preview} onClose={() => setPreview(null)} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: 'min(760px, 88vh)' } } }}>
        <DialogTitle sx={{ fontFamily: MONO_FONT, fontSize: 15 }}>{preview?.path}</DialogTitle>
        <DialogContent sx={{ display: 'flex', minHeight: 0 }}>
          {preview?.loading ? (
            <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <CircularProgress size={24} />
            </Stack>
          ) : preview?.error ? (
            <ErrorAlert error={{ message: preview.error }} />
          ) : preview?.text !== undefined ? (
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <CodeEditor
                value={preview.text}
                language={(['json', 'xml', 'yang', 'python', 'shell'].includes(languageForPath(preview.path)) ? languageForPath(preview.path) : 'plaintext') as 'plaintext'}
                readOnly
                ariaLabel={`Contents of ${preview.path}`}
              />
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPreview(null)}>Close</Button>
          {preview && (
            <Button
              variant="contained"
              startIcon={<FileDownloadOutlinedIcon />}
              onClick={() => {
                const entry = state.entries.find((candidate) => candidate.path === preview.path) ?? {
                  path: preview.path,
                  name: basename(preview.path),
                  kind: 'file' as const,
                };
                void download(entry);
              }}
            >
              Download
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
