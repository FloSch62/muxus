import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
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
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FolderIcon from '@mui/icons-material/Folder';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type { SftpEntry } from '@muxus/shared';
import { ApiError, apiFetch, apiFetchRaw } from '../api/http.js';
import { useSftpHome, useSftpList } from '../api/queries.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { layout } from '../theme.js';

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function parentPath(dir: string): string {
  if (dir === '/') return '/';
  const idx = dir.lastIndexOf('/');
  return idx <= 0 ? '/' : dir.slice(0, idx);
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

function formatMtime(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * SFTP browser bound to the active SSH tab's connection. Double-click
 * navigates directories and downloads files; upload via button or
 * drag-and-drop; the context menu covers rename/delete/new-folder.
 */
export function SftpPanel({ connId }: { connId: string }) {
  const { data: home } = useSftpHome(connId);
  const [path, setPath] = useState<string | undefined>();
  const [pathInput, setPathInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (home && !path) {
      setPath(home.path);
      setPathInput(home.path);
    }
  }, [home, path]);

  const { data, isFetching, error } = useSftpList(connId, path);
  const entries = [...(data?.entries ?? [])].sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const navigate = (next: string) => {
    setPath(next);
    setPathInput(next);
  };
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['sftp-list', connId] });

  const download = (entry: SftpEntry) => {
    void (async () => {
      try {
        const res = await apiFetchRaw(`/api/sftp/${connId}/download?path=${encodeURIComponent(joinPath(path!, entry.name))}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        showErrorToast(err);
      }
    })();
  };

  const upload = (files: FileList | File[]) => {
    if (!path) return;
    void (async () => {
      setBusy(true);
      try {
        let uploaded = 0;
        for (const file of files) {
          const destination = joinPath(path, file.name);
          const send = (overwrite: boolean) =>
            apiFetchRaw(
              `/api/sftp/${connId}/upload?path=${encodeURIComponent(destination)}${overwrite ? '&overwrite=true' : ''}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: file,
              },
            );
          try {
            await send(false);
            uploaded++;
          } catch (err) {
            if (
              !(err instanceof ApiError) ||
              err.status !== 409 ||
              err.body?.code !== 'SFTP_DESTINATION_EXISTS'
            ) {
              throw err;
            }
            if (!window.confirm(`${file.name} already exists on the remote host. Replace it?`)) continue;
            await send(true);
            uploaded++;
          }
        }
        if (uploaded > 0) {
          showToast('success', `Uploaded ${uploaded === 1 ? '1 file' : `${uploaded} files`}`);
          refresh();
        }
      } catch (err) {
        showErrorToast(err);
      } finally {
        setBusy(false);
      }
    })();
  };

  const run = (op: () => Promise<unknown>) => {
    void (async () => {
      setBusy(true);
      try {
        await op();
        refresh();
      } catch (err) {
        showErrorToast(err);
      } finally {
        setBusy(false);
      }
    })();
  };

  const mkdir = () => {
    const name = window.prompt('New folder name');
    if (!name || !path) return;
    run(() => apiFetch(`/api/sftp/${connId}/mkdir`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: joinPath(path, name) }) }));
  };

  const rename = (entry: SftpEntry) => {
    const name = window.prompt(`Rename ${entry.name} to`, entry.name);
    if (!name || name === entry.name || !path) return;
    run(() =>
      apiFetch(`/api/sftp/${connId}/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: joinPath(path, entry.name), to: joinPath(path, name) }),
      }),
    );
  };

  const remove = (entry: SftpEntry) => {
    if (!path || !window.confirm(`Delete ${entry.name}${entry.type === 'dir' ? ' and everything in it' : ''}?`)) return;
    run(() =>
      apiFetch(`/api/sftp/${connId}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: joinPath(path, entry.name) }),
      }),
    );
  };

  return (
    <Box
      sx={{
        width: layout.sftpPanelWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        ...(dragOver && { outline: '2px dashed', outlineColor: 'primary.main', outlineOffset: -4 }),
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      <Stack direction="row" spacing={0.5} sx={{ p: 1, pb: 0.5, alignItems: 'center' }}>
        <Tooltip title="Up">
          <span>
            <IconButton size="small" aria-label="Parent directory" disabled={!path || path === '/'} onClick={() => path && navigate(parentPath(path))}>
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Home">
          <IconButton size="small" aria-label="Home directory" onClick={() => home && navigate(home.path)}>
            <HomeOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <TextField
          fullWidth
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pathInput.trim()) navigate(pathInput.trim());
          }}
          slotProps={{ input: { sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 12 } } }}
        />
        <Tooltip title="Refresh">
          <IconButton size="small" aria-label="Refresh listing" onClick={refresh}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="New folder">
          <IconButton size="small" aria-label="New folder" onClick={mkdir}>
            <CreateNewFolderOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Upload files">
          <IconButton size="small" aria-label="Upload files" onClick={() => fileInputRef.current?.click()}>
            <UploadFileOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) upload(e.target.files);
            e.target.value = '';
          }}
        />
      </Stack>
      <Box sx={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {(isFetching || busy) && <CircularProgress size={18} sx={{ position: 'absolute', top: 8, right: 12 }} />}
        {error ? (
          <Typography variant="body2" color="error" sx={{ p: 2 }}>
            {error instanceof Error ? error.message : String(error)}
          </Typography>
        ) : (
          <Table size="small" stickyHeader sx={{ '& td, & th': { py: 0.4, fontSize: 12 } }}>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell align="right" sx={{ width: 72 }}>
                  Size
                </TableCell>
                <TableCell sx={{ width: 118 }}>Modified</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => (
                <TableRow
                  key={entry.name}
                  hover
                  sx={{ cursor: 'pointer', userSelect: 'none' }}
                  onDoubleClick={() => (entry.type === 'dir' ? navigate(joinPath(path!, entry.name)) : download(entry))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, entry });
                  }}
                >
                  <TableCell sx={{ display: 'flex', alignItems: 'center', gap: 0.75, border: 0, minWidth: 0 }}>
                    {entry.type === 'dir' ? (
                      <FolderIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                    ) : entry.type === 'link' ? (
                      <LinkOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                    ) : (
                      <DescriptionOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                    )}
                    <Typography variant="body2" noWrap sx={{ fontSize: 12 }}>
                      {entry.name}
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                    {entry.type === 'file' ? formatSize(entry.size) : ''}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>{formatMtime(entry.mtimeMs)}</TableCell>
                </TableRow>
              ))}
              {entries.length === 0 && !isFetching && (
                <TableRow>
                  <TableCell colSpan={3} sx={{ color: 'text.secondary', textAlign: 'center', border: 0, py: 3 }}>
                    Empty directory
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Box>
      <Menu open={!!menu} onClose={() => setMenu(null)} anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}>
        {menu?.entry.type !== 'dir' && (
          <MenuItem
            onClick={() => {
              if (menu) download(menu.entry);
              setMenu(null);
            }}
          >
            Download
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            if (menu) rename(menu.entry);
            setMenu(null);
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) remove(menu.entry);
            setMenu(null);
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </Box>
  );
}
