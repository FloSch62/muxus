import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
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
  normalizeWebUrl,
  webDraftMetadataPatch,
  webDraftProblem,
  webDraftToInput,
  type WebHostDraft,
} from './host-editor/web-draft.js';

type EditorState = Exclude<HostEditorState, false>;
type Section = 'general' | 'route';

/** Editor for a saved web page, in the same shell as every other host kind. */
export function WebHostEditorContent({
  state,
  draft,
  setDraft,
}: {
  state: EditorState;
  draft: WebHostDraft;
  setDraft: Dispatch<SetStateAction<WebHostDraft>>;
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
    updateMetadata.mutate({ id: saved.id, patch: webDraftMetadataPatch(draft) });
  });
  const deleteProfile = useDeleteHostProfile(close);
  const problem = webDraftProblem(draft);
  const set = (patch: Partial<WebHostDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = (connect: boolean) => {
    if (problem) return;
    connectAfter.current = connect;
    saveProfile.mutate(webDraftToInput(draft, state.mode === 'edit-profile' ? existing?.id : undefined));
  };

  const title =
    state.mode === 'edit-profile'
      ? `Edit ${existing?.name ?? 'page'}`
      : state.mode === 'duplicate-profile'
        ? `Duplicate ${existing?.name ?? 'page'}`
        : 'Add host';
  const sections: EditorSectionDef<Section>[] = [
    { value: 'general', label: 'General', icon: <PublicOutlinedIcon fontSize="small" /> },
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
      typeKind={state.mode === 'new' ? 'web' : undefined}
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
            placeholder="Grafana"
            helperText="How this page appears in the host list"
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
          />
          <TextField
            fullWidth
            required
            label="Address"
            placeholder="https://grafana.internal:3000"
            helperText={
              draft.sshGateway
                ? `Opened through ${draft.sshGateway.target}: names and addresses resolve on its side.`
                : 'http:// is added when no scheme is given.'
            }
            value={draft.url}
            onChange={(event) => set({ url: event.target.value })}
            onBlur={() => set({ url: normalizeWebUrl(draft.url) })}
          />
          <FolderPathField
            value={draft.group}
            onChange={(group: string) => set({ group })}
            helperText="Optional — use / to nest, e.g. Monitoring/EU."
          />
          <HostColorPicker value={draft.color} onChange={(color) => set({ color })} />
        </Stack>
      )}
      {section === 'route' && (
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              SSH gateway (SOCKS5)
            </Typography>
            <Typography variant="body2" color="textSecondary">
              Open the page through an SSH host, like <code>ssh -D</code>: Muxus starts a SOCKS5 proxy on the
              gateway and the page's window uses it for every request, name lookups included. Internal names,
              HTTPS and links to other internal hosts work as they would on the gateway.
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
