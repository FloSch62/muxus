import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import DesktopWindowsOutlinedIcon from '@mui/icons-material/DesktopWindowsOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import ScreenShareOutlinedIcon from '@mui/icons-material/ScreenShareOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import type { SshGateway } from '@muxus/shared';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { useDeleteHostProfile, useSaveHostProfile, useUpdateHostProfileMetadata } from '../api/profiles.js';
import { confirmDeleteHost } from '../host-actions.js';
import { hostDisplayName } from '../host-organization.js';
import { savedHostAddress, savedHostDisplayName } from '../saved-hosts.js';
import { connectSavedHost } from '../session-actions.js';
import type { HostEditorState } from '../state/ui.js';
import { useUiStore } from '../state/ui.js';
import { FolderPathField } from './FolderPathField.js';
import { HostColorPicker } from './HostColorPicker.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import {
  DEFAULT_DESKTOP_PORTS,
  desktopDraftMetadataPatch,
  desktopDraftProblem,
  desktopDraftToInput,
  type DesktopHostDraft,
  type DesktopKind,
} from './host-editor/desktop-draft.js';

type EditorState = Exclude<HostEditorState, false>;
type Section = 'general' | 'logon' | 'route' | 'options';

interface GatewayOption {
  key: string;
  label: string;
  detail: string;
  gateway: SshGateway;
}

/**
 * RDP/VNC editor rendered into the shared host-editor shell, so switching the
 * connection type keeps the dialog's anatomy: same header, section rail and
 * action row as the SSH, Telnet and serial editors.
 */
export function RemoteDesktopHostEditorContent({
  state,
  kind,
  draft,
  setDraft,
}: {
  state: EditorState;
  kind: DesktopKind;
  draft: DesktopHostDraft;
  setDraft: Dispatch<SetStateAction<DesktopHostDraft>>;
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
    updateMetadata.mutate({ id: saved.id, patch: desktopDraftMetadataPatch(draft) });
  });
  const deleteProfile = useDeleteHostProfile(close);
  const problem = desktopDraftProblem(draft, kind);
  const set = (patch: Partial<DesktopHostDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = (connect: boolean) => {
    if (problem) return;
    connectAfter.current = connect;
    saveProfile.mutate(
      desktopDraftToInput(draft, kind, state.mode === 'edit-profile' ? existing?.id : undefined),
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
      icon:
        kind === 'rdp' ? (
          <DesktopWindowsOutlinedIcon fontSize="small" />
        ) : (
          <ScreenShareOutlinedIcon fontSize="small" />
        ),
    },
    { value: 'logon', label: 'Logon', icon: <KeyOutlinedIcon fontSize="small" /> },
    {
      value: 'route',
      label: 'Connection route',
      icon: <AltRouteIcon fontSize="small" />,
      count: draft.sshGateway ? 1 : undefined,
    },
    { value: 'options', label: 'Options', icon: <TuneOutlinedIcon fontSize="small" /> },
  ];

  return (
    <EditorShell
      title={title}
      storage="Saved in Muxus app data"
      typeKind={state.mode === 'new' ? kind : undefined}
      onTypeChange={state.mode === 'new' ? (next) => setState({ ...state, kind: next }) : undefined}
      sections={sections}
      section={section}
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
      {section === 'general' && <GeneralSection kind={kind} draft={draft} set={set} />}
      {section === 'logon' && <LogonSection kind={kind} draft={draft} set={set} />}
      {section === 'route' && <RouteSection kind={kind} draft={draft} set={set} />}
      {section === 'options' && <OptionsSection kind={kind} draft={draft} set={set} />}
    </EditorShell>
  );
}

interface SectionProps {
  kind: DesktopKind;
  draft: DesktopHostDraft;
  set: (patch: Partial<DesktopHostDraft>) => void;
}

