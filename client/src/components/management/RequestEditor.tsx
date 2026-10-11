import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type { GnmiProfile, NetconfProfile } from '@muxus/shared';
import { apiFetch } from '../../api/http.js';
import { copyToClipboard } from '../../clipboard.js';
import { HOTKEY_MOD_LABEL } from '../../platform.js';
import { confirmAction } from '../../state/dialogs.js';
import { showErrorToast, showToast } from '../../state/toast.js';
import { gnmicCommand, ncclientScript, netconfSshCommand } from '../../management/copy-as.js';
import {
  defaultGnmiDraft,
  gnmiDraftProblem,
  gnmiMessage,
  NETCONF_OPERATION_GROUPS,
  netconfChangesState,
  netconfDraftProblem,
  netconfRpcBody,
  type GnmiDraft,
  type GnmiOperation,
  type ManagementDraft,
  type NetconfDraft,
  type NetconfOperation,
} from '../../management/requests.js';
import { canonicalJson, proposedValue, setItems } from '../../management/set-review.js';
import { ManagementRequestError } from '../../management/session-client.js';
import { prettyXml, rpcEnvelope } from '../../management/xml.js';
import { useWorkbench, useWorkbenchState } from './context.js';
import { GnmiForm } from './GnmiForm.js';
import { NetconfForm } from './NetconfForm.js';
import { MONO_FONT } from './PathText.js';
import { ReviewDialog, type ReviewSection } from './ReviewDialog.js';
import { useLatest } from './CodeEditor.js';

export const REQUESTS_QUERY_KEY = 'management-requests';

