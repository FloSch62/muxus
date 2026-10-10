import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import HttpsOutlinedIcon from '@mui/icons-material/HttpsOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import NoEncryptionGmailerrorredOutlinedIcon from '@mui/icons-material/NoEncryptionGmailerrorredOutlined';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import type { GnmiTlsMode } from '@muxus/shared';
import { useDeleteHostProfile, useSaveHostProfile, useUpdateHostProfileMetadata } from '../api/profiles.js';
import { confirmDeleteHost } from '../host-actions.js';
import { connectSavedHost } from '../session-actions.js';
import type { HostEditorState } from '../state/ui.js';
import { useUiStore } from '../state/ui.js';
import { FolderPathField } from './FolderPathField.js';
import { HostColorPicker } from './HostColorPicker.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import {
  DEFAULT_MANAGEMENT_PORTS,
  managementDraftMetadataPatch,
  managementDraftProblem,
  managementDraftToInput,
  type ManagementHostDraft,
  type ManagementKind,
} from './host-editor/management-draft.js';
import { SshGatewayField } from './host-editor/SshGatewayField.js';

type EditorState = Exclude<HostEditorState, false>;
type Section = 'general' | 'login' | 'security' | 'route' | 'options';

const MONO = '"JetBrains Mono", monospace';

/**
 * gNMI/NETCONF editor rendered into the shared host-editor shell, so switching
 * the connection type keeps the dialog's anatomy.
 */