function GeneralSection({ kind, draft, set }: SectionProps) {
  return (
    <Stack spacing={2}>
      <TextField
        fullWidth
        required
        label="Name"
        placeholder={kind === 'rdp' ? 'Build server' : 'Lab console'}
        helperText="How this host appears in the host list"
        value={draft.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          fullWidth
          label="Host"
          placeholder={kind === 'rdp' ? 'win-build.example.com' : 'lab-vm.example.com'}
          helperText={draft.sshGateway ? `Resolved by ${draft.sshGateway.target}` : undefined}
          value={draft.host}
          onChange={(event) => set({ host: event.target.value })}
        />
        <TextField
          label="Port"
          placeholder={String(DEFAULT_DESKTOP_PORTS[kind])}
          value={draft.port}
          onChange={(event) => set({ port: event.target.value.replace(/[^\d]/g, '') })}
          slotProps={{ htmlInput: { inputMode: 'numeric' } }}
          sx={{ width: { sm: 130 } }}
        />
      </Stack>
      <FolderPathField
        value={draft.group}
        onChange={(group: string) => set({ group })}
        helperText="Optional — use / to nest, e.g. Lab/Windows."
      />
      <HostColorPicker value={draft.color} onChange={(color) => set({ color })} />
      {kind === 'vnc' && !draft.sshGateway && (
        <Alert severity="warning">
          Most VNC servers do not encrypt their traffic. Outside a trusted network, reach the host through an SSH
          gateway (Connection route).
        </Alert>
      )}
    </Stack>
  );
}

function LogonSection({ kind, draft, set }: SectionProps) {
  return (
    <Stack spacing={2}>
      <TextField
        fullWidth
        label="User name"
        placeholder={kind === 'rdp' ? 'Administrator' : 'Only when the server asks for one'}
        helperText={
          kind === 'rdp'
            ? 'Leave empty to be asked when connecting. DOMAIN\\user and user@domain work too.'
            : 'VNC servers usually ask for a password only; some (macOS, VeNCrypt) also want a user name.'
        }
        value={draft.username}
        onChange={(event) => set({ username: event.target.value })}
      />
      {kind === 'rdp' && (
        <TextField
          fullWidth
          label="Domain"
          placeholder="Optional"
          value={draft.domain}
          onChange={(event) => set({ domain: event.target.value })}
        />
      )}
      <Typography variant="body2" color="text.secondary">
        Muxus asks for the password when it connects. Tick “Remember this password” there to keep it in the
        encrypted password vault.
      </Typography>
    </Stack>
  );
}

function RouteSection({ kind, draft, set }: SectionProps) {
  const { data: config } = useSshConfig();
  const { data: saved } = useSavedHostProfiles();
  const options = useMemo<GatewayOption[]>(() => {
    const fromConfig = (config?.hosts ?? []).map((host) => ({
      key: `ssh:${host.alias}`,
      label: hostDisplayName(host),
      detail: host.alias,
      gateway: { target: host.alias },
    }));
    const fromProfiles = (saved?.profiles ?? []).flatMap((profile) =>
      profile.profile.kind === 'ssh'
        ? [
            {
              key: `profile:${profile.id}`,
              label: savedHostDisplayName(profile),
              detail: savedHostAddress(profile),
              gateway: { target: profile.profile.target, profileId: profile.id },
            },
          ]
        : [],
    );
    return [...fromConfig, ...fromProfiles].sort((a, b) => a.label.localeCompare(b.label));
  }, [config?.hosts, saved?.profiles]);
  const selectedKey = draft.sshGateway
    ? draft.sshGateway.profileId
      ? `profile:${draft.sshGateway.profileId}`
      : `ssh:${draft.sshGateway.target}`
    : undefined;
  const selected =
    options.find((option) => option.key === selectedKey) ??
    (draft.sshGateway
      ? { key: selectedKey!, label: draft.sshGateway.target, detail: 'Not found', gateway: draft.sshGateway }
      : null);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          SSH gateway
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Reach the {kind === 'rdp' ? 'Remote Desktop' : 'VNC'} server through an SSH host, like{' '}
          <code>ssh -L</code>: the host and port above are resolved and connected on the gateway's side. Useful for
          servers behind a bastion or listening only on localhost.
        </Typography>
      </Box>
      <Autocomplete<GatewayOption>
        options={options}
        value={selected}
        isOptionEqualToValue={(option, value) => option.key === value.key}
        getOptionLabel={(option) => option.label}
        onChange={(_event, value) => set({ sshGateway: value?.gateway })}
        renderOption={(props, option) => {
          const { key, ...optionProps } = props;
          return (
            <Box component="li" key={key} {...optionProps}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2">{option.label}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {option.detail}
                </Typography>
              </Box>
            </Box>
          );
        }}
        renderInput={(params) => (
          <TextField {...params} label="SSH gateway" placeholder="Direct connection" />
        )}
      />
    </Stack>
  );
}

function OptionsSection({ kind, draft, set }: SectionProps) {
  return (
    <Stack spacing={1}>
      <FormControlLabel
        control={
          <Switch checked={draft.shareClipboard} onChange={(event) => set({ shareClipboard: event.target.checked })} />
        }
        label={
          <Stack spacing={0}>
            <Typography variant="body2">Share the clipboard</Typography>
            <Typography variant="caption" color="text.secondary">
              Copy and paste text between this computer and the remote desktop. The server can read what you copy
              while its tab has focus.
            </Typography>
          </Stack>
        }
      />
      {kind === 'vnc' && (
        <>
          <FormControlLabel
            control={
              <Switch checked={draft.resizeRemote} onChange={(event) => set({ resizeRemote: event.target.checked })} />
            }
            label={
              <Stack spacing={0}>
                <Typography variant="body2">Resize the remote desktop to fit</Typography>
                <Typography variant="caption" color="text.secondary">
                  Ask the server to change its resolution to match the pane instead of scaling the picture. Servers
                  such as TigerVNC support this; shared physical screens usually do not.
                </Typography>
              </Stack>
            }
          />
          <FormControlLabel
            control={<Switch checked={draft.viewOnly} onChange={(event) => set({ viewOnly: event.target.checked })} />}
            label={
              <Stack spacing={0}>
                <Typography variant="body2">View only</Typography>
                <Typography variant="caption" color="text.secondary">
                  Watch the screen without sending keyboard or mouse input.
                </Typography>
              </Stack>
            }
          />
        </>
      )}
      {kind === 'rdp' && (
        <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
          The remote desktop follows the size of its pane when the server supports resizing (Windows 8.1 / Server
          2012 R2 and later, xrdp); otherwise the picture is scaled to fit.
        </Typography>
      )}
    </Stack>
  );
}
