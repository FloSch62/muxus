import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import type { ContainerlabLab, ContainerlabTopologyResponse } from '@muxus/shared';
import { fetchContainerlabTopology } from '../../api/environments.js';
import { environmentSource, isRunning } from '../../environments.js';
import { nodeUsesSsh, openContainerlabNode } from '../../environment-sessions.js';
import type { HostEnvironmentsEntry } from '../../state/environments.js';
import { MONO, StatusDot } from './EnvironmentTree.js';

/** The vendored containerlab viewer (client/public/vendor/clab-viewer). */
const VIEWER_PATH = '/vendor/clab-viewer/viewer.html';

type TopologyState =
  | { status: 'loading' }
  | { status: 'ready'; topology: ContainerlabTopologyResponse }
  | { status: 'error'; message: string };

/**
 * A running lab's topology, drawn by the containerlab viewer in a frame of
 * its own (it brings its own React). Selecting a node offers to open it.
 */
export function ClabTopologyDialog({
  host,
  lab,
  onClose,
}: {
  host: HostEnvironmentsEntry;
  lab: ContainerlabLab | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<TopologyState>({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  });

  const labName = lab?.name;
  const runtime = lab?.runtime;
  useEffect(() => {
    if (!labName || !runtime) return;
    let live = true;
    setState({ status: 'loading' });
    setSelected(null);
    setViewerError(null);
    void (async () => {
      try {
        const source = await environmentSource(hostRef.current, true);
        if (!source) throw new Error(`${hostRef.current.label} is not connected`);
        const topology = await fetchContainerlabTopology(source, runtime, labName);
        if (live) setState({ status: 'ready', topology });
      } catch (error) {
        if (live) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [labName, runtime]);

  const mode = theme.palette.mode;
  const appearance = useMemo(
    () => ({
      background: theme.palette.background.default,
      foreground: theme.palette.text.primary,
      surface: theme.palette.background.paper,
      border: theme.palette.divider,
      accent: theme.palette.primary.main,
    }),
    [theme],
  );

  // The frame says it is ready; it gets the lab in return, and tells us what is selected.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const { yaml, annotations } = state.topology;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; id?: unknown; message?: unknown } | null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'clab-viewer:ready') {
        frame.postMessage(
          {
            type: 'clab-viewer:render',
            yaml,
            ...(annotations ? { annotations } : {}),
            theme: mode,
            options: {
              controls: true,
              background: 'dots',
              linkLabels: 'on-select',
              linkHover: true,
              fitPadding: 0.6,
              appearance,
            },
          },
          window.location.origin,
        );
      } else if (data.type === 'clab-viewer:select') {
        setSelected(typeof data.id === 'string' ? data.id : null);
      } else if (data.type === 'clab-viewer:error') {
        setViewerError(typeof data.message === 'string' ? data.message : 'The topology could not be drawn.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [state, mode, appearance]);

  // A theme switch reaches a drawn topology without drawing it again.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'clab-viewer:theme', theme: mode }, window.location.origin);
  }, [mode]);

  const node = lab?.nodes.find((candidate) => candidate.name === selected);
  const frameSrc = `${VIEWER_PATH}?${new URLSearchParams({ parentOrigin: window.location.origin }).toString()}`;

  return (
    <Dialog open={!!lab} onClose={onClose} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: '82vh' } } }}>
      <Stack direction="row" spacing={1} sx={{ px: 2, py: 1.25, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }} noWrap>
            {lab?.name}
          </Typography>
          <Typography variant="caption" color="textSecondary" noWrap sx={{ display: 'block', ...MONO }}>
            {host.label} · {state.status === 'ready' ? state.topology.path : lab?.topologyFile}
          </Typography>
        </Box>
        <IconButton aria-label="Close" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state.status === 'loading' ? (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={28} />
          </Box>
        ) : null}
        {state.status === 'error' ? (
          <Alert severity="error" sx={{ m: 2 }}>
            {state.message}
          </Alert>
        ) : null}
        {viewerError ? (
          <Alert severity="warning" sx={{ m: 2 }}>
            {viewerError}
          </Alert>
        ) : null}
        {state.status === 'ready' ? (
          <Box
            component="iframe"
            ref={frameRef}
            title={`Topology of ${lab?.name ?? 'the lab'}`}
            src={frameSrc}
            sx={{ border: 0, width: '100%', height: '100%', display: 'block' }}
          />
        ) : null}
      </Box>
      {node && lab ? (
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ px: 2, py: 1, alignItems: 'center', borderTop: 1, borderColor: 'divider' }}
        >
          <StatusDot health={isRunning(node.state) ? 'up' : 'off'} />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {node.name}
          </Typography>
          <Typography variant="caption" color="textSecondary">
            {node.kind}
          </Typography>
          {node.ipv4 ? (
            <Typography variant="caption" color="textSecondary" sx={MONO}>
              {node.ipv4}
            </Typography>
          ) : null}
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant="contained"
            disabled={!isRunning(node.state)}
            startIcon={nodeUsesSsh(node) ? <LoginOutlinedIcon /> : <TerminalOutlinedIcon />}
            onClick={() => {
              openContainerlabNode(host, lab, node);
              onClose();
            }}
          >
            {nodeUsesSsh(node) ? 'SSH as admin' : 'Open shell'}
          </Button>
        </Stack>
      ) : null}
    </Dialog>
  );
}
