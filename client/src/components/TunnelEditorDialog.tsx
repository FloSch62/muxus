import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AltRouteOutlinedIcon from '@mui/icons-material/AltRouteOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import SettingsEthernetOutlinedIcon from '@mui/icons-material/SettingsEthernetOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import { useMutation } from '@tanstack/react-query';
import type {
  ForwardType,
  SshHostEntry,
  TunnelRecord,
  TunnelSshOptions,
} from '@muxus/shared';
import { saveTunnel } from '../api/tunnels.js';
import { useSshConfig, useSshKeys } from '../api/queries.js';
import { showErrorToast } from '../state/toast.js';
import { ForwardDiagram } from './ForwardDiagram.js';
import { AuthSection } from './host-editor/AuthSection.js';
import {
  blankDraft,
  type HostDraft,
} from './host-editor/draft.js';
import { RouteSection } from './host-editor/RouteSection.js';

export interface TunnelEditorState {
  /** Present when editing an existing tunnel. */
  tunnel?: TunnelRecord;
  /** Preselected SSH target for new tunnels. */
  prefillTarget?: string;
}

type ConnectionMode = 'host' | 'custom';

/** Create/edit a persistent tunnel and the SSH transport it should use. */
export function TunnelEditorDialog({
  state,
  onClose,
  onSaved,
}: {
  state: TunnelEditorState | null;
  onClose: () => void;
  onSaved: (record: TunnelRecord, start: boolean) => void;
}) {
  return (
    <Dialog open={!!state} onClose={onClose} maxWidth="md" fullWidth>
      {state ? (
        <TunnelEditorForm state={state} onClose={onClose} onSaved={onSaved} />
      ) : null}
    </Dialog>
  );
}

