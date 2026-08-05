import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FolderOffOutlinedIcon from '@mui/icons-material/FolderOffOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type { SftpEntry } from '@muxus/shared';
import { ApiError, apiFetch } from '../api/http.js';
import { useSftpList } from '../api/queries.js';
import {
  downloadBlobWithProgress,
  uploadRawWithProgress,
  type ByteProgress,
} from '../api/transfers.js';
import { confirmAction, promptForText } from '../state/dialogs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { usePrefsStore } from '../state/prefs.js';
import { loadMonacoTextEditor } from '../lazy-features.js';
import {
  clampSftpPanelWidth,
  DEFAULT_SFTP_PANEL_WIDTH,
  maxSftpPanelWidth,
  MIN_SFTP_PANEL_WIDTH,
} from '../sftp-panel-width.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { PanelResizeHandle } from './PanelResizeHandle.js';

interface DroppedFile {
  file: File;
  relativePath: string;
}

interface DropPayload {
  files: DroppedFile[];
  directories: string[];
}

interface TransferState {
  id: number;
  direction: 'upload' | 'download';
  name: string;
  loaded: number;
  total?: number;
  bytesPerSecond: number;
  phase: 'preparing' | 'transferring' | 'finalizing' | 'cancelling' | 'complete';
  fileIndex: number;
  fileCount: number;
}

interface WebkitFileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(success: (file: File) => void, error?: (error: DOMException) => void): void;
  createReader(): {
    readEntries(success: (entries: WebkitFileEntry[]) => void, error?: (error: DOMException) => void): void;
  };
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function parentPath(dir: string): string {
  if (dir === '/') return '/';
  const idx = dir.lastIndexOf('/');
  return idx <= 0 ? '/' : dir.slice(0, idx);
}

