import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { AppWindowLaunch } from '@muxus/shared';
import { wsProtocols, wsUrl } from '../api/http.js';
import { loadRemoteEditorWorkspace, loadSftpPanel } from '../lazy-features.js';
import { layout } from '../theme.js';

const SftpPanel = lazy(() =>
  loadSftpPanel().then((module) => ({ default: module.SftpPanel })),
);
const RemoteEditorWorkspace = lazy(() =>
  loadRemoteEditorWorkspace().then((module) => ({ default: module.RemoteEditorWorkspace })),
);

type SftpLaunch = Extract<AppWindowLaunch, { kind: 'sftp' }>;

/** Standalone Remote Explorer window attached to the source tab's transport. */
export function SftpWindow({ launch }: { launch: SftpLaunch }) {
  const editorId = useRef(`sftp-window-${launch.connId}`);
  const [editorPaths, setEditorPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string>();

  useEffect(() => {
    document.title = `${launch.title} — SFTP — Muxus`;
    const socket = new WebSocket(
      wsUrl(`/ws/sftp/${encodeURIComponent(launch.connId)}/lease`),
      wsProtocols(),
    );
    return () => socket.close();
  }, [launch.connId, launch.title]);

  useEffect(
    () =>
      window.muxusDesktop?.onCloseTab(() => {
        window.muxusDesktop?.closeWindow();
      }),
    [],
  );

  const openFile = (path: string) => {
    setEditorPaths((current) => (current.includes(path) ? current : [...current, path]));
    setActivePath(path);
  };

  const closeFile = (path: string) => {
    const index = editorPaths.indexOf(path);
    const next = editorPaths.filter((candidate) => candidate !== path);
    setEditorPaths(next);
    setActivePath((active) =>
      active === path ? next[Math.min(index, next.length - 1)] : active,
    );
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" color="transparent" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar
          variant="dense"
          sx={{
            gap: 1.25,
            minHeight: layout.topBarHeight,
            WebkitAppRegion: 'drag',
            '&&': {
              pl: 'calc(env(titlebar-area-x, 0px) + 16px)',
              pr: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 16px)',
            },
          }}
        >
          <Box component="img" src="/muxus.svg" alt="" aria-hidden sx={{ width: 26, height: 26 }} />
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline', minWidth: 0 }}>
            <Typography variant="subtitle1" noWrap sx={{ fontWeight: 700 }}>
              {launch.title}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              SFTP
            </Typography>
          </Stack>
        </Toolbar>
      </AppBar>
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Suspense fallback={null}>
          <SftpPanel
            connId={launch.connId}
            initialPath={launch.path}
            fill={editorPaths.length === 0}
            onOpenFile={openFile}
          />
          {editorPaths.length > 0 && (
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <RemoteEditorWorkspace
                tabId={editorId.current}
                connId={launch.connId}
                paths={editorPaths}
                activePath={activePath}
                onActivate={setActivePath}
                onClose={closeFile}
              />
            </Box>
          )}
        </Suspense>
      </Box>
    </Box>
  );
}