function TunnelEditorForm({
  state,
  onClose,
  onSaved,
}: {
  state: TunnelEditorState;
  onClose: () => void;
  onSaved: (record: TunnelRecord, start: boolean) => void;
}) {
  const editing = state.tunnel;
  const [name, setName] = useState(editing?.name ?? '');
  const [mode, setMode] = useState<ConnectionMode>(
    editing?.sshOptions === undefined ? 'host' : 'custom',
  );
  const { data: config } = useSshConfig();
  const { data: keys } = useSshKeys(mode === 'custom');
  const [hostTarget, setHostTarget] = useState(
    editing?.sshOptions === undefined
      ? (editing?.target ?? state.prefillTarget ?? '')
      : '',
  );
  const [custom, setCustomState] = useState<HostDraft>(() =>
    customDraft(editing, state.prefillTarget),
  );
  const [type, setType] = useState<ForwardType>(editing?.type ?? 'local');
  const [bindPort, setBindPort] = useState(
    editing ? String(editing.bindPort) : '',
  );
  const [targetHost, setTargetHost] = useState(
    editing?.targetHost ?? 'localhost',
  );
  const [targetPort, setTargetPort] = useState(
    editing?.targetPort ? String(editing.targetPort) : '',
  );

  const aliases = (config?.hosts ?? []).flatMap((host) => host.aliases);
  const selectedHost = (config?.hosts ?? []).find((host) =>
    host.aliases.includes(hostTarget),
  );
  const connectionOk =
    mode === 'host'
      ? !!hostTarget.trim()
      : !!custom.aliasText.trim() &&
        !/\s/.test(custom.aliasText.trim()) &&
        (!custom.port || portOk(custom.port)) &&
        (custom.authMode !== 'key' ||
          custom.identityFiles.some((file) => file.trim()));
  const valid =
    connectionOk &&
    portOk(bindPort) &&
    (type === 'dynamic' ||
      (!!targetHost.trim() && portOk(targetPort)));

  const save = useMutation({
    mutationFn: (start: boolean) =>
      saveTunnel({
        id: editing?.id,
        name: name.trim() || undefined,
        target:
          mode === 'host'
            ? hostTarget.trim()
            : custom.aliasText.trim(),
        sshOptions:
          mode === 'custom' ? customSshOptions(custom) : undefined,
        type,
        bindPort: Number(bindPort),
        targetHost:
          type === 'dynamic' ? undefined : targetHost.trim(),
        targetPort:
          type === 'dynamic' ? undefined : Number(targetPort),
      }).then((record) => ({ record, start })),
    onSuccess: ({ record, start }) => {
      onClose();
      onSaved(record, start);
    },
    onError: showErrorToast,
  });

  const patchCustom = (patch: Partial<HostDraft>) =>
    setCustomState((draft) => ({ ...draft, ...patch }));

  return (
    <>
      <DialogTitle sx={{ pb: 1 }}>
        {editing ? 'Edit persistent tunnel' : 'New persistent tunnel'}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.25 }}
        >
          Saved locally. Start or stop it without opening a terminal.
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 0.5 }}>
          <TextField
            label="Name"
            placeholder="Production database"
            value={name}
            onChange={(event) => setName(event.target.value)}
            fullWidth
          />

          <Box>
            <SectionHeading
              icon={<DnsOutlinedIcon fontSize="small" />}
              title="SSH connection"
              detail="Choose an existing host, or keep connection settings with this tunnel."
            />
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={mode}
              onChange={(_event, value: ConnectionMode | null) => {
                if (value) setMode(value);
              }}
              sx={{ mb: 1.5 }}
            >
              <ToggleButton value="host">
                <DnsOutlinedIcon sx={{ fontSize: 17, mr: 0.75 }} />
                Configured host
              </ToggleButton>
              <ToggleButton value="custom">
                <TuneOutlinedIcon sx={{ fontSize: 17, mr: 0.75 }} />
                Custom SSH
              </ToggleButton>
            </ToggleButtonGroup>

            {mode === 'host' ? (
              <Stack spacing={1.25}>
                <Autocomplete
                  freeSolo
                  fullWidth
                  options={aliases}
                  inputValue={hostTarget}
                  onInputChange={(_event, value) => setHostTarget(value)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="SSH host"
                      placeholder="Choose an alias from ~/.ssh/config"
                      helperText="Keys, jump hosts, user, and port stay linked to this host's SSH config."
                    />
                  )}
                />
                {selectedHost ? <HostSummary host={selectedHost} /> : null}
              </Stack>
            ) : (
              <Stack spacing={1.25}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                  <TextField
                    label="Hostname"
                    placeholder="server.example.com"
                    value={custom.aliasText}
                    onChange={(event) =>
                      patchCustom({ aliasText: event.target.value })
                    }
                    fullWidth
                    helperText="A hostname or IP address"
                  />
                  <TextField
                    label="User"
                    placeholder="Current user"
                    value={custom.user}
                    onChange={(event) =>
                      patchCustom({ user: event.target.value })
                    }
                    sx={{ width: { xs: '100%', sm: 190 } }}
                  />
                  <TextField
                    label="Port"
                    placeholder="22"
                    value={custom.port}
                    onChange={(event) =>
                      patchCustom({
                        port: event.target.value.replace(/[^\d]/g, ''),
                      })
                    }
                    sx={{ width: { xs: '100%', sm: 110 } }}
                    autoComplete="off"
                  />
                </Stack>
                <ProfileAccordion
                  icon={<KeyOutlinedIcon fontSize="small" />}
                  title="Authentication"
                  summary={authSummary(custom)}
                >
                  <AuthSection
                    draft={custom}
                    set={patchCustom}
                    keys={keys}
                  />
                </ProfileAccordion>
                <ProfileAccordion
                  icon={<AltRouteOutlinedIcon fontSize="small" />}
                  title="Jump hosts"
                  summary={
                    custom.proxyJump.length
                      ? `${custom.proxyJump.length} configured`
                      : 'Direct connection'
                  }
                >
                  <RouteSection
                    draft={custom}
                    set={patchCustom}
                    config={config}
                  />
                </ProfileAccordion>
                <Typography variant="caption" color="text.secondary">
                  Passwords and key passphrases are never saved; Muxus asks for
                  them when the tunnel starts.
                </Typography>
              </Stack>
            )}
          </Box>

          <Box>
            <SectionHeading
              icon={<SettingsEthernetOutlinedIcon fontSize="small" />}
              title="Forwarding rule"
              detail="The saved rule stays available until you delete it."
            />
            <Stack spacing={1.5}>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                value={type}
                onChange={(_event, value: ForwardType | null) => {
                  if (value) setType(value);
                }}
              >
                <ToggleButton value="local">Local (-L)</ToggleButton>
                <ToggleButton value="remote">Remote (-R)</ToggleButton>
                <ToggleButton value="dynamic">
                  SOCKS proxy (-D)
                </ToggleButton>
              </ToggleButtonGroup>
              <ForwardDiagram
                type={type}
                bindPort={bindPort}
                targetHost={targetHost}
                targetPort={targetPort}
                serverLabel={
                  (mode === 'host' ? hostTarget : custom.aliasText).trim() ||
                  'SSH server'
                }
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                <TextField
                  label={
                    type === 'remote' ? 'Port on server' : 'Local port'
                  }
                  value={bindPort}
                  onChange={(event) =>
                    setBindPort(event.target.value.replace(/[^\d]/g, ''))
                  }
                  sx={{ width: { xs: '100%', sm: 160 } }}
                  autoComplete="off"
                />
                {type !== 'dynamic' ? (
                  <>
                    <TextField
                      label="Destination host"
                      value={targetHost}
                      onChange={(event) =>
                        setTargetHost(event.target.value)
                      }
                      fullWidth
                    />
                    <TextField
                      label="Destination port"
                      value={targetPort}
                      onChange={(event) =>
                        setTargetPort(
                          event.target.value.replace(/[^\d]/g, ''),
                        )
                      }
                      sx={{ width: { xs: '100%', sm: 180 } }}
                      autoComplete="off"
                    />
                  </>
                ) : null}
              </Stack>
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          disabled={!valid || save.isPending}
          onClick={() => save.mutate(false)}
        >
          Save
        </Button>
        <Button
          variant="contained"
          disabled={!valid || save.isPending}
          onClick={() => save.mutate(true)}
        >
          {editing ? 'Save & restart' : 'Save & start'}
        </Button>
      </DialogActions>
    </>
  );
}

