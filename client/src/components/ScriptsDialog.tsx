import { useEffect, useMemo, useRef, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RedoIcon from '@mui/icons-material/Redo';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import StopIcon from '@mui/icons-material/Stop';
import SyncIcon from '@mui/icons-material/Sync';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import type { SavedScript } from '@muxus/shared';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { useDeleteScript, useSaveScript, useSavedScripts } from '../api/scripts.js';
import { copyToClipboard } from '../clipboard.js';
import type { ManagedHost } from '../managed-hosts.js';
import type { HostRunState, RunMode } from '../scripts/run-plan.js';
import {
  cancelScriptJob,
  jobRunning,
  scriptTarget,
  startScriptJob,
  useScriptJobStore,
  type HostRun,
  type ScriptTarget,
} from '../scripts/script-jobs.js';
import { confirmAction } from '../state/dialogs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';

type View = 'script' | 'results';
type ModeKind = RunMode['kind'];

const NEW_SCRIPT = '__new__';

/**
 * Run a script on many SSH hosts: all at once, in batches, or one by one.
 * Scripts are kept in Muxus; a local file can be loaded into one. Runs go
 * on in the background, so closing the dialog does not stop them.
 */
export function ScriptsDialog() {
  const state = useUiStore((s) => s.scriptsDialog);
  const setState = useUiStore((s) => s.setScriptsDialog);
  const job = useScriptJobStore((s) => s.job);
  const { data: scriptsData } = useSavedScripts();
  const scripts = scriptsData?.scripts ?? [];
  const { data: config } = useSshConfig();
  const { data: saved } = useSavedHostProfiles();

  const targets = useMemo<ScriptTarget[]>(() => {
    const hosts: ManagedHost[] = [
      ...(config?.hosts ?? []).map((entry) => ({ kind: 'ssh' as const, entry })),
      ...(saved?.profiles ?? []).map((entry) => ({ kind: 'profile' as const, entry })),
    ];
    return hosts
      .map(scriptTarget)
      .filter((target): target is ScriptTarget => !!target)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [config?.hosts, saved?.profiles]);

  const [view, setView] = useState<View>(jobRunning(job) ? 'results' : 'script');
  const [selectedId, setSelectedId] = useState<string>(NEW_SCRIPT);
  const [name, setName] = useState('');
  const [body, setBody] = useState('#!/bin/sh\n');
  const [dirty, setDirty] = useState(false);
  const [chosen, setChosen] = useState<string[]>(() => (state ? (state.hostKeys ?? []) : []));
  const [modeKind, setModeKind] = useState<ModeKind>('parallel');
  const [batchSize, setBatchSize] = useState('5');
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState('30');
  const fileInput = useRef<HTMLInputElement>(null);

  const saveScript = useSaveScript((script) => {
    setSelectedId(script.id);
    setDirty(false);
    showToast('success', `Saved “${script.name}”.`);
  });
  const pick = (id: string, from: readonly SavedScript[] = scripts) => {
    const script = from.find((candidate) => candidate.id === id);
    setSelectedId(script ? script.id : NEW_SCRIPT);
    setName(script?.name ?? '');
    setBody(script?.body ?? '#!/bin/sh\n');
    setDirty(false);
  };
  const deleteScript = useDeleteScript(() => pick(NEW_SCRIPT));

  // Opening from a host selection replaces the picked hosts.
  useEffect(() => {
    if (state && state.hostKeys) setChosen(state.hostKeys);
  }, [state]);
  const choose = async (id: string) => {
    if (dirty && !(await confirmAction({ title: 'Discard changes?', description: 'The script has unsaved changes.', confirmLabel: 'Discard', destructive: true }))) {
      return;
    }
    pick(id);
  };

  const importFile = async (file: File) => {
    if (file.size > 1024 * 1024) {
      showToast('error', 'Scripts can be up to 1 MB.');
      return;
    }
    setSelectedId(NEW_SCRIPT);
    setName(file.name.replace(/\.[^.]+$/, '') || file.name);
    setBody(await file.text());
    setDirty(true);
  };

  const mode: RunMode =
    modeKind === 'batches' ? { kind: 'batches', size: Math.max(1, Number(batchSize) || 1) } : { kind: modeKind };
  const chosenTargets = chosen
    .map((key) => targets.find((target) => target.key === key))
    .filter((target): target is ScriptTarget => !!target);
  const running = jobRunning(job);
  const problem = !body.trim()
    ? 'The script is empty.'
    : chosenTargets.length === 0
      ? 'Pick the hosts to run it on.'
      : modeKind === 'batches' && !(Number(batchSize) >= 1)
        ? 'A batch needs at least one host.'
        : running
          ? 'A script is still running.'
          : null;

  const run = (onlyKeys?: string[]) => {
    const list = onlyKeys
      ? onlyKeys.map((key) => targets.find((target) => target.key === key)).filter((t): t is ScriptTarget => !!t)
      : chosenTargets;
    try {
      startScriptJob({
        scriptName: name.trim() || 'Untitled script',
        body,
        targets: list,
        mode,
        stopOnFailure: modeKind !== 'parallel' && stopOnFailure,
        timeoutSeconds: Math.max(0, Math.round((Number(timeoutMinutes) || 0) * 60)),
      });
      setView('results');
    } catch (err) {
      showErrorToast(err);
    }
  };

  return (
    <Dialog
      open
      onClose={() => setState(false)}
      maxWidth="lg"
      fullWidth
      slotProps={{ paper: { sx: { height: 720 } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 0 }}>
        <Box sx={{ flex: 1 }}>Scripts</Box>
        <IconButton aria-label="Close" onClick={() => setState(false)}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <Tabs value={view} onChange={(_event, next: View) => setView(next)} sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="script" label="Script & hosts" />
        <Tab value="results" label={job ? `Results — ${job.scriptName}` : 'Results'} disabled={!job} />
      </Tabs>

      {view === 'script' ? (
        <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <Box sx={{ width: 230, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
            <Stack direction="row" spacing={1} sx={{ p: 1 }}>
              <Button size="small" startIcon={<AddIcon />} onClick={() => void choose(NEW_SCRIPT)}>
                New
              </Button>
              <Button size="small" startIcon={<UploadFileOutlinedIcon />} onClick={() => fileInput.current?.click()}>
                From file…
              </Button>
              <input
                ref={fileInput}
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void importFile(file);
                }}
              />
            </Stack>
            <Divider />
            <List dense sx={{ overflow: 'auto', flex: 1 }}>
              {scripts.length === 0 ? (
                <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 1 }}>
                  No saved scripts yet.
                </Typography>
              ) : null}
              {scripts.map((script) => (
                <ListItemButton
                  key={script.id}
                  selected={script.id === selectedId}
                  onClick={() => void choose(script.id)}
                >
                  <ListItemText primary={script.name} secondary={`${script.body.split('\n').length} lines`} />
                </ListItemButton>
              ))}
            </List>
          </Box>

          <Stack spacing={2} sx={{ flex: 1, minWidth: 0, p: 2, overflow: 'auto' }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <TextField
                size="small"
                label="Name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setDirty(true);
                }}
                sx={{ flex: 1 }}
              />
              <Button
                variant="outlined"
                disabled={!name.trim() || !body.trim() || saveScript.isPending}
                onClick={() =>
                  saveScript.mutate({ ...(selectedId === NEW_SCRIPT ? {} : { id: selectedId }), name, body })
                }
              >
                {selectedId === NEW_SCRIPT ? 'Save' : dirty ? 'Save changes' : 'Saved'}
              </Button>
              {selectedId !== NEW_SCRIPT ? (
                <Tooltip title="Delete script">
                  <IconButton
                    aria-label="Delete script"
                    onClick={() =>
                      void confirmAction({
                        title: `Delete “${name}”?`,
                        description: 'The script is removed from Muxus.',
                        confirmLabel: 'Delete',
                        destructive: true,
                      }).then((confirmed) => {
                        if (confirmed) deleteScript.mutate(selectedId);
                      })
                    }
                  >
                    <DeleteOutlineIcon />
                  </IconButton>
                </Tooltip>
              ) : null}
            </Stack>
            <TextField
              label="Script"
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setDirty(true);
              }}
              multiline
              minRows={10}
              maxRows={16}
              helperText="Runs with sh, or with the interpreter its #! line names (bash, python3 …). It gets an empty stdin."
              slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: '"JetBrains Mono", monospace', fontSize: 13 } } }}
            />

            <Autocomplete
              multiple
              options={targets.map((target) => target.key)}
              value={chosen}
              onChange={(_event, value) => setChosen(value)}
              getOptionLabel={(key) => targets.find((target) => target.key === key)?.label ?? key.replace(/^\w+:/, '')}
              filterSelectedOptions
              renderValue={(value, getItemProps) =>
                value.map((key, index) => {
                  const { key: itemKey, ...itemProps } = getItemProps({ index });
                  return (
                    <Chip
                      key={itemKey}
                      size="small"
                      label={targets.find((target) => target.key === key)?.label ?? key}
                      {...itemProps}
                    />
                  );
                })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={`Run on (${chosenTargets.length} of ${targets.length} SSH hosts)`}
                  placeholder="Pick hosts"
                />
              )}
            />
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={() => setChosen(targets.map((target) => target.key))}>
                All SSH hosts
              </Button>
              <Button size="small" onClick={() => setChosen([])} disabled={chosen.length === 0}>
                Clear
              </Button>
            </Stack>

            <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ alignItems: { md: 'flex-start' } }}>
              <RadioGroup value={modeKind} onChange={(event) => setModeKind(event.target.value as ModeKind)}>
                <FormControlLabel value="parallel" control={<Radio size="small" />} label="All at once" />
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <FormControlLabel value="batches" control={<Radio size="small" />} label="In batches of" sx={{ mr: 0 }} />
                  <TextField
                    size="small"
                    value={batchSize}
                    onChange={(event) => {
                      setBatchSize(event.target.value.replace(/[^\d]/g, ''));
                      setModeKind('batches');
                    }}
                    slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': 'Batch size' } }}
                    sx={{ width: 72 }}
                  />
                  <Typography variant="body2">hosts</Typography>
                </Stack>
                <FormControlLabel value="sequential" control={<Radio size="small" />} label="One by one" />
              </RadioGroup>
              <Stack spacing={1}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={stopOnFailure && modeKind !== 'parallel'}
                      disabled={modeKind === 'parallel'}
                      onChange={(event) => setStopOnFailure(event.target.checked)}
                    />
                  }
                  label="Stop at the first host that fails"
                />
                <TextField
                  size="small"
                  label="Stop a host's run after (minutes)"
                  value={timeoutMinutes}
                  onChange={(event) => setTimeoutMinutes(event.target.value.replace(/[^\d.]/g, ''))}
                  helperText="0 lets it run"
                  sx={{ maxWidth: 260 }}
                />
              </Stack>
            </Stack>

            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <Button variant="contained" startIcon={<PlayArrowIcon />} disabled={!!problem} onClick={() => run()}>
                Run on {chosenTargets.length || ''} host{chosenTargets.length === 1 ? '' : 's'}
              </Button>
              {problem ? (
                <Typography variant="body2" color="textSecondary">
                  {problem}
                </Typography>
              ) : null}
            </Stack>
          </Stack>
        </Box>
      ) : (
        <Results onRerun={(keys) => run(keys)} />
      )}
    </Dialog>
  );
}

