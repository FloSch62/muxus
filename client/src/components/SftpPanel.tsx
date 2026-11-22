import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
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
import TableSortLabel from '@mui/material/TableSortLabel';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import FolderOffOutlinedIcon from '@mui/icons-material/FolderOffOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import LaunchOutlinedIcon from '@mui/icons-material/LaunchOutlined';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type { LocalOpenTarget, SftpEntry } from '@muxus/shared';
import { apiFetch } from '../api/http.js';
import { useSftpList } from '../api/queries.js';
import { downloadBlobWithProgress } from '../api/transfers.js';
import { openCompare, remoteFileCompareText } from '../compare-sources.js';
import { confirmAction, promptForText } from '../state/dialogs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { usePrefsStore } from '../state/prefs.js';
import { loadCompareDialog, loadMonacoTextEditor } from '../lazy-features.js';
import { IS_MAC } from '../platform.js';
import {
  canOpenLocally,
  chooseLocalProgram,
  openDownloadedFile,
  openWithChooser,
} from '../local-open.js';
import { emptySftpListingLabel, initialSftpPath, visibleSftpEntries } from '../sftp-panel-state.js';
import {
  canPickDownloadFolder,
  downloadFromRemote,
  downloadResume,
  downloadSummary,
  forgetInterruptedDownload,
  pickDownloadFolder,
  saveDownload,
} from '../sftp-download.js';
import {
  EMPTY_SFTP_SELECTION,
  selectAllSftpEntries,
  selectedSftpEntries,
  selectSftpEntry,
  sftpContextSelection,
  sftpEntryCount,
  sftpSelectGesture,
  visibleSftpSelection,
  type SftpSelectGesture,
  type SftpSelection,
} from '../sftp-selection.js';
import {
  DEFAULT_SFTP_SORT,
  nextSftpSort,
  sortedSftpEntries,
  type SftpSort,
  type SftpSortKey,
} from '../sftp-sort.js';
import {
  cleanRelativePath,
  collectDrop,
  isEmptyPayload,
  joinRemotePath as joinPath,
  uploadSummary,
  uploadToRemote,
  type DropPayload,
} from '../sftp-upload.js';
import { useLocalCopiesStore } from '../state/local-copies.js';
import { useSftpUploadsStore } from '../state/sftp-uploads.js';
import { tabLostConnection, useTabsStore } from '../state/tabs.js';
import {
  CONNECTION_LOST,
  reportStoppedTransfer,
  TRANSFER_CANCELLED,
} from '../transfer-progress.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { OpenWithDialog } from './OpenWithDialog.js';
import { formatSize, TransferProgress } from './TransferProgress.js';
import { SYSTEM_OPENSSH_UNAVAILABLE } from '../system-openssh.js';
import { PanelHeader } from './sidebar/PanelHeader.js';

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