function customDraft(
  tunnel: TunnelRecord | undefined,
  prefillTarget: string | undefined,
): HostDraft {
  const options = tunnel?.sshOptions;
  const draft = blankDraft(
    options === undefined
      ? (prefillTarget ?? tunnel?.target ?? '')
      : tunnel?.target,
  );
  if (options === undefined) return draft;
  return {
    ...draft,
    aliasText: tunnel?.target ?? '',
    user: options.user ?? '',
    port: options.port?.toString() ?? '',
    authMode: options.passwordOnly
      ? 'password'
      : options.identityFiles?.length
        ? 'key'
        : 'default',
    identityFiles: options.identityFiles ?? [],
    identitiesOnly: options.identitiesOnly ?? false,
    forwardAgent: options.forwardAgent ?? false,
    proxyJump: options.proxyJump ?? [],
  };
}

function customSshOptions(draft: HostDraft): TunnelSshOptions {
  const value = (text: string) => text.trim() || undefined;
  return {
    user: value(draft.user),
    port: draft.port ? Number(draft.port) : undefined,
    identityFiles:
      draft.authMode === 'key'
        ? draft.identityFiles.map((file) => file.trim()).filter(Boolean)
        : undefined,
    identitiesOnly:
      draft.authMode === 'key' && draft.identitiesOnly ? true : undefined,
    forwardAgent: draft.forwardAgent ? true : undefined,
    proxyJump: draft.proxyJump.length ? draft.proxyJump : undefined,
    passwordOnly: draft.authMode === 'password' ? true : undefined,
  };
}

function authSummary(draft: HostDraft): string {
  if (draft.authMode === 'password') return 'Password / interactive';
  if (draft.authMode === 'key') {
    const count = draft.identityFiles.length;
    return `${count} key file${count === 1 ? '' : 's'}`;
  }
  return 'Agent & default keys';
}

function portOk(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function HostSummary({ host }: { host: SshHostEntry }) {
  const resolved = host.resolved;
  const auth =
    resolved.passwordOnly
      ? 'password'
      : resolved.identityFiles.length
        ? `${resolved.identityFiles.length} key${resolved.identityFiles.length === 1 ? '' : 's'}`
        : 'agent / defaults';
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: 0.75,
        px: 1.25,
        py: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'action.hover',
      }}
    >
      <Typography
        variant="caption"
        sx={{
          mr: 'auto',
          fontFamily: '"JetBrains Mono", monospace',
        }}
      >
        {resolved.user ? `${resolved.user}@` : ''}
        {resolved.hostname}:{resolved.port}
      </Typography>
      <Chip label={auth} variant="outlined" />
      {resolved.proxyJump.length ? (
        <Chip
          icon={<AltRouteOutlinedIcon />}
          label={`${resolved.proxyJump.length} jump${resolved.proxyJump.length === 1 ? '' : 's'}`}
          variant="outlined"
        />
      ) : null}
    </Stack>
  );
}

function SectionHeading({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: 'flex-start', mb: 1.25 }}
    >
      <Box sx={{ color: 'text.secondary', display: 'flex', mt: 0.1 }}>
        {icon}
      </Box>
      <Box>
        <Typography variant="subtitle2">{title}</Typography>
        <Typography variant="caption" color="text.secondary">
          {detail}
        </Typography>
      </Box>
    </Stack>
  );
}

function ProfileAccordion({
  icon,
  title,
  summary,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <Accordion
      disableGutters
      variant="outlined"
      sx={{
        '&:before': { display: 'none' },
        borderRadius: '8px !important',
        overflow: 'hidden',
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{ minHeight: 44, '& .MuiAccordionSummary-content': { my: 0.75 } }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', minWidth: 0 }}
        >
          <Box sx={{ color: 'text.secondary', display: 'flex' }}>{icon}</Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            · {summary}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0.5 }}>{children}</AccordionDetails>
    </Accordion>
  );
}
