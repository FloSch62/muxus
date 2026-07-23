import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { useSshConfig, useSshKeys } from '../api/queries.js';
import { fetchHostPreview, useDeleteHost, useUpsertHost } from '../api/ssh-config.js';
import { connectTarget } from '../session-actions.js';
import { useUiStore } from '../state/ui.js';
import { AdvancedSection } from './host-editor/AdvancedSection.js';
import { AuthSection } from './host-editor/AuthSection.js';
import { blankDraft, draftFromEntry, draftProblem, draftToRequest, type HostDraft } from './host-editor/draft.js';
import { ForwardsSection } from './host-editor/ForwardsSection.js';
import { GeneralSection } from './host-editor/GeneralSection.js';
import { RouteSection } from './host-editor/RouteSection.js';

type Section = 'general' | 'auth' | 'route' | 'forwards' | 'advanced';

/**
 * The Host block editor — Muxus's session editor. Everything here reads and
 * writes ~/.ssh/config: general addressing, authentication (key picker with
 * agent awareness), the ProxyJump chain, port forwards with the live tunnel
 * diagram, and free-form options with an exact server-rendered preview.
 */
export function HostEditorDialog() {
  const state = useUiStore((s) => s.hostEditor);
  const setState = useUiStore((s) => s.setHostEditor);
  const { data: config } = useSshConfig();
  const { data: keys } = useSshKeys(!!state);

  const [section, setSection] = useState<Section>('general');
  const [draft, setDraft] = useState<HostDraft>(blankDraft);
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const connectAfter = useRef(false);

  const editing = state && state.mode === 'edit' ? state.entry : undefined;
  const previousAlias = editing?.alias;

  useEffect(() => {
    if (!state) return;
    setSection('general');
    setArmedDelete(false);
    if (state.mode === 'new') setDraft(blankDraft(state.prefillTarget));
    else setDraft(draftFromEntry(state.entry, state.mode === 'duplicate'));
  }, [state]);

  const close = () => setState(false);
  const upsert = useUpsertHost((req) => {
    close();
    if (connectAfter.current) connectTarget(req.aliases[0] ?? '');
  });
  const deleteHost = useDeleteHost(close);

  const problem = state ? draftProblem(draft) : null;

  // Live preview of the exact block text, rendered by the server (debounced).
  useEffect(() => {
    if (!state || problem) return;
    const timer = setTimeout(() => {
      fetchHostPreview(draftToRequest(draft, previousAlias))
        .then((text) => {
          setPreview(text);
          setPreviewError(null);
        })
        .catch((err: unknown) => setPreviewError(err instanceof Error ? err.message : String(err)));
    }, 350);
    return () => clearTimeout(timer);
  }, [state, draft, problem, previousAlias]);

  if (!state) return null;

  const set = (patch: Partial<HostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = (connect: boolean) => {
    connectAfter.current = connect;
    upsert.mutate(draftToRequest(draft, previousAlias));
  };

  const title = state.mode === 'edit' ? `Edit ${state.entry.alias}` : state.mode === 'duplicate' ? `Duplicate ${state.entry.alias}` : 'Add host';
  const tabLabel = (label: string, count: number) => (count > 0 ? `${label} (${count})` : label);

  return (
    <Dialog open onClose={close} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        {title}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Saved to {shorten(draft.file || config?.path || '~/.ssh/config')}
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={2.5} sx={{ minHeight: 440 }}>
          <Tabs
            orientation="vertical"
            value={section}
            onChange={(_e, v: Section) => setSection(v)}
            sx={{
              borderRight: 1,
              borderColor: 'divider',
              minWidth: 178,
              flexShrink: 0,
              '& .MuiTab-root': { minHeight: 42, justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none', fontSize: 13, gap: 1, pl: 0.5 },
            }}
          >
            <Tab value="general" icon={<DnsOutlinedIcon fontSize="small" />} iconPosition="start" label="General" />
            <Tab value="auth" icon={<KeyOutlinedIcon fontSize="small" />} iconPosition="start" label="Authentication" />
            <Tab value="route" icon={<AltRouteIcon fontSize="small" />} iconPosition="start" label={tabLabel('Jump hosts', draft.proxyJump.length)} />
            <Tab value="forwards" icon={<SwapHorizOutlinedIcon fontSize="small" />} iconPosition="start" label={tabLabel('Port forwarding', draft.forwards.length)} />
            <Tab value="advanced" icon={<CodeOutlinedIcon fontSize="small" />} iconPosition="start" label={tabLabel('Advanced', draft.extras.length)} />
          </Tabs>
          <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', pt: 0.5, pr: 0.5, pb: 1 }}>
            {section === 'general' && <GeneralSection draft={draft} set={set} config={config} />}
            {section === 'auth' && <AuthSection draft={draft} set={set} keys={keys} />}
            {section === 'route' && <RouteSection draft={draft} set={set} config={config} />}
            {section === 'forwards' && <ForwardsSection draft={draft} set={set} />}
            {section === 'advanced' && <AdvancedSection draft={draft} set={set} preview={preview} previewError={previewError} />}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {state.mode === 'edit' && (
          <Button
            color="error"
            variant={armedDelete ? 'contained' : 'text'}
            disabled={deleteHost.isPending}
            onClick={() => {
              if (armedDelete) deleteHost.mutate(state.entry.alias);
              else setArmedDelete(true);
            }}
            onBlur={() => setArmedDelete(false)}
          >
            {armedDelete ? 'Really delete' : 'Delete'}
          </Button>
        )}
        {problem && (
          <Typography variant="caption" color="warning.main" sx={{ ml: 1, mr: 'auto' }}>
            {problem}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={close}>Cancel</Button>
        <Button disabled={!!problem || upsert.isPending} onClick={() => save(false)}>
          Save
        </Button>
        <Button variant="contained" disabled={!!problem || upsert.isPending} onClick={() => save(true)}>
          Save & connect
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function shorten(p: string): string {
  return p.replace(/^.*([\\/]\.ssh[\\/])/, '~/.ssh/');
}
