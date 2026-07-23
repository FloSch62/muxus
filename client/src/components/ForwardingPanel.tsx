import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import StopIcon from '@mui/icons-material/Stop';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigForward, ConnectionInfo, ForwardInfo, SshHostEntry, TunnelRecord } from '@muxus/shared';
import { apiFetch } from '../api/http.js';
import { useConnections, useForwards, useSshConfig, useTunnels } from '../api/queries.js';
import { useUpsertHost } from '../api/ssh-config.js';
import { adoptForward, deleteTunnel, saveTunnel, startTunnel, stopForward } from '../api/tunnels.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';
import { layout, statusTextColor } from '../theme.js';
import { AuthPromptDialog, type AuthPromptRequest } from './AuthPromptDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';
import { FORWARD_FLAG, ForwardRuleForm, describeForward } from './ForwardRuleForm.js';
import { TunnelEditorDialog, type TunnelEditorState } from './TunnelEditorDialog.js';

const MONO = { fontFamily: '"JetBrains Mono", monospace' } as const;

/**
 * Global forwarding side panel: saved tunnels started/stopped independently
 * of terminals (each running tunnel holds its own transport lease), plus the
 * live forwards of every open connection.
 */
export function ForwardingPanel() {
  const queryClient = useQueryClient();
  const setForwardingOpen = useUiStore((s) => s.setForwardingOpen);
  const { data: forwardsData } = useForwards();
  const { data: connectionsData } = useConnections();
  const { data: tunnelsData } = useTunnels();
  const { data: config } = useSshConfig();

  const forwards = forwardsData?.forwards ?? [];
  const connections = connectionsData?.connections ?? [];
  const tunnels = tunnelsData?.tunnels ?? [];

  const [editor, setEditor] = useState<TunnelEditorState | null>(null);
  const [adhocConn, setAdhocConn] = useState<ConnectionInfo | null>(null);
  const [tunnelMenu, setTunnelMenu] = useState<{ anchor: HTMLElement; tunnel: TunnelRecord } | null>(null);
  /** tunnelId → progress message while a start (dial + forward) is in flight. */
  const [starting, setStarting] = useState<Record<string, string>>({});
  const [dialAuth, setDialAuth] = useState<{ request: AuthPromptRequest; resolve: (answers: string[] | null) => void } | null>(null);
  const [dialHostKey, setDialHostKey] = useState<{ request: HostKeyRequest; resolve: (accept: boolean) => void } | null>(null);

  const anyStarting = Object.keys(starting).length > 0;
  const runningByTunnel = new Map(forwards.filter((f) => f.tunnelId).map((f) => [f.tunnelId!, f]));
  const tunnelIds = new Set(tunnels.map((t) => t.id));
  /** Forwards not realizing a saved tunnel (config/ad-hoc/orphaned). */
  const sessionForwards = forwards.filter((f) => !f.tunnelId || !tunnelIds.has(f.tunnelId));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['forwards'] });
    void queryClient.invalidateQueries({ queryKey: ['connections'] });
    void queryClient.invalidateQueries({ queryKey: ['tunnels'] });
  };

  const startFlow = async (tunnel: TunnelRecord) => {
    setStarting((s) => ({ ...s, [tunnel.id]: 'Starting…' }));
    try {
      await startTunnel(tunnel, {
        onStatus: (message) => setStarting((s) => (tunnel.id in s ? { ...s, [tunnel.id]: message } : s)),
        onAuthPrompt: (request) => new Promise((resolve) => setDialAuth({ request, resolve })),
        onHostKey: (request) => new Promise((resolve) => setDialHostKey({ request, resolve })),
      });
      showToast('success', `Tunnel up — ${describeForward(tunnel)}`);
    } catch (err) {
      showErrorToast(err);
    } finally {
      setStarting((s) => {
        const { [tunnel.id]: _done, ...rest } = s;
        return rest;
      });
      invalidate();
    }
  };

  const stop = useMutation({
    mutationFn: stopForward,
    onSuccess: invalidate,
    onError: showErrorToast,
  });

  const removeTunnel = useMutation({
    mutationFn: async (tunnel: TunnelRecord) => {
      const running = runningByTunnel.get(tunnel.id);
      if (running) await stopForward(running.id);
      await deleteTunnel(tunnel.id);
    },
    onSuccess: invalidate,
    onError: showErrorToast,
  });

  const saveAsTunnel = useMutation({
    mutationFn: async (forward: ForwardInfo) => {
      const conn = connections.find((c) => c.id === forward.connId);
      if (!conn) throw new Error('connection is gone');
      const record = await saveTunnel({
        target: conn.target,
        type: forward.type,
        bindPort: forward.bindPort,
        targetHost: forward.targetHost,
        targetPort: forward.targetPort,
      });
      await adoptForward(forward.id, record.id);
    },
    onSuccess: () => {
      showToast('success', 'Saved — the tunnel can now be started without a terminal.');
      invalidate();
    },
    onError: showErrorToast,
  });

  const adhocStart = useMutation({
    mutationFn: (input: { connId: string; rule: ConfigForward }) =>
      apiFetch('/api/forwards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connId: input.connId, ...input.rule }),
      }),
    onSuccess: () => {
      setAdhocConn(null);
      invalidate();
    },
    onError: showErrorToast,
  });

  const upsertHost = useUpsertHost(() => showToast('success', 'Saved to ssh config — starts with every connection.'));

  const bookmarkIntoConfig = (conn: ConnectionInfo, f: ForwardInfo) => {
    const entry = hostEntryFor(config?.hosts, conn);
    if (!entry) return;
    const rule: ConfigForward =
      f.type === 'dynamic'
        ? { type: f.type, bindPort: f.bindPort }
        : { type: f.type, bindPort: f.bindPort, targetHost: f.targetHost, targetPort: f.targetPort };
    upsertHost.mutate({
      aliases: entry.aliases,
      description: entry.description,
      file: entry.file,
      previousAlias: entry.alias,
      options: { ...entry.options, forwards: [...(entry.options.forwards ?? []), rule] },
    });
  };

  const onTunnelSaved = (record: TunnelRecord, start: boolean) => {
    invalidate();
    const running = runningByTunnel.get(record.id);
    if (!start) return;
    if (running) {
      // Save & restart: replace the live forward with the new definition.
      void stopForward(running.id)
        .catch(() => undefined)
        .then(() => startFlow(record));
    } else {
      void startFlow(record);
    }
  };

  return (
    <Box
      sx={{
        width: layout.forwardingPanelWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'sidebar',
        borderLeft: 1,
        borderColor: 'divider',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <SwapHorizOutlinedIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1 }}>
          Port forwarding
        </Typography>
        <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setEditor({})}>
          Tunnel
        </Button>
        <IconButton size="small" aria-label="Close forwarding panel" onClick={() => setForwardingOpen(false)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Box sx={{ flex: 1, overflowY: 'auto', py: 1 }}>
        <SectionLabel>Persistent tunnels</SectionLabel>
        {tunnels.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, pb: 1 }}>
            Saved tunnels start and stop port forwarding without opening a terminal — closing terminals never
            takes a running tunnel down.
          </Typography>
        )}
        {tunnels.map((tunnel) => {
          const running = runningByTunnel.get(tunnel.id);
          const busy = starting[tunnel.id];
          return (
            <Stack
              key={tunnel.id}
              direction="row"
              spacing={1}
              sx={{ px: 1.5, py: 0.75, alignItems: 'center', '&:hover .tunnel-row-menu': { opacity: 1 } }}
            >
              <Box
                sx={(theme) => ({
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  bgcolor: running
                    ? running.status === 'error'
                      ? statusTextColor('error')(theme)
                      : statusTextColor('success')(theme)
                    : theme.palette.text.disabled,
                })}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {tunnel.name || tunnel.target}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', ...MONO, fontSize: 11 }}>
                  {busy ?? `${FORWARD_FLAG[tunnel.type]} ${describeForward(tunnel)}`}
                </Typography>
                <Typography variant="caption" color="text.disabled" noWrap sx={{ display: 'block', fontSize: 11 }}>
                  {describeTunnelConnection(tunnel)}
                </Typography>
                {running?.error && (
                  <Typography variant="caption" sx={{ color: 'error.main', display: 'block' }} noWrap>
                    {running.error}
                  </Typography>
                )}
              </Box>
              {busy ? (
                <CircularProgress size={18} sx={{ mx: 0.75 }} />
              ) : running ? (
                <Tooltip title="Stop tunnel">
                  <IconButton size="small" aria-label={`Stop tunnel ${tunnel.name ?? tunnel.id}`} onClick={() => stop.mutate(running.id)}>
                    <StopIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              ) : (
                <Tooltip title={`Start tunnel (via ${tunnel.target})`}>
                  <span>
                    <IconButton
                      size="small"
                      color="primary"
                      aria-label={`Start tunnel ${tunnel.name ?? tunnel.id}`}
                      disabled={anyStarting}
                      onClick={() => void startFlow(tunnel)}
                    >
                      <PlayArrowIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              <IconButton
                className="tunnel-row-menu"
                size="small"
                aria-label={`Options for tunnel ${tunnel.name ?? tunnel.id}`}
                sx={{ opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms' }}
                onClick={(e) => setTunnelMenu({ anchor: e.currentTarget, tunnel })}
              >
                <Box component="span" sx={{ fontSize: 16, lineHeight: 1 }}>
                  ⋮
                </Box>
              </IconButton>
            </Stack>
          );
        })}

        <Divider sx={{ my: 1 }} />
        <SectionLabel>Connections</SectionLabel>
        {connections.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, pb: 1 }}>
            No live SSH connections. Forwards on open sessions appear here.
          </Typography>
        )}
        {connections.map((conn) => (
          <ConnectionGroup
            key={conn.id}
            conn={conn}
            forwards={sessionForwards.filter((f) => f.connId === conn.id)}
            hasHostEntry={!!hostEntryFor(config?.hosts, conn)}
            onAdd={() => setAdhocConn(conn)}
            onStop={(id) => stop.mutate(id)}
            onSaveAsTunnel={(f) => saveAsTunnel.mutate(f)}
            savePending={saveAsTunnel.isPending}
            onBookmark={(f) => bookmarkIntoConfig(conn, f)}
          />
        ))}
      </Box>

      <Menu open={!!tunnelMenu} anchorEl={tunnelMenu?.anchor} onClose={() => setTunnelMenu(null)}>
        <MenuItem
          onClick={() => {
            if (tunnelMenu) setEditor({ tunnel: tunnelMenu.tunnel });
            setTunnelMenu(null);
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Edit tunnel
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (tunnelMenu) removeTunnel.mutate(tunnelMenu.tunnel);
            setTunnelMenu(null);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon sx={{ color: 'error.main' }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          Delete tunnel
        </MenuItem>
      </Menu>

      <TunnelEditorDialog state={editor} onClose={() => setEditor(null)} onSaved={onTunnelSaved} />

      <Dialog open={!!adhocConn} onClose={() => setAdhocConn(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Forward on {adhocConn?.target}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Belongs to this terminal session; save it as a tunnel to keep it after the terminal closes.
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 0.5 }}>
            <ForwardRuleForm
              serverLabel={adhocConn?.target ?? 'SSH server'}
              busy={adhocStart.isPending}
              submitLabel="Start"
              onAdd={(rule) => adhocConn && adhocStart.mutate({ connId: adhocConn.id, rule })}
            />
          </Box>
        </DialogContent>
      </Dialog>

      <AuthPromptDialog
        request={dialAuth?.request ?? null}
        onSubmit={(answers) => {
          dialAuth?.resolve(answers);
          setDialAuth(null);
        }}
      />
      <HostKeyDialog
        request={dialHostKey?.request ?? null}
        onAnswer={(accept) => {
          dialHostKey?.resolve(accept);
          setDialHostKey(null);
        }}
      />
    </Box>
  );
}

function hostEntryFor(hosts: SshHostEntry[] | undefined, conn: ConnectionInfo): SshHostEntry | undefined {
  if (!conn.metadataAlias) return undefined;
  return hosts?.find((h) => h.aliases.includes(conn.metadataAlias!));
}

function describeTunnelConnection(tunnel: TunnelRecord): string {
  if (tunnel.sshOptions === undefined) return `SSH config · ${tunnel.target}`;
  const options = tunnel.sshOptions;
  const endpoint = `${options.user ? `${options.user}@` : ''}${tunnel.target}${options.port ? `:${options.port}` : ''}`;
  const route = options.proxyJump?.length
    ? `${options.proxyJump.length} jump${options.proxyJump.length === 1 ? '' : 's'}`
    : 'direct';
  const auth = options.passwordOnly
    ? 'password'
    : options.identityFiles?.length
      ? `${options.identityFiles.length} key${options.identityFiles.length === 1 ? '' : 's'}`
      : 'agent / defaults';
  return `${endpoint} · ${route} · ${auth}`;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Typography
      sx={{
        px: 1.5,
        pb: 0.5,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        color: 'text.secondary',
      }}
    >
      {children}
    </Typography>
  );
}

function ConnectionGroup({
  conn,
  forwards,
  hasHostEntry,
  onAdd,
  onStop,
  onSaveAsTunnel,
  savePending,
  onBookmark,
}: {
  conn: ConnectionInfo;
  forwards: ForwardInfo[];
  hasHostEntry: boolean;
  onAdd: () => void;
  onStop: (id: string) => void;
  onSaveAsTunnel: (f: ForwardInfo) => void;
  savePending: boolean;
  onBookmark: (f: ForwardInfo) => void;
}) {
  return (
    <Box sx={{ pb: 0.5 }}>
      <Stack direction="row" spacing={0.75} sx={{ px: 1.5, alignItems: 'center' }}>
        <Box sx={(theme) => ({ width: 7, height: 7, borderRadius: '50%', bgcolor: statusTextColor('success')(theme), flexShrink: 0 })} />
        <Typography variant="body2" noWrap sx={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
          {conn.target}
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
            {conn.user}@{conn.host}
            {conn.port !== 22 ? `:${conn.port}` : ''}
          </Typography>
        </Typography>
        <Tooltip title="Start a forward on this connection">
          <IconButton size="small" aria-label={`Add forward on ${conn.target}`} onClick={onAdd}>
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Stack>
      {forwards.map((f) => (
        <Stack key={f.id} direction="row" spacing={1} sx={{ pl: 3, pr: 1.5, py: 0.25, alignItems: 'center' }}>
          <Chip
            size="small"
            label={FORWARD_FLAG[f.type]}
            color={f.status === 'error' ? 'error' : 'default'}
            sx={{ ...MONO, width: 42, height: 20, fontSize: 11 }}
          />
          <Typography variant="caption" noWrap sx={{ flex: 1, minWidth: 0, ...MONO, fontSize: 11 }}>
            {describeForward(f)}
            {f.error ? ` — ${f.error}` : ''}
          </Typography>
          {f.origin === 'config' ? (
            <Tooltip title="Declared in ssh config — starts and stops with this terminal">
              <Chip size="small" label="config" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
            </Tooltip>
          ) : (
            <>
              <Tooltip title="Save as tunnel — start it later without a terminal">
                <span>
                  <IconButton size="small" aria-label="Save forward as tunnel" disabled={savePending} onClick={() => onSaveAsTunnel(f)}>
                    <SaveOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
              {hasHostEntry && (
                <Tooltip title={`Save to ${conn.metadataAlias}'s ssh config — starts on every connect`}>
                  <IconButton size="small" aria-label="Save forward to ssh config" onClick={() => onBookmark(f)}>
                    <BookmarkAddOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
            </>
          )}
          <Tooltip title={f.origin === 'config' ? 'Stop for this session (the config rule stays)' : 'Stop forward'}>
            <IconButton size="small" aria-label="Stop forward" onClick={() => onStop(f.id)}>
              <StopIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      ))}
      {forwards.length === 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ pl: 3, display: 'block' }}>
          No session forwards.
        </Typography>
      )}
    </Box>
  );
}