export function ManagementHostEditorContent({
  state,
  kind,
  draft,
  setDraft,
}: {
  state: EditorState;
  kind: ManagementKind;
  draft: ManagementHostDraft;
  setDraft: Dispatch<SetStateAction<ManagementHostDraft>>;
}) {
  const setState = useUiStore((s) => s.setHostEditor);
  const existing =
    state.mode === 'edit-profile' || state.mode === 'duplicate-profile' ? state.entry : undefined;
  const [section, setSection] = useState<Section>('general');
  const connectAfter = useRef(false);
  const close = () => setState(false);
  const updateMetadata = useUpdateHostProfileMetadata((profile) => {
    close();
    if (connectAfter.current) connectSavedHost(profile);
  });
  const saveProfile = useSaveHostProfile((saved) => {
    updateMetadata.mutate({ id: saved.id, patch: managementDraftMetadataPatch(draft) });
  });
  const deleteProfile = useDeleteHostProfile(close);
  const problem = managementDraftProblem(draft, kind);
  const set = (patch: Partial<ManagementHostDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = (connect: boolean) => {
    if (problem) return;
    connectAfter.current = connect;
    saveProfile.mutate(
      managementDraftToInput(draft, kind, state.mode === 'edit-profile' ? existing?.id : undefined),
    );
  };

  const title =
    state.mode === 'edit-profile'
      ? `Edit ${existing?.name ?? 'host'}`
      : state.mode === 'duplicate-profile'
        ? `Duplicate ${existing?.name ?? 'host'}`
        : 'Add host';
  const sections: EditorSectionDef<Section>[] = [
    {
      value: 'general',
      label: 'General',
      icon: kind === 'gnmi' ? <SensorsOutlinedIcon fontSize="small" /> : <AccountTreeOutlinedIcon fontSize="small" />,
    },
    { value: 'login', label: 'Login', icon: <KeyOutlinedIcon fontSize="small" /> },
    ...(kind === 'gnmi'
      ? [{ value: 'security' as const, label: 'Security', icon: <ShieldOutlinedIcon fontSize="small" /> }]
      : []),
    {
      value: 'route',
      label: 'Connection route',
      icon: <AltRouteIcon fontSize="small" />,
      count: draft.sshGateway ? 1 : undefined,
    },
    ...(kind === 'gnmi'
      ? [{ value: 'options' as const, label: 'Options', icon: <TuneOutlinedIcon fontSize="small" /> }]
      : []),
  ];
  const visible = sections.some((candidate) => candidate.value === section) ? section : 'general';

  return (
    <EditorShell
      title={title}
      storage="Saved in Muxus app data"
      typeKind={state.mode === 'new' ? kind : undefined}
      onTypeChange={state.mode === 'new' ? (next) => setState({ ...state, kind: next }) : undefined}
      sections={sections}
      section={visible}
      onSection={setSection}
      problem={problem}
      busy={saveProfile.isPending || updateMetadata.isPending}
      onDelete={
        state.mode === 'edit-profile' && existing
          ? () => {
              void confirmDeleteHost({ name: existing.name }).then((confirmed) => {
                if (confirmed) deleteProfile.mutate(existing.id);
              });
            }
          : undefined
      }
      deletePending={deleteProfile.isPending}
      onClose={close}
      onSave={save}
    >
      {visible === 'general' && <GeneralSection kind={kind} draft={draft} set={set} />}
      {visible === 'login' && <LoginSection kind={kind} draft={draft} set={set} />}
      {visible === 'security' && <SecuritySection draft={draft} set={set} />}
      {visible === 'route' && <RouteSection kind={kind} draft={draft} set={set} />}
      {visible === 'options' && <OptionsSection draft={draft} set={set} />}
    </EditorShell>
  );
}

interface SectionProps {
  kind: ManagementKind;
  draft: ManagementHostDraft;
  set: (patch: Partial<ManagementHostDraft>) => void;
}

function GeneralSection({ kind, draft, set }: SectionProps) {
  return (
    <Stack spacing={2}>
      <TextField
        fullWidth
        required
        label="Name"
        placeholder={kind === 'gnmi' ? 'leaf1 telemetry' : 'leaf1 config'}
        helperText="How this host appears in the host list"
        value={draft.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          fullWidth
          label="Host"
          placeholder="leaf1.lab.example.com"
          helperText={
            draft.sshGateway
              ? `Resolved by ${draft.sshGateway.target}`
              : kind === 'netconf'
                ? 'An ssh_config alias works too: its user, keys and jump hosts apply.'
                : undefined
          }
          value={draft.host}
          onChange={(event) => set({ host: event.target.value })}
        />
        <TextField
          label="Port"
          placeholder={String(DEFAULT_MANAGEMENT_PORTS[kind])}
          value={draft.port}
          onChange={(event) => set({ port: event.target.value.replace(/[^\d]/g, '') })}
          slotProps={{ htmlInput: { inputMode: 'numeric' } }}
          sx={{ width: { sm: 130 } }}
        />
      </Stack>
      <FolderPathField
        value={draft.group}
        onChange={(group: string) => set({ group })}
        helperText="Optional — use / to nest, e.g. Lab/Fabric."
      />
      <HostColorPicker value={draft.color} onChange={(color) => set({ color })} />
      <Typography variant="body2" color="textSecondary">
        {kind === 'gnmi'
          ? 'gNMI runs over gRPC, usually on port 57400 (SR Linux, Arista EOS) or 9339 (the IANA port). The session opens a workbench to browse, get, set and stream telemetry.'
          : 'NETCONF runs over SSH on port 830. The session opens a workbench to browse configuration and state, edit the candidate and commit.'}
      </Typography>
    </Stack>
  );
}

function LoginSection({ kind, draft, set }: SectionProps) {
  return (
    <Stack spacing={2}>
      <TextField
        fullWidth
        label="User name"
        placeholder={kind === 'netconf' ? 'From ssh_config, or your local user' : 'admin'}
        helperText={
          kind === 'gnmi'
            ? 'Leave empty to be asked when connecting, or for devices that accept unauthenticated gNMI.'
            : 'Leave empty to use the User from ssh_config.'
        }
        value={draft.username}
        onChange={(event) => set({ username: event.target.value })}
      />
      <Typography variant="body2" color="textSecondary">
        {kind === 'gnmi'
          ? 'Muxus asks for the password when it connects and sends it with every gNMI call, as gNMI requires. Tick “Remember this password” there to keep it in the encrypted password vault.'
          : 'NETCONF logs in like an SSH session: keys from ssh_config and the agent are tried first, then Muxus asks for a password, which you can keep in the password vault.'}
      </Typography>
    </Stack>
  );
}

function ModeCard({
  selected,
  icon,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <Box
      component="label"
      sx={(theme) => ({
        flex: 1,
        minWidth: 0,
        p: 1.25,
        borderRadius: 1.5,
        border: 1,
        cursor: 'pointer',
        position: 'relative',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
        '&:hover': { borderColor: selected ? 'primary.main' : 'text.secondary' },
        '&:focus-within': { boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.4)}` },
      })}
    >
      <Box
        component="input"
        type="radio"
        name="gnmi-transport-security"
        checked={selected}
        onChange={onSelect}
        sx={{ position: 'absolute', opacity: 0, width: 1, height: 1, m: 0, pointerEvents: 'none' }}
      />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5, color: selected ? 'primary.main' : 'text.primary' }}>
        {icon}
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Stack>
      <Typography variant="caption" color="textSecondary" sx={{ display: 'block', lineHeight: 1.4 }}>
        {description}
      </Typography>
    </Box>
  );
}

function FileField({
  label,
  kind,
  value,
  placeholder,
  helperText,
  onChange,
}: {
  label: string;
  kind: 'ca' | 'cert' | 'key';
  value: string;
  placeholder: string;
  helperText?: string;
  onChange: (value: string) => void;
}) {
  const desktop = window.muxusDesktop;
  const choose = desktop?.selectCertificateFile ? (which: typeof kind) => desktop.selectCertificateFile!(which) : undefined;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
      <TextField
        fullWidth
        label={label}
        placeholder={placeholder}
        helperText={helperText}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 12.5 } } }}
      />
      {choose && (
        <Button
          variant="outlined"
          startIcon={<FolderOpenOutlinedIcon />}
          sx={{ flexShrink: 0, height: 40 }}
          onClick={() => {
            void choose(kind).then((path) => {
              if (path) onChange(path);
            });
          }}
        >
          Browse…
        </Button>
      )}
    </Stack>
  );
}

function SecuritySection({ draft, set }: Omit<SectionProps, 'kind'>) {
  const modes: Array<{ value: GnmiTlsMode; icon: ReactNode; title: string; description: string }> = [
    {
      value: 'verify',
      icon: <VerifiedUserOutlinedIcon fontSize="small" />,
      title: 'TLS',
      description: 'Verify the certificate. One that does not verify is shown once and pinned, like an SSH host key.',
    },
    {
      value: 'skip-verify',
      icon: <HttpsOutlinedIcon fontSize="small" />,
      title: 'TLS, don’t verify',
      description: 'Encrypt, but accept any certificate. For labs whose certificates change on every redeploy.',
    },
    {
      value: 'plaintext',
      icon: <NoEncryptionGmailerrorredOutlinedIcon fontSize="small" />,
      title: 'Plain text',
      description: 'No TLS at all. Passwords and data cross the network readable.',
    },
  ];
  const tls = draft.tls !== 'plaintext';
  return (
    <Stack spacing={2}>
      <Stack
        component="fieldset"
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        aria-label="Transport security"
        sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}
      >
        {modes.map((mode) => (
          <ModeCard
            key={mode.value}
            selected={draft.tls === mode.value}
            icon={mode.icon}
            title={mode.title}
            description={mode.description}
            onSelect={() => set({ tls: mode.value })}
          />
        ))}
      </Stack>
      {draft.tls === 'plaintext' && !draft.sshGateway && (
        <Alert severity="warning">
          Without TLS the password travels in clear text with every request. Outside a lab, use TLS or reach the device
          through an SSH gateway (Connection route).
        </Alert>
      )}
      {tls && (
        <>
          <FileField
            label="CA certificate"
            kind="ca"
            value={draft.caFile}
            placeholder="clab-mylab/.tls/ca/ca.pem"
            helperText="Verify against this authority instead of the system's. containerlab writes one per lab."
            onChange={(caFile) => set({ caFile })}
          />
          <TextField
            fullWidth
            label="Certificate name"
            placeholder={draft.host || 'leaf1.example.com'}
            helperText="When the certificate names the device differently from the host above."
            value={draft.tlsServerName}
            onChange={(event) => set({ tlsServerName: event.target.value })}
          />
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              Client certificate
            </Typography>
            <Typography variant="body2" color="textSecondary">
              For devices that require mutual TLS.
            </Typography>
          </Box>
          <FileField
            label="Certificate"
            kind="cert"
            value={draft.certFile}
            placeholder="client.pem"
            onChange={(certFile) => set({ certFile })}
          />
          <FileField
            label="Key"
            kind="key"
            value={draft.keyFile}
            placeholder="client.key"
            onChange={(keyFile) => set({ keyFile })}
          />
        </>
      )}
    </Stack>
  );
}

function RouteSection({ kind, draft, set }: SectionProps) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          SSH gateway
        </Typography>
        <Typography variant="body2" color="textSecondary">
          {kind === 'gnmi'
            ? 'Reach the gNMI server through an SSH host, like ssh -L: the host and port above are connected from the gateway. TLS still runs end to end between Muxus and the device.'
            : 'Reach the device through an SSH jump host, like ssh -J. Jump hosts set in ssh_config for this host apply as well.'}
        </Typography>
      </Box>
      <SshGatewayField
        label={kind === 'gnmi' ? 'SSH gateway' : 'Jump host'}
        value={draft.sshGateway}
        onChange={(sshGateway) => set({ sshGateway })}
      />
    </Stack>
  );
}

function OptionsSection({ draft, set }: Omit<SectionProps, 'kind'>) {
  return (
    <Stack spacing={2}>
      <TextField
        select
        fullWidth
        label="Encoding"
        value={draft.encoding}
        helperText="How values travel. Automatic picks JSON_IETF when the device offers it."
        onChange={(event) => set({ encoding: event.target.value as ManagementHostDraft['encoding'] })}
      >
        <MenuItem value="">Automatic</MenuItem>
        <MenuItem value="json_ietf">JSON_IETF</MenuItem>
        <MenuItem value="json">JSON</MenuItem>
        <MenuItem value="proto">PROTO</MenuItem>
        <MenuItem value="ascii">ASCII</MenuItem>
        <MenuItem value="bytes">BYTES</MenuItem>
      </TextField>
    </Stack>
  );
}
