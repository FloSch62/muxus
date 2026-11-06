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
import FolderSharedOutlinedIcon from '@mui/icons-material/FolderSharedOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
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
  parseShareAddress,
  shareDraftMetadataPatch,
  shareDraftProblem,
  shareDraftToInput,
  type ShareHostDraft,
  type ShareKind,
} from './host-editor/share-draft.js';

type EditorState = Exclude<HostEditorState, false>;
type Section = 'general' | 'logon' | 'route';

/** Editor for a saved SMB or NFS share, mounted with the system's own client. */
export function ShareHostEditorContent({
  state,
  kind,
  draft,
  setDraft,
}: {
  state: EditorState;
  kind: ShareKind;
  draft: ShareHostDraft;
  setDraft: Dispatch<SetStateAction<ShareHostDraft>>;
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
    updateMetadata.mutate({ id: saved.id, patch: shareDraftMetadataPatch(draft) });
  });
  const deleteProfile = useDeleteHostProfile(close);
  const problem = shareDraftProblem(draft, kind);
  const set = (patch: Partial<ShareHostDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = (connect: boolean) => {
    if (problem) return;
    connectAfter.current = connect;
    saveProfile.mutate(shareDraftToInput(draft, kind, state.mode === 'edit-profile' ? existing?.id : undefined));
  };

  const title =
    state.mode === 'edit-profile'
      ? `Edit ${existing?.name ?? 'share'}`
      : state.mode === 'duplicate-profile'
        ? `Duplicate ${existing?.name ?? 'share'}`
        : 'Add host';
  const sections: EditorSectionDef<Section>[] = [
    { value: 'general', label: 'General', icon: <FolderSharedOutlinedIcon fontSize="small" /> },
    ...(kind === 'smb'
      ? [{ value: 'logon' as const, label: 'Logon', icon: <KeyOutlinedIcon fontSize="small" /> }]
      : []),
    {
      value: 'route',
      label: 'Connection route',
      icon: <AltRouteIcon fontSize="small" />,
      count: draft.sshGateway ? 1 + draft.sshGatewayFallbacks.filter((g) => g.target).length : undefined,
    },
  ];
  // Pasting \\server\share or server:/export fills the fields it names.
  const pasteAddress = (value: string): boolean => {
    const parsed = parseShareAddress(value);
    if (!parsed.host || parsed.host === value.trim()) return false;
    set(parsed);
    return true;
  };

  return (
    <EditorShell
      title={title}
      storage="Saved in Muxus app data — mounted with the system's own client"
      typeKind={state.mode === 'new' ? kind : undefined}
      onTypeChange={state.mode === 'new' ? (next) => setState({ ...state, kind: next }) : undefined}
      sections={sections}
      section={section === 'logon' && kind === 'nfs' ? 'general' : section}
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
      {(section === 'general' || (section === 'logon' && kind === 'nfs')) && (
        <Stack spacing={2}>
          <TextField
            fullWidth
            required
            label="Name"
            placeholder={kind === 'smb' ? 'Team share' : 'Build artifacts'}
            helperText="How this share appears in the host list, and the name of its mount folder"
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              fullWidth
              label="Server"
              placeholder={kind === 'smb' ? 'fs01.corp.example or \\\\fs01\\Public' : 'nas.lab or nas.lab:/srv/data'}
              helperText={draft.sshGateway ? `Reached through ${draft.sshGateway.target}` : undefined}
              value={draft.host}
              onChange={(event) => set({ host: event.target.value })}
              onPaste={(event) => {
                if (pasteAddress(event.clipboardData.getData('text'))) event.preventDefault();
              }}
            />
            {kind === 'smb' && (
              <TextField
                label="Port"
                placeholder="445"
                value={draft.port}
                onChange={(event) => set({ port: event.target.value.replace(/[^\d]/g, '') })}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                sx={{ width: { sm: 130 } }}
              />
            )}
          </Stack>
          {kind === 'smb' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                fullWidth
                required
                label="Share"
                placeholder="Public"
                value={draft.share}
                onChange={(event) => set({ share: event.target.value })}
              />
              <TextField
                fullWidth
                label="Folder"
                placeholder="Optional, e.g. Reports/2026"
                helperText="Opened inside the share"
                value={draft.folder}
                onChange={(event) => set({ folder: event.target.value })}
              />
            </Stack>
          ) : (
            <>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  fullWidth
                  required
                  label="Export path"
                  placeholder="/srv/data"
                  value={draft.exportPath}
                  onChange={(event) => set({ exportPath: event.target.value })}
                />
                <TextField
                  select
                  label="Version"
                  value={draft.version}
                  onChange={(event) => set({ version: event.target.value as ShareHostDraft['version'] })}
                  sx={{ width: { sm: 160 } }}
                >
                  <MenuItem value="4">NFSv4</MenuItem>
                  <MenuItem value="3">NFSv3</MenuItem>
                </TextField>
              </Stack>
              <FormControlLabel
                control={<Switch checked={draft.readOnly} onChange={(event) => set({ readOnly: event.target.checked })} />}
                label="Read only"
              />
              <Typography variant="body2" color="textSecondary">
                NFS trusts this computer rather than a password: the server decides what you may do from your
                computer's address and your user ID. On Linux, mounting NFS needs root or an /etc/fstab entry with
                the “user” option.
              </Typography>
            </>
          )}
          <FolderPathField
            value={draft.group}
            onChange={(group: string) => set({ group })}
            helperText="Optional — use / to nest, e.g. Storage/Lab."
          />
          <HostColorPicker value={draft.color} onChange={(color) => set({ color })} />
        </Stack>
      )}
      {section === 'logon' && kind === 'smb' && (
        <Stack spacing={2}>
          <TextField
            fullWidth
            label="User name"
            placeholder="CORP\\alice or alice@corp.example"
            helperText="Empty mounts as guest — on Windows, as you."
            value={draft.username}
            onChange={(event) => set({ username: event.target.value })}
          />
          <Typography variant="body2" color="textSecondary">
            Muxus asks for the password when it mounts the share and types it into the system's mount tool, so it
            never appears on a command line. Tick “Remember this password” there to keep it in the password vault.
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
              Mount the share through an SSH host: Muxus forwards a local port to the server's{' '}
              {kind === 'smb' ? 'SMB port' : 'NFS port (2049)'} on the gateway's side and mounts that. The forward
              stops when the share is unmounted.
            </Typography>
          </Box>
          {kind === 'nfs' && draft.version === '3' && (
            <Alert severity="info">Only NFSv4 can go through a gateway; NFSv3 needs several ports.</Alert>
          )}
          {kind === 'smb' && (
            <Alert severity="info">
              Windows can only reach SMB on port 445 of the server itself, so on Windows this share is mounted
              directly and a gateway cannot be used.
            </Alert>
          )}
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
