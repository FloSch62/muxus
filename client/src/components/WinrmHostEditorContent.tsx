import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import { useDeleteHostProfile, useSaveHostProfile, useUpdateHostProfileMetadata } from '../api/profiles.js';
import { confirmDeleteHost } from '../host-actions.js';
import { connectSavedHost } from '../session-actions.js';
import type { HostEditorState } from '../state/ui.js';
import { useUiStore } from '../state/ui.js';
import { FolderPathField } from './FolderPathField.js';
import { HostColorPicker } from './HostColorPicker.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import { SshGatewayRouteField } from './host-editor/SshGatewayRouteField.js';
import {
  WINRM_PORTS,
  winrmDraftMetadataPatch,
  winrmDraftProblem,
  winrmDraftToInput,
  type WinrmHostDraft,
} from './host-editor/winrm-draft.js';

type EditorState = Exclude<HostEditorState, false>;
type Section = 'general' | 'logon' | 'route';

/** Editor for a Windows shell over WinRM, in the shell every host kind shares. */
export function WinrmHostEditorContent({
  state,
  draft,
  setDraft,
}: {
  state: EditorState;
  draft: WinrmHostDraft;
  setDraft: Dispatch<SetStateAction<WinrmHostDraft>>;
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
    updateMetadata.mutate({ id: saved.id, patch: winrmDraftMetadataPatch(draft) });
  });
  const deleteProfile = useDeleteHostProfile(close);
  const problem = winrmDraftProblem(draft);
  const set = (patch: Partial<WinrmHostDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = (connect: boolean) => {
    if (problem) return;
    connectAfter.current = connect;
    saveProfile.mutate(winrmDraftToInput(draft, state.mode === 'edit-profile' ? existing?.id : undefined));
  };

  const title =
    state.mode === 'edit-profile'
      ? `Edit ${existing?.name ?? 'host'}`
      : state.mode === 'duplicate-profile'
        ? `Duplicate ${existing?.name ?? 'host'}`
        : 'Add host';
  const sections: EditorSectionDef<Section>[] = [
    { value: 'general', label: 'General', icon: <TerminalOutlinedIcon fontSize="small" /> },
    { value: 'logon', label: 'Logon', icon: <KeyOutlinedIcon fontSize="small" /> },
    {
      value: 'route',
      label: 'Connection route',
      icon: <AltRouteIcon fontSize="small" />,
      count: draft.sshGateway ? 1 + draft.sshGatewayFallbacks.filter((g) => g.target).length : undefined,
    },
  ];

  return (
    <EditorShell
      title={title}
      storage="Saved in Muxus app data"
      typeKind={state.mode === 'new' ? 'winrm' : undefined}
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
      {section === 'general' && (
        <Stack spacing={2}>
          <TextField
            fullWidth
            required
            label="Name"
            placeholder="File server"
            helperText="How this host appears in the host list"
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              fullWidth
              label="Host"
              placeholder="fs01.corp.example"
              helperText={draft.sshGateway ? `Resolved by ${draft.sshGateway.target}` : undefined}
              value={draft.host}
              onChange={(event) => set({ host: event.target.value })}
            />
            <TextField
              label="Port"
              placeholder={String(draft.https ? WINRM_PORTS.https : WINRM_PORTS.http)}
              value={draft.port}
              onChange={(event) => set({ port: event.target.value.replace(/[^\d]/g, '') })}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              sx={{ width: { sm: 130 } }}
            />
          </Stack>
          <FormControlLabel
            control={<Switch checked={draft.https} onChange={(event) => set({ https: event.target.checked })} />}
            label={
              <Stack spacing={0}>
                <Typography variant="body2">HTTPS</Typography>
                <Typography variant="caption" color="textSecondary">
                  Off uses HTTP, where NTLM still encrypts every message — the Windows default on port 5985.
                </Typography>
              </Stack>
            }
          />
          {draft.https && (
            <FormControlLabel
              control={
                <Switch
                  checked={draft.tlsVerify === 'skip-verify'}
                  onChange={(event) => set({ tlsVerify: event.target.checked ? 'skip-verify' : 'verify' })}
                />
              }
              label={
                <Stack spacing={0}>
                  <Typography variant="body2">Do not check the certificate</Typography>
                  <Typography variant="caption" color="textSecondary">
                    For a server with a self-signed certificate. Anyone on the path could then read the session.
                  </Typography>
                </Stack>
              }
            />
          )}
          <TextField
            select
            label="Shell"
            value={draft.shell}
            onChange={(event) => set({ shell: event.target.value as WinrmHostDraft['shell'] })}
            helperText="Typed lines are edited here and sent on Enter, as with winrs."
          >
            <MenuItem value="cmd">Command Prompt (cmd.exe)</MenuItem>
            <MenuItem value="powershell">Windows PowerShell</MenuItem>
          </TextField>
          <FolderPathField
            value={draft.group}
            onChange={(group: string) => set({ group })}
            helperText="Optional — use / to nest, e.g. Windows/Servers."
          />
          <HostColorPicker value={draft.color} onChange={(color) => set({ color })} />
        </Stack>
      )}
      {section === 'logon' && (
        <Stack spacing={2}>
          <TextField
            fullWidth
            label="User name"
            placeholder="CORP\\alice or alice@corp.example"
            helperText="Leave empty to be asked when connecting."
            value={draft.username}
            onChange={(event) => set({ username: event.target.value })}
          />
          <TextField
            select
            label="Authentication"
            value={draft.auth}
            onChange={(event) => set({ auth: event.target.value as WinrmHostDraft['auth'] })}
          >
            <MenuItem value="negotiate">Negotiate (NTLM)</MenuItem>
            <MenuItem value="basic">Basic (HTTPS only)</MenuItem>
          </TextField>
          {draft.auth === 'basic' && !draft.https && (
            <Alert severity="warning">Basic authentication sends the password as it is. Turn on HTTPS.</Alert>
          )}
          <Typography variant="body2" color="textSecondary">
            Muxus asks for the password when it connects. Tick “Remember this password” there to keep it in the
            encrypted password vault. Domains that have turned NTLM off (Kerberos only) cannot sign in this way.
          </Typography>
        </Stack>
      )}
      {section === 'route' && (
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              SSH gateway
            </Typography>
            <Typography variant="body2" color="textSecondary">
              Reach the WinRM service through an SSH host, like <code>ssh -L</code>: the host and port above are
              resolved and connected on the gateway's side.
            </Typography>
          </Box>
          <SshGatewayRouteField
            gateway={draft.sshGateway}
            fallbacks={draft.sshGatewayFallbacks}
            onChange={set}
          />
        </Stack>
      )}
    </EditorShell>
  );
}
