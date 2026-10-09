import { useEffect, useRef, useState, type DOMAttributes, type DragEvent, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import FolderOffOutlinedIcon from '@mui/icons-material/FolderOffOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AppInfo } from '@muxus/shared';
import { apiFetch } from '../api/http.js';
import { collectDrop } from '../sftp-upload.js';
import type { SessionTab } from '../state/tabs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { startTerminalUpload } from '../terminal-upload.js';
import { droppedPathsText, localShellPathStyle, type DroppedPathStyle } from '../terminal/drop-paths.js';
import {
  dropEffectFor,
  dropOverlayText,
  internalDragInProgress,
  isExternalFileDrag,
  isInsertPathsModifier,
  terminalDropIntent,
  trackInternalDrags,
  type TerminalDropIntent,
} from '../terminal/file-drop.js';

function remoteHomeQuery(connId: string | undefined) {
  return {
    queryKey: ['sftp-home', connId],
    queryFn: () => apiFetch<{ path: string }>(`/api/sftp/${connId}/home`).then(({ path }) => path),
    staleTime: Infinity,
    retry: false,
  };
}

async function pathStyleFor(tab: SessionTab, queryClient: QueryClient): Promise<DroppedPathStyle> {
  if (tab.profile.kind !== 'local') return { quoting: 'posix' };
  const info = await queryClient.ensureQueryData({
    queryKey: ['app-info'],
    queryFn: () => apiFetch<AppInfo>('/api/app/info'),
    staleTime: Infinity,
  });
  return localShellPathStyle(tab.profile, info.defaultShell, info.platform);
}

function TerminalDropOverlay({ intent }: { intent: Exclude<TerminalDropIntent, { kind: 'refuse' }> }) {
  const { title, caption } = dropOverlayText(intent);
  const unavailable = intent.kind === 'unavailable';
  const Icon =
    intent.kind === 'upload'
      ? UploadFileOutlinedIcon
      : intent.kind === 'insert'
        ? TerminalOutlinedIcon
        : FolderOffOutlinedIcon;
  return (
    <Box
      data-terminal-drop-overlay={intent.kind}
      sx={(theme) => ({
        position: 'absolute',
        inset: theme.spacing(1.25, 1.5, 1.5),
        zIndex: 7,
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
        border: '2px dashed',
        borderColor: unavailable ? 'text.disabled' : 'primary.main',
        borderRadius: 2,
        bgcolor: alpha(theme.palette.background.paper, 0.9),
        boxShadow: unavailable ? 'none' : `inset 0 0 40px ${alpha(theme.palette.primary.main, 0.12)}`,
      })}
    >
      <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center', px: 3 }}>
        <Icon color={unavailable ? 'disabled' : 'primary'} sx={{ fontSize: 38 }} />
        <Typography variant="subtitle2" sx={{ wordBreak: 'break-all' }}>
          {title}
        </Typography>
        {caption && (
          <Typography variant="caption" color="textSecondary">
            {caption}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

/**
 * Files dropped from outside the window onto a terminal: uploaded into the
 * SSH shell's directory, or typed as shell-quoted paths. Returns the drag
 * handlers for the terminal's frame and the overlay shown while dragging.
 */
export function useTerminalFileDrop(
  tab: SessionTab,
  insertText: (text: string) => void,
  focus: () => void,
): {
  handlers: Pick<DOMAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  overlay: ReactNode;
} {
  // Null while no files are over the terminal, else whether the insert modifier is held.
  const [insertModifier, setInsertModifier] = useState<boolean | null>(null);
  const depthRef = useRef(0);
  const queryClient = useQueryClient();
  const canInsertPaths = !!window.muxusDesktop?.getPathForFile;
  useEffect(() => trackInternalDrags(), []);

  const dragging = insertModifier !== null;
  const needsHome =
    dragging &&
    tab.profile.kind === 'ssh' &&
    !!tab.connId &&
    tab.sftpAvailable !== false &&
    !tab.terminalCwd;
  const { data: home } = useQuery({ ...remoteHomeQuery(tab.connId), enabled: needsHome });

  const intentFor = (modifier: boolean): TerminalDropIntent =>
    terminalDropIntent({
      profileKind: tab.profile.kind,
      status: tab.status,
      ...(tab.connId ? { connId: tab.connId } : {}),
      ...(tab.sftpAvailable === undefined ? {} : { sftpAvailable: tab.sftpAvailable }),
      ...(tab.terminalCwd ? { cwd: tab.terminalCwd } : {}),
      ...(home ? { home } : {}),
      insertModifier: modifier,
      canInsertPaths,
    });

  const isFileDrag = (event: DragEvent) =>
    isExternalFileDrag(event.dataTransfer, internalDragInProgress());

  const insertPaths = (files: File[]) => {
    const paths = files
      .map((file) => window.muxusDesktop?.getPathForFile?.(file) ?? '')
      .filter(Boolean);
    if (paths.length === 0) {
      showToast('warning', 'The dropped items have no local paths to insert.');
      return;
    }
    void pathStyleFor(tab, queryClient)
      .then((style) => {
        insertText(droppedPathsText(paths, style));
        focus();
      })
      .catch(showErrorToast);
  };

  const upload = (items: DataTransferItem[], directory: string | undefined) => {
    const connId = tab.connId;
    if (!connId) return;
    // The drop's items can only be read before this handler returns.
    const collecting = collectDrop(items);
    collecting.catch(() => undefined);
    focus();
    void startTerminalUpload({
      connId,
      host: tab.title,
      prepare: async () => {
        const [payload, target] = await Promise.all([
          collecting,
          directory ?? queryClient.fetchQuery(remoteHomeQuery(connId)),
        ]);
        return { payload, directory: target };
      },
      refresh: (id) => void queryClient.invalidateQueries({ queryKey: ['sftp-list', id] }),
    });
  };

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depthRef.current++;
      setInsertModifier(isInsertPathsModifier(event));
    },
    onDragOver: (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // Even a refused drop is handled here, so the browser does not open the file.
      event.preventDefault();
      const modifier = isInsertPathsModifier(event);
      event.dataTransfer.dropEffect = dropEffectFor(intentFor(modifier));
      setInsertModifier(modifier);
    },
    onDragLeave: (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setInsertModifier(null);
    },
    onDrop: (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depthRef.current = 0;
      setInsertModifier(null);
      const intent = intentFor(isInsertPathsModifier(event));
      if (intent.kind === 'insert') insertPaths(Array.from(event.dataTransfer.files));
      else if (intent.kind === 'upload') upload(Array.from(event.dataTransfer.items), intent.directory);
    },
  };

  const intent = dragging ? intentFor(insertModifier) : undefined;
  const overlay =
    intent && intent.kind !== 'refuse' ? <TerminalDropOverlay intent={intent} /> : null;
  return { handlers, overlay };
}