function parentPath(dir: string): string {
  if (dir === '/') return '/';
  const idx = dir.lastIndexOf('/');
  return idx <= 0 ? '/' : dir.slice(0, idx);
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

const FOLDER_DOWNLOADS_UNAVAILABLE =
  'This browser cannot download folders. The desktop app and Chromium browsers can.';

/**
 * A panel too narrow for the modification times and for the filter beside the
 * toolbar buttons, such as the browser docked in the sidebar. The panel is the
 * size container.
 */
const NARROW_PANEL = '@container (max-width: 359px)';
/** No room for the drag hint between the toolbar buttons and the filter, as at the default width. */
const COMPACT_PANEL = '@container (max-width: 479px)';

const SftpEntryTable = memo(function SftpEntryTable({
  connId,
  currentPath,
  entries,
  isFetching,
  emptyLabel,
  selectedNames,
  onNavigate,
  onOpenFile,
  onSelect,
  onContextMenu,
  sort,
  onSortChange,
}: {
  connId: string;
  currentPath: string;
  entries: SftpEntry[];
  isFetching: boolean;
  emptyLabel: string;
  selectedNames: ReadonlySet<string>;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelect: (name: string, gesture: SftpSelectGesture) => void;
  onContextMenu: (entry: SftpEntry, x: number, y: number) => void;
  sort: SftpSort;
  onSortChange: (sort: SftpSort) => void;
}) {
  const direction = sort.descending ? 'desc' : 'asc';
  const sortLabel = (key: SftpSortKey, label: string) => {
    // On hover, an unsorted column's faint arrow shows where a click starts.
    const shown = sort.key === key ? sort : nextSftpSort(sort, key);
    return (
      <TableSortLabel
        component="button"
        active={sort.key === key}
        direction={shown.descending ? 'desc' : 'asc'}
        onClick={() => onSortChange(nextSftpSort(sort, key))}
        sx={{
          font: 'inherit',
          '& .MuiTableSortLabel-icon': { fontSize: 14, mx: 0.25 },
          '&:focus-visible': { outline: 2, outlineColor: 'primary.main' },
        }}
      >
        {label}
      </TableSortLabel>
    );
  };
  return (
    <Table
      size="small"
      stickyHeader
      sx={{
        '& td, & th': { py: 0.45, fontSize: 12 },
        [NARROW_PANEL]: { '& .sftp-modified': { display: 'none' } },
      }}
    >
      <TableHead>
        <TableRow>
          <TableCell sortDirection={sort.key === 'name' && direction}>
            {sortLabel('name', 'Name')}
          </TableCell>
          {/* The arrow sits in the left padding, so the narrow column keeps its width. */}
          <TableCell align="right" sortDirection={sort.key === 'size' && direction} sx={{ width: 72, pl: 0.5 }}>
            {sortLabel('size', 'Size')}
          </TableCell>
          <TableCell className="sftp-modified" sortDirection={sort.key === 'modified' && direction} sx={{ width: 112 }}>
            {sortLabel('modified', 'Modified')}
          </TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {entries.map((entry) => {
          const entryPath = joinPath(currentPath, entry.name);
          return (
            <TableRow
              key={entry.name}
              hover
              selected={selectedNames.has(entry.name)}
              draggable={entry.type === 'file' && !!entry.downloadTicket}
              title={entry.type === 'file' ? 'Double-click to edit · drag out to download' : undefined}
              sx={{
                cursor: entry.type === 'file' ? 'grab' : 'pointer',
                userSelect: 'none',
                contentVisibility: 'auto',
                containIntrinsicSize: '0 33px',
              }}
              onClick={(event) => onSelect(entry.name, sftpSelectGesture(event, IS_MAC))}
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
              <TableCell className="sftp-modified" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
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
                <Typography variant="caption" color="textSecondary">
                  {emptyLabel}
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
  followTerminalFolderUnavailable = false,
  onFollowTerminalFolderChange,
  inSidebar = false,
  full = false,
  onFullChange,
  onOpenInNewWindow,
  hostLabel,
  shown = true,
  tabId,
}: {
  connId: string;
  onOpenFile: (path: string) => void;
  initialPath?: string;
  /** Latest working directory reported by the terminal sharing this connection. */
  terminalPath?: string;
  /** Whether the attached browser follows terminal working-directory reports. */
  followTerminalFolder?: boolean;
  /** The terminal has no shell integration to report its folder with. */
  followTerminalFolderUnavailable?: boolean;
  onFollowTerminalFolderChange?: (follow: boolean) => void;
  /** A panel of the window sidebar rather than a window of its own: titled with its session. */
  inSidebar?: boolean;
  /** Spread over the panes instead of keeping to the sidebar's width. */
  full?: boolean;
  /** Offers the control that spreads the browser over the panes and back. */
  onFullChange?: (full: boolean) => void;
  onOpenInNewWindow?: (path: string) => void;
  /** The session's name, for messages about files uploaded back to it. */
  hostLabel?: string;
  /** False while kept mounted out of sight, as in the sidebar behind the hosts. */
  shown?: boolean;
  /** The tab whose session the browser shows, so a transfer cut by its lost connection says so. */
  tabId?: string;
}) {
  const startingPath = initialSftpPath(initialPath, terminalPath, followTerminalFolder);
  const [path, setPath] = useState(startingPath);
  const [pathInput, setPathInput] = useState(startingPath);
  const [dragOver, setDragOver] = useState(false);
  const [sort, setSort] = useState<SftpSort>(DEFAULT_SFTP_SORT);
  const [selection, setSelection] = useState<SftpSelection>(EMPTY_SFTP_SELECTION);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry } | null>(null);
  const [openWithFile, setOpenWithFile] = useState<{ entry: SftpEntry; path: string }>();
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<TransferState>();
  const nextTransferIdRef = useRef(1);
  const transferControllerRef = useRef<AbortController | undefined>(undefined);
  const homePathRef = useRef<string | undefined>(undefined);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const showHiddenFiles = usePrefsStore((state) => state.showHiddenFiles);
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
    setSelection(EMPTY_SFTP_SELECTION);
    setFilter('');
  }, [followTerminalFolder, terminalPath]);
  useEffect(() => () => transferControllerRef.current?.abort(), []);
  // A lost connection also closes the browser: abort before that, so the transfer reports the loss.
  useEffect(() => {
    if (!tabId) return undefined;
    return useTabsStore.subscribe((state) => {
      if (tabLostConnection(state.tabs, tabId)) transferControllerRef.current?.abort(CONNECTION_LOST);
    });
  }, [tabId]);
  // Files dropped onto a terminal of this connection report their upload here.
  const terminalUpload = useSftpUploadsStore((state) => state.uploads[connId]);
  useEffect(
    () => (shown ? useSftpUploadsStore.getState().attachBrowser(connId) : undefined),
    [connId, shown],
  );

  const entries = useMemo(
    () => sortedSftpEntries(data?.entries ?? [], sort),
    [data?.entries, sort],
  );
  const visibleEntries = useMemo(
    () => visibleSftpEntries(entries, showHiddenFiles, filter),
    [entries, showHiddenFiles, filter],
  );
  const emptyLabel = useMemo(() => emptySftpListingLabel(entries, filter), [entries, filter]);
  const entryNames = useMemo(() => visibleEntries.map((entry) => entry.name), [visibleEntries]);
  // Rows the filter or the hidden-files button hides drop out of the selection and close their menu.
  useEffect(() => {
    setSelection((current) => visibleSftpSelection(current, entryNames));
    setMenu((current) => (current && entryNames.includes(current.entry.name) ? current : null));
  }, [entryNames]);
  const selectedEntries = useMemo(() => selectedSftpEntries(visibleEntries, selection), [visibleEntries, selection]);
  // A folder is downloaded into a picked folder, which Firefox and Safari cannot pick.
  const folderDownloads = canPickDownloadFolder();
  const downloadable = (entry: SftpEntry) =>
    entry.type === 'file' || (folderDownloads && entry.type === 'dir');
  const selectedDownloads = selectedEntries.filter(downloadable);
  const single = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const currentPath = data?.path ?? path;
  const homePath = homePathRef.current ?? (path === '.' ? data?.path : undefined) ?? '.';

  const navigate = useCallback((next: string) => {
    setPath(next);
    setPathInput(next);
    setSelection(EMPTY_SFTP_SELECTION);
    setFilter('');
  }, []);
  const select = useCallback(
    (name: string, gesture: SftpSelectGesture) =>
      setSelection((current) => selectSftpEntry(current, name, gesture, entryNames)),
    [entryNames],
  );
  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ['sftp-list', connId] }),
    [connId, queryClient],
  );
  const remotePath = useCallback(
    (entry: SftpEntry) => joinPath(currentPath, entry.name),
    [currentPath],
  );
  const openContextMenu = useCallback((entry: SftpEntry, x: number, y: number) => {
    setSelection((current) => sftpContextSelection(current, entry.name));
    setMenu({ x, y, entry });
  }, []);

  const localOpen = canOpenLocally();
  const localChooser = openWithChooser();

  /** Download `file` with progress, then hand the bytes and the remote modification time to `deliver`. */
  const fetchFile = (
    entry: SftpEntry,
    file: string,
    deliver: (blob: Blob, remoteMtimeMs: number | undefined) => Promise<void> | void,
  ) => {
    if (busy) {
      showToast('warning', 'Wait for the current SFTP operation to finish.');
      return;
    }
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
        let remoteMtimeMs: number | undefined;
        const blob = await downloadBlobWithProgress(
          `/api/sftp/${connId}/download?path=${encodeURIComponent(file)}`,
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
          (headers) => {
            const modified = Date.parse(headers.get('last-modified') ?? '');
            remoteMtimeMs = Number.isNaN(modified) ? undefined : modified;
          },
          downloadResume(file, controller.signal),
        );
        forgetInterruptedDownload(file);
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
        await deliver(blob, remoteMtimeMs);
        setTimeout(
          () => setTransfer((current) => (current?.id === id ? undefined : current)),
          1_200,
        );
      } catch (downloadError) {
        setTransfer(undefined);
        reportStoppedTransfer(downloadError, controller.signal, {
          cancelled: `Cancelled download of ${entry.name}`,
          connectionLost: `Download of ${entry.name} stopped: connection lost`,
        });
      } finally {
        if (transferControllerRef.current === controller) transferControllerRef.current = undefined;
        setBusy(false);
      }
    })();
  };

  const download = (entry: SftpEntry) =>
    fetchFile(entry, remotePath(entry), (blob) => {
      saveDownload(entry.name, blob);
      showToast('success', `Downloaded ${entry.name}`);
    });

  /**
   * Several files, or folders with everything in them: into one folder picked
   * up front where the page can write to one, so the desktop app does not ask
   * where to save each file, and otherwise one by one to the browser's
   * downloads.
   */
  const downloadFiles = (items: SftpEntry[]) => {
    const [first] = items;
    if (!first) return;
    if (items.length === 1 && first.type === 'file') {
      download(first);
      return;
    }
    if (busy) {
      showToast('warning', 'Wait for the current SFTP operation to finish.');
      return;
    }
    // Taken now: a followed terminal can change folders while the folder is picked.
    const targets = items.map((entry) => ({ entry, path: remotePath(entry) }));
    void (async () => {
      let folder: FileSystemDirectoryHandle | null | undefined;
      try {
        folder = await pickDownloadFolder();
      } catch (pickError) {
        showErrorToast(pickError);
        return;
      }
      if (folder === null) return;
      const id = nextTransferIdRef.current++;
      const controller = new AbortController();
      transferControllerRef.current = controller;
      setBusy(true);
      try {
        const result = await downloadFromRemote(connId, targets, folder, {
          signal: controller.signal,
          onProgress: (progress) => setTransfer({ id, ...progress }),
        });
        if (!result || result.cancelled) {
          setTransfer(undefined);
          if (result) showToast('info', downloadSummary(result, folder?.name));
          return;
        }
        showToast(
          result.skipped.length > 0 ? 'warning' : 'success',
          downloadSummary(result, folder?.name),
          result.skipped.join('\n') || undefined,
        );
        setTimeout(
          () => setTransfer((current) => (current?.id === id ? undefined : current)),
          1_200,
        );
      } catch (downloadError) {
        setTransfer(undefined);
        reportStoppedTransfer(downloadError, controller.signal, {
          cancelled: 'Download cancelled',
          connectionLost: 'Download stopped: connection lost',
        });
      } finally {
        if (transferControllerRef.current === controller) transferControllerRef.current = undefined;
        setBusy(false);
      }
    })();
  };

  // Saves in the program are offered for upload back to `file` (LocalCopySync).
  const openLocally = (entry: SftpEntry, file: string, target: LocalOpenTarget) =>
    fetchFile(entry, file, async (blob, remoteMtimeMs) => {
      const id = await openDownloadedFile(entry.name, blob, target);
      useLocalCopiesStore.getState().track({
        id,
        connId,
        remotePath: file,
        name: entry.name,
        ...(hostLabel ? { host: hostLabel } : {}),
        ...(remoteMtimeMs === undefined ? {} : { remoteMtimeMs }),
        autoUpload: false,
      });
    });

  // The path is taken now: a followed terminal can change folders while a
  // program is being picked.
  const openWith = (entry: SftpEntry) => {
    const file = remotePath(entry);
    if (localChooser === 'system') {
      openLocally(entry, file, { kind: 'system-chooser' });
    } else if (localChooser === 'program-picker') {
      chooseLocalProgram()
        .then((program) => {
          if (program) openLocally(entry, file, { kind: 'application', id: program.id });
        })
        .catch(showErrorToast);
    } else if (localChooser === 'application-list') {
      setOpenWithFile({ entry, path: file });
    }
  };

  const upload = (payload: DropPayload) => {
    if (busy || isEmptyPayload(payload)) return;
    void (async () => {
      const id = nextTransferIdRef.current++;
      const controller = new AbortController();
      transferControllerRef.current = controller;
      setBusy(true);
      try {
        const result = await uploadToRemote(connId, currentPath, payload, {
          signal: controller.signal,
          onProgress: (progress) => setTransfer({ id, ...progress }),
        });
        showToast('success', uploadSummary(result));
        refresh();
        setTimeout(
          () => setTransfer((current) => (current?.id === id ? undefined : current)),
          1_200,
        );
      } catch (uploadError) {
        setTransfer(undefined);
        reportStoppedTransfer(uploadError, controller.signal, {
          cancelled: 'Upload cancelled',
          connectionLost: 'Upload stopped: connection lost',
        });
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

  const remove = (targets: SftpEntry[]) => {
    const [entry] = targets;
    if (!entry) return;
    const files = targets.map(remotePath);
    const folders = targets.some((target) => target.type === 'dir');
    void confirmAction({
      title: targets.length === 1 ? `Delete ${entry.name}?` : `Delete ${targets.length} items?`,
      description:
        targets.length > 1
          ? `${sftpEntryCount(targets)} are removed from the remote host${
              folders ? ', with everything inside the folders' : ''
            }. This cannot be undone.`
          : entry.type === 'dir'
            ? 'The folder and everything inside it is removed from the remote host. This cannot be undone.'
            : 'The file is removed from the remote host. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      setSelection(EMPTY_SFTP_SELECTION);
      // One at a time: the SFTP channel is shared, and a failure stops the rest.
      run(async () => {
        for (const file of files) {
          await apiFetch(`/api/sftp/${connId}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: file }),
          });
        }
      });
    });
  };

  const onListingKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
      setSelection(selectAllSftpEntries(entryNames));
    } else if (event.key === 'Escape' && selection.names.size > 0) {
      // Taken: the same key shrinks a browser that fills the window, one step later.
      event.preventDefault();
      setSelection(EMPTY_SFTP_SELECTION);
    } else if (
      (event.key === 'Delete' || (IS_MAC && event.metaKey && event.key === 'Backspace')) &&
      selectedEntries.length > 0
    ) {
      remove(selectedEntries);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const hasLocalFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes('Files');
  const downloadNoun = (targets: SftpEntry[]) =>
    targets.some((entry) => entry.type === 'dir') ? 'items' : 'files';
  const downloadLabel =
    selectedDownloads.length > 1
      ? `Download ${selectedDownloads.length} selected ${downloadNoun(selectedDownloads)}`
      : selectedDownloads[0]?.type === 'dir'
        ? 'Download selected folder'
        : 'Download selected file';
  const foldersUnavailable = !folderDownloads && selectedEntries.some((entry) => entry.type === 'dir');
  const downloadTooltip = foldersUnavailable ? FOLDER_DOWNLOADS_UNAVAILABLE : downloadLabel;
  // A right-click inside a selection of several acts on all of them.
  const menuTargets = !menu
    ? []
    : selectedEntries.length > 1 && selection.names.has(menu.entry.name)
      ? selectedEntries
      : [menu.entry];
  const menuFile = menuTargets.length === 1 && menu?.entry.type === 'file' ? menu.entry : undefined;
  const menuDownloads = menuTargets.filter(downloadable);
  return (
    <Box
      ref={panelRef}
      sx={{
        // Whatever holds it, the sidebar's card or a window, sets its size.
        width: '100%',
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: inSidebar ? 'sidebar' : 'background.paper',
        position: 'relative',
        containerType: 'inline-size',
        ...(inSidebar ? { '& .MuiTableCell-stickyHeader': { bgcolor: 'sidebar' } } : {}),
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
      <PanelHeader
        icon={<FolderOpenOutlinedIcon />}
        // Away from its terminal, the browser says whose files these are.
        title={inSidebar && hostLabel ? hostLabel : 'File browser'}
        caption="SFTP"
      >
        {onFullChange && (
          <Tooltip title={full ? 'Back to the sidebar (Esc)' : 'Fill the window'}>
            <IconButton
              size="small"
              aria-label={full ? 'Shrink file browser back to the sidebar' : 'Fill the window with the file browser'}
              aria-pressed={full}
              onClick={() => onFullChange(!full)}
            >
              {full ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
            </IconButton>
          </Tooltip>
        )}
        {onOpenInNewWindow && (
          <Tooltip title="Open file browser in new window">
            <IconButton
              size="small"
              aria-label="Open file browser in new window"
              onClick={() => onOpenInNewWindow(currentPath)}
            >
              <OpenInNewOutlinedIcon />
            </IconButton>
          </Tooltip>
        )}
      </PanelHeader>
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
      <Stack
        direction="row"
        spacing={0.25}
        useFlexGap
        sx={{ px: 0.75, pb: 0.75, alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}
      >
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
        <Tooltip title={downloadTooltip}>
          <span>
            <IconButton
              size="small"
              // With nothing it can download, it reads as its tooltip, which says why.
              aria-label={selectedDownloads.length > 0 ? downloadLabel : downloadTooltip}
              disabled={busy || selectedDownloads.length === 0}
              onClick={() => downloadFiles(selectedDownloads)}
            >
              <DownloadOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Open selected file in editor">
          <span>
            <IconButton
              size="small"
              aria-label="Open selected file in editor"
              disabled={busy || single?.type !== 'file'}
              onMouseEnter={() => void loadMonacoTextEditor()}
              onFocus={() => void loadMonacoTextEditor()}
              onClick={() => single && onOpenFile(remotePath(single))}
            >
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        {selectedEntries.length > 1 ? (
          <Typography
            variant="caption"
            color="textSecondary"
            noWrap
            sx={{ ml: 0.5, [NARROW_PANEL]: { flex: '1 1 0' } }}
          >
            {selectedEntries.length} selected
          </Typography>
        ) : (
          <Typography
            variant="caption"
            color="textDisabled"
            noWrap
            sx={{ ml: 0.5, flex: '1 1 0', [COMPACT_PANEL]: { display: 'none' } }}
          >
            Drag in to upload · drag out to download
          </Typography>
        )}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            ml: 'auto',
            flex: '1 1 140px',
            maxWidth: 232,
            [NARROW_PANEL]: { flexBasis: '100%', maxWidth: 'none' },
          }}
        >
          <TextField
            fullWidth
            placeholder="Filter by name"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !filter) return;
              event.preventDefault();
              setFilter('');
            }}
            slotProps={{
              htmlInput: { 'aria-label': 'Filter files by name' },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 16 }} />
                  </InputAdornment>
                ),
                sx: { fontSize: 12 },
              },
            }}
          />
          <Tooltip title={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}>
            <IconButton
              size="small"
              aria-label="Show hidden files"
              aria-pressed={showHiddenFiles}
              onClick={() => setPrefs({ showHiddenFiles: !showHiddenFiles })}
            >
              {showHiddenFiles ? (
                <VisibilityOutlinedIcon fontSize="small" />
              ) : (
                <VisibilityOffOutlinedIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Box>
      </Stack>
      {transfer && (
        <TransferProgress
          transfer={transfer}
          onCancel={() => {
            setTransfer((current) =>
              current ? { ...current, phase: 'cancelling', bytesPerSecond: 0 } : current,
            );
            transferControllerRef.current?.abort(TRANSFER_CANCELLED);
          }}
          sx={{ mx: 0.75, mb: 0.75 }}
        />
      )}
      {terminalUpload && (
        <TransferProgress
          transfer={terminalUpload}
          onCancel={terminalUpload.cancel}
          sx={{ mx: 0.75, mb: 0.75 }}
        />
      )}
      <Box
        // Focusable, so a click on a row brings the listing's keys along:
        // Ctrl/Cmd+A selects everything, Delete deletes, Esc clears.
        component="section"
        tabIndex={0}
        aria-label="Remote files"
        onKeyDown={onListingKeyDown}
        onClick={(event) => {
          // Empty space below the rows clears the selection, as in a file manager.
          if (event.target === event.currentTarget) setSelection(EMPTY_SFTP_SELECTION);
        }}
        sx={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
          '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
        }}
      >
        {(isFetching || busy) && !transfer && <CircularProgress size={18} sx={{ position: 'absolute', zIndex: 2, top: 8, right: 12 }} />}
        {error ? (
          <Typography variant="body2" color="error" sx={{ p: 2 }}>
            {error instanceof Error ? error.message : String(error)}
          </Typography>
        ) : (
          <SftpEntryTable
            connId={connId}
            currentPath={currentPath}
            entries={visibleEntries}
            isFetching={isFetching}
            emptyLabel={emptyLabel}
            selectedNames={selection.names}
            onNavigate={navigate}
            onOpenFile={onOpenFile}
            onSelect={select}
            onContextMenu={openContextMenu}
            sort={sort}
            onSortChange={setSort}
          />
        )}
      </Box>
      {onFollowTerminalFolderChange && (
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              disabled={followTerminalFolderUnavailable}
              checked={followTerminalFolder}
              onChange={(event) => onFollowTerminalFolderChange(event.target.checked)}
            />
          )}
          label="Follow terminal folder"
          title={followTerminalFolderUnavailable ? SYSTEM_OPENSSH_UNAVAILABLE : undefined}
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
            <Typography variant="caption" color="textSecondary" sx={{ wordBreak: 'break-all' }}>
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
        {menuFile && (
          <MenuItem
            onMouseEnter={() => void loadMonacoTextEditor()}
            onFocus={() => void loadMonacoTextEditor()}
            onClick={() => {
              onOpenFile(remotePath(menuFile));
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <EditOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Open in editor</ListItemText>
          </MenuItem>
        )}
        {menuFile && localOpen && (
          <MenuItem
            onClick={() => {
              openLocally(menuFile, remotePath(menuFile), { kind: 'default' });
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <LaunchOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Open with default program</ListItemText>
          </MenuItem>
        )}
        {menuFile && localChooser && (
          <MenuItem
            onClick={() => {
              openWith(menuFile);
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <AppsOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Open with…</ListItemText>
          </MenuItem>
        )}
        {menuDownloads.length > 0 && (
          <MenuItem
            onClick={() => {
              downloadFiles(menuDownloads);
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <DownloadOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              {menuDownloads.length > 1
                ? `Download ${menuDownloads.length} ${downloadNoun(menuDownloads)}`
                : 'Download'}
            </ListItemText>
          </MenuItem>
        )}
        {menuFile && (
          <MenuItem
            onMouseEnter={() => void loadCompareDialog()}
            onFocus={() => void loadCompareDialog()}
            onClick={() => {
              const path = remotePath(menuFile);
              openCompare(() => remoteFileCompareText(connId, hostLabel ?? 'SFTP', path));
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <CompareArrowsIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Compare with…</ListItemText>
          </MenuItem>
        )}
        {menuTargets.length < 2 && (
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
        )}
        <MenuItem
          onClick={() => {
            remove(menuTargets);
            setMenu(null);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon sx={{ color: 'error.main' }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>
            {menuTargets.length > 1 ? `Delete ${menuTargets.length} items` : 'Delete'}
          </ListItemText>
        </MenuItem>
      </Menu>
      {openWithFile && (
        <OpenWithDialog
          fileName={openWithFile.entry.name}
          onClose={() => setOpenWithFile(undefined)}
          onOpen={(target) => {
            setOpenWithFile(undefined);
            openLocally(openWithFile.entry, openWithFile.path, target);
          }}
        />
      )}
    </Box>
  );
}