export function RequestEditor({ active }: { active: boolean }) {
  const { controller, connected, store } = useWorkbench();
  const draft = useWorkbenchState((state) => state.draft);
  const selectedRun = useWorkbenchState((state) => state.runs.find((run) => run.id === state.selectedRunId));
  const runningUnary = useWorkbenchState((state) =>
    state.runs.find((run) => run.status === 'running' && !run.hidden && !run.live),
  );
  const [review, setReview] = useState<{ sections: ReviewSection[]; loading: boolean; error?: string } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const problem = draft.protocol === 'gnmi' ? gnmiDraftProblem(draft) : netconfDraftProblem(draft);
  const streaming =
    draft.protocol === 'gnmi' && draft.operation === 'subscribe' && selectedRun?.status === 'streaming'
      ? selectedRun
      : undefined;

  const reviewSet = async (gnmi: GnmiDraft) => {
    const items = setItems(gnmi);
    setReview({ sections: [], loading: true });
    try {
      const sections = await Promise.all(
        items.map(async (item): Promise<ReviewSection> => {
          let current: unknown;
          let note: string | undefined;
          try {
            const result = await controller.request({ ...defaultGnmiDraft(), paths: [item.path], dataType: 'config' });
            if (result.op === 'gnmi-get') {
              const updates = result.notifications.flatMap((notification) => notification.updates);
              current = updates.length === 1 ? updates[0]!.value.value : updates.length ? updates.map((update) => update.value.value) : undefined;
            }
          } catch (err) {
            if (err instanceof ManagementRequestError && err.error.code === 'NOT_FOUND') current = undefined;
            else throw err;
          }
          if (current === undefined) note = item.op === 'delete' ? 'Nothing is configured here.' : 'Not configured yet: this creates it.';
          const proposed = proposedValue(item, current);
          return {
            label: `${item.op} ${item.path.trim()}`,
            original: canonicalJson(current),
            modified: canonicalJson(proposed),
            language: 'json',
            ...(note ? { note } : {}),
          };
        }),
      );
      setReview({ sections, loading: false });
    } catch (err) {
      const message = err instanceof ManagementRequestError ? err.error.message : (err as Error).message;
      setReview({ sections: [], loading: false, error: `Could not read the current configuration: ${message}` });
    }
  };

  const run = async () => {
    if (!connected) return;
    const current = store.getState().draft;
    const currentProblem = current.protocol === 'gnmi' ? gnmiDraftProblem(current) : netconfDraftProblem(current);
    if (currentProblem) {
      showToast('warning', currentProblem);
      return;
    }
    if (current.protocol === 'gnmi') {
      if (current.operation === 'subscribe' && streaming) {
        controller.cancel(streaming.id);
        return;
      }
      if (current.operation === 'set') {
        void reviewSet(current);
        return;
      }
    } else if (netconfChangesState(current.operation) && current.operation !== 'edit-config') {
      const destructive = current.operation !== 'commit';
      const confirmed = await confirmAction({
        title: `Send ${current.operation}?`,
        description:
          current.operation === 'discard-changes'
            ? 'Every uncommitted change in the candidate is lost, including other sessions’.'
            : current.operation === 'commit'
              ? current.confirmed
                ? `The candidate becomes the running configuration and rolls back after ${current.confirmTimeout} s unless you confirm.`
                : 'The candidate becomes the running configuration.'
              : current.operation === 'kill-session'
                ? `NETCONF session ${current.sessionId} is ended on the device.`
                : `This changes the ${current.target} datastore.`,
        confirmLabel: current.operation,
        destructive,
      });
      if (!confirmed) return;
    } else if (current.operation === 'edit-config' && current.target === 'running') {
      const confirmed = await confirmAction({
        title: 'Edit the running configuration?',
        description: 'The change takes effect on the device immediately, without a commit.',
        confirmLabel: 'Apply',
        destructive: true,
      });
      if (!confirmed) return;
    }
    controller.run(current);
  };

  const applyReviewed = () => {
    setReview(null);
    controller.run(store.getState().draft);
  };

  // Ctrl/Cmd+Enter anywhere in the editor runs; the path fields and Monaco handle it themselves too.
  const runRef = useLatest(run);
  useEffect(() => {
    const element = rootRef.current;
    if (!element || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.defaultPrevented) {
        event.preventDefault();
        void runRef.current();
      }
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [active, runRef]);

  const runLabel =
    draft.protocol === 'gnmi'
      ? draft.operation === 'subscribe'
        ? streaming
          ? 'Stop'
          : draft.subscribe.listMode === 'stream'
            ? 'Subscribe'
            : draft.subscribe.listMode === 'poll'
              ? 'Start polling'
              : 'Get once'
        : draft.operation === 'set'
          ? 'Review…'
          : 'Get'
      : (draft.operation === 'edit-config' && draft.target === 'running') ||
          (netconfChangesState(draft.operation) && draft.operation !== 'edit-config')
        ? 'Send…'
        : 'Send';

  return (
    <Box ref={rootRef} sx={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', px: 1.5, py: 0.75, borderBottom: 1, borderColor: 'divider', minHeight: 46, flexShrink: 0 }}
      >
        {draft.protocol === 'gnmi' ? (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={draft.operation}
            onChange={(_event, operation: GnmiOperation | null) =>
              operation && store.getState().setDraft({ operation } as Partial<GnmiDraft>)
            }
            aria-label="gNMI operation"
            sx={{ '& .MuiToggleButton-root': { py: 0.45, px: 1.5, fontSize: 12.5 } }}
          >
            <ToggleButton value="get">Get</ToggleButton>
            <ToggleButton value="set">Set</ToggleButton>
            <ToggleButton value="subscribe">Subscribe</ToggleButton>
          </ToggleButtonGroup>
        ) : (
          <NetconfOperationSelect draft={draft} />
        )}
        <Box sx={{ flex: 1 }} />
        <CopyAsMenu draft={draft} />
        <Tooltip title="Save to the library">
          <IconButton size="small" aria-label="Save to the library" onClick={() => setSaveOpen(true)}>
            <BookmarkAddOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {runningUnary ? (
          <Tooltip title="Cancel · Esc">
            <Button
              variant="outlined"
              color="inherit"
              onClick={() => controller.cancel(runningUnary.id)}
              startIcon={<CircularProgress size={14} />}
              sx={{ minWidth: 104 }}
            >
              Cancel
            </Button>
          </Tooltip>
        ) : (
          <Tooltip title={problem ?? (connected ? `${runLabel.replace('…', '')} · ${HOTKEY_MOD_LABEL}Enter` : 'Not connected')}>
            <span>
              <Button
                variant="contained"
                color={streaming ? 'error' : 'primary'}
                disabled={!connected}
                onClick={() => void run()}
                startIcon={
                  streaming ? (
                    <StopRoundedIcon />
                  ) : draft.protocol === 'gnmi' && draft.operation === 'set' ? (
                    <RateReviewOutlinedIcon />
                  ) : (
                    <PlayArrowRoundedIcon />
                  )
                }
                sx={{ minWidth: 104 }}
              >
                {runLabel}
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>
      <Box sx={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', px: 1.5, py: 1.25 }}>
        {draft.protocol === 'gnmi' ? (
          <GnmiForm draft={draft} onRun={() => void run()} />
        ) : (
          <NetconfForm draft={draft} onRun={() => void run()} />
        )}
      </Box>
      <ReviewDialog
        open={!!review}
        title="Review changes"
        description="This is how the configuration at each path changes. Nothing has been sent yet."
        sections={review?.sections ?? []}
        loading={review?.loading}
        error={review?.error}
        applyLabel="Apply changes"
        onApply={applyReviewed}
        onClose={() => setReview(null)}
      />
      <SaveRequestDialog open={saveOpen} draft={draft} onClose={() => setSaveOpen(false)} />
    </Box>
  );
}

function NetconfOperationSelect({ draft }: { draft: NetconfDraft }) {
  const { store, controller } = useWorkbench();
  const unsupported = (operation: NetconfOperation): string | undefined => {
    const requires: Partial<Record<NetconfOperation, string>> = {
      validate: ':validate',
      commit: ':candidate',
      'discard-changes': ':candidate',
      'cancel-commit': ':confirmed-commit',
      'create-subscription': ':notification',
      'get-schema': 'ietf-netconf-monitoring',
    };
    const capability = requires[operation];
    return capability && !controller.hasCapability(capability) ? `The device does not list ${capability}` : undefined;
  };
  return (
    <Select
      size="small"
      value={draft.operation}
      onChange={(event) => store.getState().setDraft({ operation: event.target.value as NetconfOperation })}
      renderValue={(value) => (
        <Box component="span" sx={{ fontFamily: MONO_FONT, fontSize: 12.5, fontWeight: 600 }}>
          {NETCONF_OPERATION_GROUPS.flatMap((group) => group.operations).find((op) => op.value === value)?.label ?? value}
        </Box>
      )}
      inputProps={{ 'aria-label': 'NETCONF operation' }}
      sx={{ minWidth: 190, '& .MuiSelect-select': { py: 0.6 } }}
      MenuProps={{ slotProps: { paper: { sx: { maxHeight: 520 } } } }}
    >
      {NETCONF_OPERATION_GROUPS.flatMap((group) => [
        <ListSubheader key={group.label} sx={{ lineHeight: '28px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {group.label}
        </ListSubheader>,
        ...group.operations.map((op) => {
          const missing = unsupported(op.value);
          return (
            <MenuItem key={op.value} value={op.value} sx={{ py: 0.5 }}>
              <ListItemText
                primary={<Box component="span" sx={{ fontFamily: MONO_FONT, fontSize: 12.5 }}>{op.label}</Box>}
                secondary={missing ?? op.description}
                slotProps={{ secondary: { sx: { fontSize: 11.5, color: missing ? 'warning.main' : undefined } } }}
              />
            </MenuItem>
          );
        }),
      ])}
    </Select>
  );
}

function CopyAsMenu({ draft }: { draft: ManagementDraft }) {
  const { profile, controller } = useWorkbench();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const copy = (text: string, what: string) => {
    setAnchor(null);
    void copyToClipboard(text).then((ok) => showToast(ok ? 'success' : 'error', ok ? `Copied ${what}.` : 'Could not copy.'));
  };
  const items = useMemo(() => {
    if (draft.protocol === 'gnmi' && profile.kind === 'gnmi') {
      // The encoding the session picked when the request leaves it open.
      const offered = controller.gnmiInfo?.encodings ?? [];
      const encoding = offered.includes('json_ietf') ? 'json_ietf' : offered.includes('json') ? 'json' : undefined;
      return [
        {
          label: 'gnmic command',
          detail: 'Run the same request from a shell',
          icon: <TerminalOutlinedIcon fontSize="small" />,
          text: () => gnmicCommand(profile as GnmiProfile, draft, encoding),
        },
        {
          label: 'Request JSON',
          detail: 'The request as Muxus sends it',
          icon: <CodeOutlinedIcon fontSize="small" />,
          text: () => JSON.stringify(gnmiMessage(draft), null, 2),
        },
      ];
    }
    if (draft.protocol === 'netconf' && profile.kind === 'netconf') {
      return [
        {
          label: 'RPC XML',
          detail: 'The <rpc> exactly as it goes on the wire',
          icon: <CodeOutlinedIcon fontSize="small" />,
          text: () => prettyXml(rpcEnvelope(netconfRpcBody(draft))),
        },
        {
          label: 'ncclient script',
          detail: 'Python that sends this RPC',
          icon: <CodeOutlinedIcon fontSize="small" />,
          text: () => ncclientScript(profile as NetconfProfile, draft),
        },
        {
          label: 'ssh -s netconf command',
          detail: 'A raw NETCONF session in a terminal',
          icon: <TerminalOutlinedIcon fontSize="small" />,
          text: () => netconfSshCommand(profile as NetconfProfile),
        },
      ];
    }
    return [];
  }, [draft, profile, controller]);
  return (
    <>
      <Tooltip title="Copy as …">
        <IconButton size="small" aria-label="Copy as" onClick={(event) => setAnchor(event.currentTarget)}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {items.map((item) => (
          <MenuItem key={item.label} onClick={() => copy(item.text(), item.label)}>
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} secondary={item.detail} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

function SaveRequestDialog({ open, draft, onClose }: { open: boolean; draft: ManagementDraft; onClose: () => void }) {
  const { profile, title } = useWorkbench();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'host' | 'all'>(profile.profileId ? 'host' : 'all');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setName('');
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const protocolName = profile.kind === 'gnmi' ? 'gNMI' : 'NETCONF';
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/management/requests', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: profile.kind,
          ...(scope === 'host' && profile.profileId ? { profileId: profile.profileId } : {}),
          name: name.trim(),
          request: draft,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: [REQUESTS_QUERY_KEY] });
      showToast('success', `Saved “${name.trim()}”.`);
      onClose();
    } catch (err) {
      showErrorToast(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Save request</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField
            inputRef={nameRef}
            fullWidth
            label="Name"
            placeholder={draft.protocol === 'gnmi' ? 'Interface counters' : 'BGP configuration'}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void save();
              }
            }}
          />
          <RadioGroup value={scope} onChange={(event) => setScope(event.target.value as 'host' | 'all')}>
            <FormControlLabel
              value="host"
              disabled={!profile.profileId}
              control={<Radio size="small" />}
              label={
                <Typography variant="body2">
                  Only for {title}
                  {!profile.profileId && (
                    <Typography component="span" variant="caption" color="textSecondary">
                      {' '}
                      (save the host first)
                    </Typography>
                  )}
                </Typography>
              }
            />
            <FormControlLabel
              value="all"
              control={<Radio size="small" />}
              label={<Typography variant="body2">For every {protocolName} host</Typography>}
            />
          </RadioGroup>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!name.trim() || saving} onClick={() => void save()}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