function Results({ onRerun }: { onRerun: (keys: string[]) => void }) {
  const job = useScriptJobStore((s) => s.job);
  const [selected, setSelected] = useState<string>();
  const outputRef = useRef<HTMLPreElement>(null);
  const host = job?.hosts.find((candidate) => candidate.key === selected) ?? job?.hosts[0];
  const output = host?.output ?? '';

  // Follow new output while the view is at the bottom.
  useEffect(() => {
    const element = outputRef.current;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) element.scrollTop = element.scrollHeight;
  }, [output]);

  if (!job) return null;
  const running = jobRunning(job);
  const count = (states: HostRunState[]) => job.hosts.filter((h) => states.includes(h.state)).length;
  const failedKeys = job.hosts.filter((h) => h.state === 'failed').map((h) => h.key);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ px: 2, py: 1, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Chip size="small" color="success" variant="outlined" label={`${count(['completed'])} succeeded`} />
        <Chip size="small" color="error" variant="outlined" label={`${count(['failed'])} failed`} />
        <Chip size="small" variant="outlined" label={`${count(['queued', 'connecting', 'running'])} to go`} />
        {count(['skipped', 'cancelled']) ? (
          <Chip size="small" variant="outlined" label={`${count(['skipped', 'cancelled'])} not run`} />
        ) : null}
        <Typography variant="body2" color="textSecondary" sx={{ flex: 1 }}>
          {modeLabel(job.mode)}
          {job.stopOnFailure ? ', stopping at the first failure' : ''}
        </Typography>
        {running ? (
          <Button color="error" startIcon={<StopIcon />} onClick={cancelScriptJob}>
            Cancel
          </Button>
        ) : failedKeys.length > 0 ? (
          <Button startIcon={<RedoIcon />} onClick={() => onRerun(failedKeys)}>
            Run again on failed hosts
          </Button>
        ) : null}
      </Stack>
      <Divider />
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <List dense sx={{ width: 280, borderRight: 1, borderColor: 'divider', overflow: 'auto' }}>
          {job.hosts.map((run) => (
            <ListItemButton key={run.key} selected={run.key === host?.key} onClick={() => setSelected(run.key)}>
              <ListItemIcon sx={{ minWidth: 32 }}>{stateIcon(run.state)}</ListItemIcon>
              <ListItemText primary={run.label} secondary={hostSummary(run)} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Stack direction="row" sx={{ px: 2, py: 1, alignItems: 'center' }}>
            <Typography variant="subtitle2" sx={{ flex: 1 }} noWrap>
              {host ? `${host.label} — ${stateLabel(host.state)}${host.exitCode !== undefined ? `, exit ${host.exitCode}` : ''}` : ''}
            </Typography>
            <Tooltip title="Copy output">
              <span>
                <IconButton size="small" aria-label="Copy output" disabled={!output} onClick={() => void copyToClipboard(output)}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          {host?.error ? (
            <Typography variant="body2" color="error" sx={{ px: 2, pb: 1 }}>
              {host.error}
            </Typography>
          ) : null}
          <Box
            component="pre"
            ref={outputRef}
            sx={{
              m: 0,
              px: 2,
              py: 1,
              flex: 1,
              overflow: 'auto',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              bgcolor: 'action.hover',
            }}
          >
            {output || (host && ['queued', 'connecting'].includes(host.state) ? '' : '(no output)')}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function modeLabel(mode: RunMode): string {
  if (mode.kind === 'parallel') return 'All at once';
  if (mode.kind === 'sequential') return 'One by one';
  return `In batches of ${mode.size}`;
}

function stateLabel(state: HostRunState): string {
  switch (state) {
    case 'queued':
      return 'waiting';
    case 'connecting':
      return 'connecting';
    case 'running':
      return 'running';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'not run';
  }
}

function hostSummary(run: HostRun): string {
  const parts = [stateLabel(run.state)];
  if (run.exitCode !== undefined && run.state !== 'completed') parts.push(`exit ${run.exitCode}`);
  if (run.startedAt && run.endedAt) parts.push(`${((run.endedAt - run.startedAt) / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

function stateIcon(state: HostRunState) {
  switch (state) {
    case 'completed':
      return <CheckCircleOutlineIcon fontSize="small" color="success" />;
    case 'failed':
      return <ErrorOutlineIcon fontSize="small" color="error" />;
    case 'running':
    case 'connecting':
      return <SyncIcon fontSize="small" color="primary" />;
    case 'cancelled':
      return <BlockIcon fontSize="small" color="disabled" />;
    case 'skipped':
      return <SkipNextIcon fontSize="small" color="disabled" />;
    default:
      return <HourglassEmptyIcon fontSize="small" color="disabled" />;
  }
}