function cleanRelativePath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function formatSize(size?: number): string {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

// A directory listing re-renders on every selection and transfer tick, and a
// timestamp always renders the same string.
const MTIME_LABELS = new Map<number, string>();
const MTIME_CACHE_LIMIT = 4_000;

function formatMtime(ms?: number): string {
  if (!ms) return '';
  const cached = MTIME_LABELS.get(ms);
  if (cached !== undefined) return cached;
  const date = new Date(ms);
  const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (MTIME_LABELS.size >= MTIME_CACHE_LIMIT) MTIME_LABELS.clear();
  MTIME_LABELS.set(ms, label);
  return label;
}

function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatSize(bytesPerSecond)}/s` : 'Starting…';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readDirectory(reader: ReturnType<WebkitFileEntry['createReader']>): Promise<WebkitFileEntry[]> {
  const result: WebkitFileEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitFileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return result;
    result.push(...batch);
  }
}

async function collectDrop(items: DataTransferItem[]): Promise<DropPayload> {
  const payload: DropPayload = { files: [], directories: [] };
  const entries: WebkitFileEntry[] = [];
  for (const item of items) {
    const getter = (item as unknown as { webkitGetAsEntry?: () => WebkitFileEntry | null }).webkitGetAsEntry;
    const entry = getter?.call(item);
    if (entry) entries.push(entry);
  }

  const visit = async (entry: WebkitFileEntry, parent: string): Promise<void> => {
    const relativePath = cleanRelativePath(parent ? `${parent}/${entry.name}` : entry.name);
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
      payload.files.push({ file, relativePath });
      return;
    }
    if (!entry.isDirectory) return;
    payload.directories.push(relativePath);
    const children = await readDirectory(entry.createReader());
    await Promise.all(children.map((child) => visit(child, relativePath)));
  };

  if (entries.length > 0) {
    await Promise.all(entries.map((entry) => visit(entry, '')));
    return payload;
  }
  for (const item of items) {
    const file = item.getAsFile();
    if (file) payload.files.push({ file, relativePath: file.name });
  }
  return payload;
}

function saveDownload(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const SftpEntryTable = memo(function SftpEntryTable({
  connId,
  currentPath,
  entries,
  isFetching,
  selectedName,
  onNavigate,
  onOpenFile,
  onSelect,
  onContextMenu,
}: {
  connId: string;
  currentPath: string;
  entries: SftpEntry[];
  isFetching: boolean;
  selectedName?: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelect: (name: string) => void;
  onContextMenu: (entry: SftpEntry, x: number, y: number) => void;
}) {
  return (
    <Table size="small" stickyHeader sx={{ '& td, & th': { py: 0.45, fontSize: 12 } }}>
      <TableHead>
        <TableRow>
          <TableCell>Name</TableCell>
          <TableCell align="right" sx={{ width: 72 }}>
            Size
          </TableCell>
          <TableCell sx={{ width: 112 }}>Modified</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {entries.map((entry) => {
          const entryPath = joinPath(currentPath, entry.name);
          return (
            <TableRow
              key={entry.name}
              hover
              selected={entry.name === selectedName}
              draggable={entry.type === 'file' && !!entry.downloadTicket}
              title={entry.type === 'file' ? 'Double-click to edit · drag out to download' : undefined}
              sx={{
                cursor: entry.type === 'file' ? 'grab' : 'pointer',
                userSelect: 'none',
                contentVisibility: 'auto',
                containIntrinsicSize: '0 33px',
              }}
              onClick={() => onSelect(entry.name)}
              onPointerDown={() => {
                if (entry.type === 'file') void loadMonacoTextEditor();
              }}
              onDoubleClick={() =>
                entry.type === 'dir'
                  ? onNavigate(entryPath)
                  : entry.type === 'file'
                    ? onOpenFile(entryPath)
                    : undefined
              }
              onDragStart={(event) => {
                if (entry.type !== 'file' || !entry.downloadTicket) {
                  event.preventDefault();
                  return;
                }
                const url = new URL(
                  `/api/sftp/${encodeURIComponent(connId)}/drag-download?ticket=${encodeURIComponent(entry.downloadTicket)}`,
                  window.location.href,
                ).toString();
                const dragName = entry.name.replaceAll(/[\r\n:]/g, '_');
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('DownloadURL', `application/octet-stream:${dragName}:${url}`);
                event.dataTransfer.setData('text/uri-list', url);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(entry, event.clientX, event.clientY);
              }}
            >
              <TableCell sx={{ display: 'flex', alignItems: 'center', gap: 0.75, border: 0, minWidth: 0 }}>
                <FileTypeIcon name={entry.name} type={entry.type} />
                <Typography variant="body2" noWrap sx={{ fontSize: 12 }}>
                  {entry.name}
                </Typography>
              </TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                {entry.type === 'file' ? formatSize(entry.size) : ''}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                {formatMtime(entry.mtimeMs)}
              </TableCell>
            </TableRow>
          );
        })}
        {entries.length === 0 && !isFetching && (
          <TableRow>
            <TableCell colSpan={3} sx={{ color: 'text.secondary', textAlign: 'center', border: 0, py: 3 }}>
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <FolderOffOutlinedIcon sx={{ fontSize: 26, color: 'text.disabled' }} />
                <Typography variant="caption" color="text.secondary">
                  Empty directory
                </Typography>
              </Stack>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
});

/**
 * The remote file browser, bound to a live SSH connection. Files open in Monaco on
 * double-click; explicit and outbound-drag downloads remain one gesture away.
 */
export function SftpPanel({
  connId,
  onOpenFile,
  initialPath = '.',
  terminalPath,
  followTerminalFolder = false,
  onFollowTerminalFolderChange,
  fill = false,
  onOpenInNewWindow,
}: {
  connId: string;
  onOpenFile: (path: string) => void;
  initialPath?: string;
  /** Latest working directory reported by the terminal sharing this connection. */
  terminalPath?: string;
  /** Whether the attached browser follows terminal working-directory reports. */
  followTerminalFolder?: boolean;
  onFollowTerminalFolderChange?: (follow: boolean) => void;
  /** Fill a standalone window instead of using the saved side-panel width. */
  fill?: boolean;
  onOpenInNewWindow?: (path: string) => void;
}) {
  const startingPath = terminalPath ?? initialPath;
  const [path, setPath] = useState(startingPath);
  const [pathInput, setPathInput] = useState(startingPath);
  const [dragOver, setDragOver] = useState(false);
  const [selectedName, setSelectedName] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry } | null>(null);
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<TransferState>();
  const nextTransferIdRef = useRef(1);
  const transferControllerRef = useRef<AbortController | undefined>(undefined);
  const homePathRef = useRef<string | undefined>(undefined);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const panelWidth = usePrefsStore((state) => state.sftpPanelWidth);
  const setPrefs = usePrefsStore((state) => state.set);

  const { data, isFetching, error } = useSftpList(connId, path);
  useEffect(() => {
    if (!data?.path) return;
    if (path === '.') homePathRef.current = data.path;
    setPathInput(data.path);
  }, [data?.path, path]);
  useEffect(() => {
    if (!followTerminalFolder || !terminalPath) return;
    setPath(terminalPath);
    setPathInput(terminalPath);
    setSelectedName(undefined);
  }, [followTerminalFolder, terminalPath]);
  useEffect(() => () => transferControllerRef.current?.abort(), []);

  const entries = useMemo(
    () =>
      (data?.entries ?? []).toSorted((a, b) => {
        if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [data?.entries],
  );
  const selected = useMemo(
    () => entries.find((entry) => entry.name === selectedName),
    [entries, selectedName],
  );
  const currentPath = data?.path ?? path;
  const homePath = homePathRef.current ?? (path === '.' ? data?.path : undefined) ?? '.';

  const navigate = useCallback((next: string) => {
    setPath(next);
    setPathInput(next);
    setSelectedName(undefined);
  }, []);
  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ['sftp-list', connId] }),
    [connId, queryClient],
  );
  const remotePath = useCallback(
    (entry: SftpEntry) => joinPath(currentPath, entry.name),
    [currentPath],
  );
  const openContextMenu = useCallback((entry: SftpEntry, x: number, y: number) => {
    setSelectedName(entry.name);
    setMenu({ x, y, entry });
  }, []);

  const download = (entry: SftpEntry) => {
    if (busy) return;
    void (async () => {
      const id = nextTransferIdRef.current++;
      const controller = new AbortController();
      transferControllerRef.current = controller;
      setBusy(true);
      setTransfer({
        id,
        direction: 'download',
        name: entry.name,
        loaded: 0,
        total: entry.size,
        bytesPerSecond: 0,
        phase: 'preparing',
        fileIndex: 1,
        fileCount: 1,
      });
      try {
        const blob = await downloadBlobWithProgress(
          `/api/sftp/${connId}/download?path=${encodeURIComponent(remotePath(entry))}`,
          (progress) =>
            setTransfer({
              id,
              direction: 'download',
              name: entry.name,
              ...progress,
              phase: 'transferring',
              fileIndex: 1,
              fileCount: 1,
            }),
          controller.signal,
        );
        setTransfer({
          id,
          direction: 'download',
          name: entry.name,
          loaded: blob.size,
          total: blob.size,
          bytesPerSecond: 0,
          phase: 'complete',
          fileIndex: 1,
          fileCount: 1,
        });
        saveDownload(entry.name, blob);
        showToast('success', `Downloaded ${entry.name}`);
        setTimeout(
          () => setTransfer((current) => (current?.id === id ? undefined : current)),
          1_200,
        );
      } catch (downloadError) {
        setTransfer(undefined);
        if (isAbortError(downloadError)) showToast('info', `Cancelled download of ${entry.name}`);
        else showErrorToast(downloadError);
      } finally {
        if (transferControllerRef.current === controller) transferControllerRef.current = undefined;
        setBusy(false);
      }
    })();
  };

  const upload = (payload: DropPayload) => {
    if (busy || (payload.files.length === 0 && payload.directories.length === 0)) return;
    void (async () => {
      const id = nextTransferIdRef.current++;
      const controller = new AbortController();
      transferControllerRef.current = controller;
      setBusy(true);
      const parentDirectories = payload.files
        .map(({ relativePath }) => cleanRelativePath(relativePath).split('/').slice(0, -1).join('/'))
        .filter(Boolean);
      const directories = [...new Set([...payload.directories, ...parentDirectories])]
        .filter(Boolean)
        .sort((a, b) => a.split('/').length - b.split('/').length);
      const totalBytes = payload.files.reduce((sum, item) => sum + item.file.size, 0);
      let completedBytes = 0;
      let uploaded = 0;
      let currentFileIndex = 0;
      setTransfer({
        id,
        direction: 'upload',
        name: directories[0] ?? payload.files[0]?.relativePath ?? 'Preparing upload',
        loaded: 0,
        total: totalBytes || undefined,
        bytesPerSecond: 0,
        phase: 'preparing',
        fileIndex: 0,
        fileCount: payload.files.length,
      });
      try {
        for (const relative of directories) {
          setTransfer({
            id,
            direction: 'upload',
            name: relative,
            loaded: completedBytes,
            total: totalBytes || undefined,
            bytesPerSecond: 0,
            phase: 'preparing',
            fileIndex: currentFileIndex,
            fileCount: payload.files.length,
          });
          await apiFetch(`/api/sftp/${connId}/mkdir`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: joinPath(currentPath, relative), recursive: true }),
            signal: controller.signal,
          });
        }
        for (const item of payload.files) {
          currentFileIndex++;
          const relative = cleanRelativePath(item.relativePath || item.file.name);
          const destination = joinPath(currentPath, relative);
          const updateProgress = (progress: ByteProgress) =>
            setTransfer({
              id,
              direction: 'upload',
              name: relative,
              loaded: completedBytes + progress.loaded,
              total: totalBytes,
              bytesPerSecond: progress.bytesPerSecond,
              phase: 'transferring',
              fileIndex: currentFileIndex,
              fileCount: payload.files.length,
            });
          const send = (overwrite: boolean) =>
            uploadRawWithProgress(
              `/api/sftp/${connId}/upload?path=${encodeURIComponent(destination)}${overwrite ? '&overwrite=true' : ''}`,
              item.file,
              {
                onProgress: updateProgress,
                signal: controller.signal,
                onUploadComplete: () =>
                  setTransfer((current) =>
                    current?.id === id
                      ? {
                          ...current,
                          loaded: completedBytes + item.file.size,
                          phase: 'finalizing',
                        }
                      : current,
                  ),
              },
            );
          try {
            await send(false);
            uploaded++;
          } catch (uploadError) {
            if (
              !(uploadError instanceof ApiError) ||
              uploadError.status !== 409 ||
              uploadError.body?.code !== 'SFTP_DESTINATION_EXISTS'
            ) {
              throw uploadError;
            }
            const replace = await confirmAction({
              title: 'Replace the existing file?',
              description: `${relative} already exists on the remote host.`,
              confirmLabel: 'Replace',
              destructive: true,
            });
            if (!replace) {
              completedBytes += item.file.size;
              continue;
            }
            await send(true);
            uploaded++;
          }
          completedBytes += item.file.size;
        }
        showToast(
          'success',
          uploaded > 0
            ? `Uploaded ${uploaded === 1 ? '1 file' : `${uploaded} files`}`
            : `Created ${directories.length === 1 ? '1 folder' : `${directories.length} folders`}`,
        );
        refresh();
        setTransfer({
          id,
          direction: 'upload',
          name: payload.files.at(-1)?.relativePath ?? directories.at(-1) ?? 'Upload',
          loaded: totalBytes,
          total: totalBytes || undefined,
          bytesPerSecond: 0,
          phase: 'complete',
          fileIndex: payload.files.length,
          fileCount: payload.files.length,
        });
        setTimeout(
          () => setTransfer((current) => (current?.id === id ? undefined : current)),
          1_200,
        );
      } catch (uploadError) {
        setTransfer(undefined);
        if (isAbortError(uploadError)) showToast('info', 'Upload cancelled');
        else showErrorToast(uploadError);
      } finally {
        if (transferControllerRef.current === controller) transferControllerRef.current = undefined;
        setBusy(false);
      }
    })();
  };

  const run = (operation: () => Promise<unknown>) => {
    void (async () => {
      setBusy(true);
      try {
        await operation();
        refresh();
      } catch (operationError) {
        showErrorToast(operationError);
      } finally {
        setBusy(false);
      }
    })();
  };

  const validName = (value: string) =>
    cleanRelativePath(value) ? null : 'Enter a name without path separators.';

  const mkdir = () => {
    void promptForText({
      title: 'New folder',
      description: `Created in ${currentPath}`,
      label: 'Folder name',
      confirmLabel: 'Create',
      validate: validName,
    }).then((name) => {
      if (!name) return;
      run(() =>
        apiFetch(`/api/sftp/${connId}/mkdir`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: joinPath(currentPath, cleanRelativePath(name)) }),
        }),
      );
    });
  };

  const rename = (entry: SftpEntry) => {
    void promptForText({
      title: `Rename ${entry.name}`,
      label: 'New name',
      initialValue: entry.name,
      confirmLabel: 'Rename',
      validate: validName,
    }).then((name) => {
      if (!name || name === entry.name) return;
      run(() =>
        apiFetch(`/api/sftp/${connId}/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: remotePath(entry), to: joinPath(currentPath, cleanRelativePath(name)) }),
        }),
      );
    });
  };

  const remove = (entry: SftpEntry) => {
    void confirmAction({
      title: `Delete ${entry.name}?`,
      description:
        entry.type === 'dir'
          ? 'The folder and everything inside it is removed from the remote host. This cannot be undone.'
          : 'The file is removed from the remote host. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      run(() =>
        apiFetch(`/api/sftp/${connId}/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: remotePath(entry) }),
        }),
      );
    });
  };

  const hasLocalFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes('Files');
  const transferPercent =
    transfer?.phase === 'complete'
      ? 100
      : transfer?.total && transfer.total > 0
      ? Math.min(100, (transfer.loaded / transfer.total) * 100)
      : undefined;

  return (
    <Box
      ref={panelRef}
      sx={{
        width: fill ? '100%' : panelWidth,
        maxWidth: fill ? 'none' : '70%',
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: fill ? 0 : 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        position: 'relative',
      }}
      onDragEnter={(event) => {
        if (!hasLocalFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current++;
        setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!hasLocalFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!hasLocalFiles(event)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragOver(false);
      }}
      onDrop={(event) => {
        if (!hasLocalFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragOver(false);
        if (busy) {
          showToast('warning', 'Wait for the current SFTP operation to finish.');
          return;
        }
        const items = Array.from(event.dataTransfer.items);
        void collectDrop(items).then(upload).catch(showErrorToast);
      }}
    >
      {!fill && (
        <PanelResizeHandle
          panelRef={panelRef}
          edge="left"
          width={panelWidth}
          defaultWidth={DEFAULT_SFTP_PANEL_WIDTH}
          minWidth={MIN_SFTP_PANEL_WIDTH}
          maxWidth={maxSftpPanelWidth}
          clampWidth={clampSftpPanelWidth}
          onWidthChange={(sftpPanelWidth) => setPrefs({ sftpPanelWidth })}
          label="Resize file browser"
        />
      )}
      <Stack direction="row" sx={{ px: 1.25, pt: 1, alignItems: 'center' }}>
        <FolderOpenOutlinedIcon sx={{ mr: 0.75, fontSize: 18, color: 'primary.main' }} />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          File browser
        </Typography>
        <Typography variant="caption" color="text.secondary">
          SFTP
        </Typography>
        {onOpenInNewWindow && (
          <Tooltip title="Open file browser in new window">
            <IconButton
              size="small"
              aria-label="Open file browser in new window"
              onClick={() => onOpenInNewWindow(currentPath)}
              sx={{ ml: 0.5 }}
            >
              <OpenInNewOutlinedIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      <Stack direction="row" spacing={0.25} sx={{ p: 0.75, alignItems: 'center' }}>
        <Tooltip title="Parent directory">
          <span>
            <IconButton
              size="small"
              aria-label="Parent directory"
              disabled={currentPath === '/'}
              onClick={() => navigate(parentPath(currentPath))}
            >
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Home">
          <IconButton size="small" aria-label="Home directory" onClick={() => navigate(homePath)}>
            <HomeOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <TextField
          fullWidth
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && pathInput.trim()) navigate(pathInput.trim());
          }}
          slotProps={{ input: { sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5 } } }}
        />
        <Tooltip title="Refresh">
          <IconButton size="small" aria-label="Refresh listing" onClick={refresh}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" spacing={0.25} sx={{ px: 0.75, pb: 0.75, alignItems: 'center' }}>
        <Tooltip title="New folder">
          <IconButton size="small" aria-label="New folder" disabled={busy} onClick={mkdir}>
            <CreateNewFolderOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Upload files">
          <IconButton
            size="small"
            aria-label="Upload files"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadFileOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) {
              upload({
                files: files.map((file) => ({ file, relativePath: file.name })),
                directories: [],
              });
            }
            event.target.value = '';
          }}
        />
        <Tooltip title="Open selected file in editor">
          <span>
            <IconButton
              size="small"
              aria-label="Open selected file in editor"
              disabled={busy || selected?.type !== 'file'}
              onMouseEnter={() => void loadMonacoTextEditor()}
              onFocus={() => void loadMonacoTextEditor()}
              onClick={() => selected && onOpenFile(remotePath(selected))}
            >
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Download selected file">
          <span>
            <IconButton
              size="small"
              aria-label="Download selected file"
              disabled={busy || selected?.type !== 'file'}
              onClick={() => selected && download(selected)}
            >
              <DownloadOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.disabled">
          Drag in to upload · drag out to download
        </Typography>
      </Stack>
      {transfer && (
        <Box
          sx={(theme) => ({
            mx: 0.75,
            mb: 0.75,
            p: 1,
            border: 1,
            borderColor: transfer.phase === 'complete' ? alpha(theme.palette.success.main, 0.45) : 'divider',
            borderRadius: 1,
            bgcolor:
              transfer.phase === 'complete'
                ? alpha(theme.palette.success.main, 0.07)
                : alpha(theme.palette.primary.main, 0.04),
          })}
        >
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, mb: 0.6 }}>
            {transfer.direction === 'upload' ? (
              <UploadFileOutlinedIcon color={transfer.phase === 'complete' ? 'success' : 'primary'} sx={{ fontSize: 17 }} />
            ) : (
              <DownloadOutlinedIcon color={transfer.phase === 'complete' ? 'success' : 'primary'} sx={{ fontSize: 17 }} />
            )}
            <Typography variant="caption" noWrap title={transfer.name} sx={{ flex: 1, fontWeight: 600 }}>
              {transfer.phase === 'complete'
                ? `${transfer.direction === 'upload' ? 'Uploaded' : 'Downloaded'} ${transfer.name}`
                : transfer.phase === 'cancelling'
                  ? `Cancelling ${transfer.name}…`
                : transfer.phase === 'finalizing'
                  ? `Finishing ${transfer.name} on remote…`
                  : transfer.phase === 'preparing'
                    ? `Preparing ${transfer.name}…`
                  : `${transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} ${transfer.name}`}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {transferPercent === undefined ? '—' : `${Math.round(transferPercent)}%`}
            </Typography>
            {transfer.phase !== 'complete' &&
              transfer.phase !== 'finalizing' &&
              transfer.phase !== 'cancelling' && (
                <Button
                  color="error"
                  onClick={() => {
                    setTransfer((current) =>
                      current ? { ...current, phase: 'cancelling', bytesPerSecond: 0 } : current,
                    );
                    transferControllerRef.current?.abort();
                  }}
                  sx={{ minWidth: 0, px: 0.75, py: 0.1 }}
                >
                  Cancel
                </Button>
              )}
          </Stack>
          <LinearProgress
            color={transfer.phase === 'complete' ? 'success' : 'primary'}
            variant={transferPercent === undefined ? 'indeterminate' : 'determinate'}
            value={transferPercent ?? 0}
          />
          <Stack direction="row" sx={{ mt: 0.55, justifyContent: 'space-between', gap: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatSize(transfer.loaded)}
              {transfer.total !== undefined ? ` / ${formatSize(transfer.total)}` : ''}
              {transfer.phase === 'transferring' ? ` · ${formatSpeed(transfer.bytesPerSecond)}` : ''}
            </Typography>
            {transfer.fileCount > 1 && (
              <Typography variant="caption" color="text.secondary">
                File {transfer.fileIndex} of {transfer.fileCount}
              </Typography>
            )}
          </Stack>
        </Box>
      )}
      <Box sx={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {(isFetching || busy) && !transfer && <CircularProgress size={18} sx={{ position: 'absolute', zIndex: 2, top: 8, right: 12 }} />}
        {error ? (
          <Typography variant="body2" color="error" sx={{ p: 2 }}>
            {error instanceof Error ? error.message : String(error)}
          </Typography>
        ) : (
          <SftpEntryTable
            connId={connId}
            currentPath={currentPath}
            entries={entries}
            isFetching={isFetching}
            selectedName={selectedName}
            onNavigate={navigate}
            onOpenFile={onOpenFile}
            onSelect={setSelectedName}
            onContextMenu={openContextMenu}
          />
        )}
      </Box>
      {onFollowTerminalFolderChange && (
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              checked={followTerminalFolder}
              onChange={(event) => onFollowTerminalFolderChange(event.target.checked)}
            />
          )}
          label="Follow terminal folder"
          sx={{
            m: 0,
            px: 0.75,
            py: 0.25,
            borderTop: 1,
            borderColor: 'divider',
            '& .MuiFormControlLabel-label': { fontSize: 12 },
          }}
        />
      )}
      {dragOver && (
        <Box
          sx={(theme) => ({
            position: 'absolute',
            inset: 8,
            zIndex: 8,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
            border: '2px dashed',
            borderColor: 'primary.main',
            borderRadius: 2,
            bgcolor: alpha(theme.palette.background.paper, 0.92),
            boxShadow: `inset 0 0 40px ${alpha(theme.palette.primary.main, 0.12)}`,
          })}
        >
          <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center', px: 3 }}>
            <UploadFileOutlinedIcon color="primary" sx={{ fontSize: 38 }} />
            <Typography variant="subtitle2">Upload files and folders</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
              Drop into {currentPath}
            </Typography>
          </Stack>
        </Box>
      )}
      <Menu
        open={!!menu}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
      >
        {menu?.entry.type === 'file' && (
          <MenuItem
            onMouseEnter={() => void loadMonacoTextEditor()}
            onFocus={() => void loadMonacoTextEditor()}
            onClick={() => {
              if (menu) onOpenFile(remotePath(menu.entry));
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <EditOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Open in editor</ListItemText>
          </MenuItem>
        )}
        {menu?.entry.type === 'file' && (
          <MenuItem
            onClick={() => {
              if (menu) download(menu.entry);
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <DownloadOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Download</ListItemText>
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            if (menu) rename(menu.entry);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <DriveFileRenameOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Rename</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) remove(menu.entry);
            setMenu(null);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon sx={{ color: 'error.main' }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}
