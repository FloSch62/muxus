import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { GnmiDataType, GnmiEncoding, GnmiSessionInfo } from '@muxus/shared';
import {
  defaultGnmiDraft,
  newItemId,
  type GnmiDraft,
  type GnmiSetItem,
  type GnmiSetOp,
} from '../../management/requests.js';
import { CodeEditor } from './CodeEditor.js';
import { useWorkbench } from './context.js';
import { PathField } from './PathField.js';
import { MONO_FONT } from './PathText.js';
import { showErrorToast } from '../../state/toast.js';

/** Compact fields that line up with the small toggle groups beside them. */
export const compactFieldSx = {
  '& .MuiInputBase-root': { height: 30, fontSize: 12.5 },
  '& .MuiInputBase-input': { py: 0 },
  '& .MuiSelect-select': { py: 0, display: 'flex', alignItems: 'center' },
  '& .MuiInputLabel-root': { fontSize: 12.5 },
} as const;
const selectSx = { minWidth: 0, ...compactFieldSx } as const;

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5 }}
    >
      {children}
    </Typography>
  );
}

function PathList({
  paths,
  onChange,
  onRun,
  label,
}: {
  paths: string[];
  onChange: (paths: string[]) => void;
  onRun: () => void;
  label: string;
}) {
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <FieldLabel>{label}</FieldLabel>
        <Button
          size="small"
          startIcon={<AddIcon sx={{ fontSize: 16 }} />}
          onClick={() => onChange([...paths, ''])}
          sx={{ py: 0, minHeight: 0, fontSize: 12 }}
        >
          Path
        </Button>
      </Stack>
      {paths.map((path, index) => (
        <Stack key={index} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          <PathField
            value={path}
            ariaLabel={`Path ${index + 1}`}
            focusOnMount={index > 0 && !path}
            onRun={onRun}
            onChange={(value) => onChange(paths.map((candidate, at) => (at === index ? value : candidate)))}
          />
          {paths.length > 1 && (
            <IconButton
              size="small"
              aria-label={`Remove path ${index + 1}`}
              onClick={() => onChange(paths.filter((_, at) => at !== index))}
              sx={{ mt: 0.25 }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

function EncodingSelect({
  value,
  info,
  onChange,
}: {
  value: GnmiEncoding | undefined;
  info: GnmiSessionInfo | undefined;
  onChange: (value: GnmiEncoding | undefined) => void;
}) {
  const offered = info?.encodings.length ? info.encodings : (['json_ietf', 'json', 'proto', 'ascii'] as GnmiEncoding[]);
  return (
    <TextField
      select
      size="small"
      label="Encoding"
      value={value ?? ''}
      onChange={(event) => onChange((event.target.value || undefined) as GnmiEncoding | undefined)}
      slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
      sx={{ width: 150, ...selectSx }}
    >
      <MenuItem value="">Session default</MenuItem>
      {offered.map((encoding) => (
        <MenuItem key={encoding} value={encoding}>
          {encoding.toUpperCase()}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function GnmiForm({ draft, onRun }: { draft: GnmiDraft; onRun: () => void }) {
  const { store, controller } = useWorkbench();
  const set = (patch: Partial<GnmiDraft>) => store.getState().setDraft(patch);
  const [advanced, setAdvanced] = useState(!!draft.prefix);
  const info = controller.gnmiInfo;

  return (
    <Stack spacing={1.5}>
      {draft.operation !== 'set' && (
        <PathList
          label={draft.operation === 'subscribe' ? 'Subscribe to' : 'Paths'}
          paths={draft.paths}
          onChange={(paths) => set({ paths })}
          onRun={onRun}
        />
      )}
      {draft.operation === 'set' && <SetItems draft={draft} onRun={onRun} />}

      {draft.operation === 'get' && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={draft.dataType}
            onChange={(_event, value: GnmiDataType | null) => value && set({ dataType: value })}
            aria-label="Data type"
            sx={{ '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12 } }}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="config">Config</ToggleButton>
            <ToggleButton value="state">State</ToggleButton>
            <ToggleButton value="operational">Operational</ToggleButton>
          </ToggleButtonGroup>
          <EncodingSelect value={draft.encoding} info={info} onChange={(encoding) => set({ encoding })} />
          <Tooltip title="Levels below each path to return (gNMI depth extension). Empty returns everything.">
            <TextField
              size="small"
              label="Depth"
              value={draft.depth ?? ''}
              placeholder="all"
              onChange={(event) => {
                const digits = event.target.value.replace(/[^\d]/g, '');
                set({ depth: digits ? Math.min(64, Math.max(1, Number(digits))) : undefined });
              }}
              slotProps={{ htmlInput: { inputMode: 'numeric' }, inputLabel: { shrink: true } }}
              sx={{ width: 84, ...compactFieldSx }}
            />
          </Tooltip>
        </Stack>
      )}

      {draft.operation === 'subscribe' && <SubscribeOptions draft={draft} />}

      {draft.operation === 'set' && (
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <FormControlLabel
              sx={{ mr: 0 }}
              control={
                <Switch
                  size="small"
                  checked={!!draft.confirmSeconds}
                  onChange={(event) => set({ confirmSeconds: event.target.checked ? 120 : undefined })}
                />
              }
              label={<Typography variant="body2">Roll back automatically unless confirmed within</Typography>}
            />
            <TextField
              size="small"
              value={draft.confirmSeconds ?? 120}
              disabled={!draft.confirmSeconds}
              onChange={(event) => set({ confirmSeconds: Math.max(1, Number(event.target.value.replace(/[^\d]/g, '')) || 1) })}
              slotProps={{ input: { endAdornment: <InputAdornment position="end">s</InputAdornment> } }}
              sx={{ width: 96, ...compactFieldSx }}
            />
          </Stack>
          <Typography variant="caption" color="textSecondary">
            {draft.confirmSeconds
              ? 'A safety net for changes that could cut you off: the device undoes the change unless you confirm it in time (gNMI commit-confirmed extension).'
              : 'Changes are shown as a diff against the device’s current configuration before anything is sent.'}
          </Typography>
        </Stack>
      )}

      <Box>
        <Button
          size="small"
          color="inherit"
          onClick={() => setAdvanced((open) => !open)}
          endIcon={
            <ExpandMoreIcon
              sx={{ transform: advanced ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }}
            />
          }
          sx={{ color: 'text.secondary', fontSize: 12, px: 0.5 }}
        >
          Advanced
        </Button>
        <Collapse in={advanced} unmountOnExit>
          <Stack direction="row" spacing={1} sx={{ pt: 1, alignItems: 'center' }}>
            <TextField
              size="small"
              label="Prefix"
              value={draft.prefix}
              placeholder="Common to every path, e.g. /network-instance[name=default]"
              onChange={(event) => set({ prefix: event.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1, ...compactFieldSx, '& input': { fontFamily: MONO_FONT } }}
            />
            {draft.operation !== 'get' && (
              <EncodingSelect value={draft.encoding} info={info} onChange={(encoding) => set({ encoding })} />
            )}
          </Stack>
        </Collapse>
      </Box>
    </Stack>
  );
}

function SubscribeOptions({ draft }: { draft: GnmiDraft }) {
  const { store } = useWorkbench();
  const sub = draft.subscribe;
  const setSub = (patch: Partial<GnmiDraft['subscribe']>) =>
    store.getState().setDraft((current) =>
      current.protocol === 'gnmi' ? { ...current, subscribe: { ...current.subscribe, ...patch } } : current,
    );
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={sub.listMode}
          onChange={(_event, value: GnmiDraft['subscribe']['listMode'] | null) => value && setSub({ listMode: value })}
          aria-label="Subscription mode"
          sx={{ '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12 } }}
        >
          <ToggleButton value="stream">Stream</ToggleButton>
          <ToggleButton value="once">Once</ToggleButton>
          <ToggleButton value="poll">Poll</ToggleButton>
        </ToggleButtonGroup>
        {sub.listMode === 'stream' && (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={sub.mode}
            onChange={(_event, value: GnmiDraft['subscribe']['mode'] | null) => value && setSub({ mode: value })}
            aria-label="Stream mode"
            sx={{ '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12 } }}
          >
            <ToggleButton value="sample">Sample</ToggleButton>
            <ToggleButton value="on-change">On change</ToggleButton>
            <ToggleButton value="target-defined">Target defined</ToggleButton>
          </ToggleButtonGroup>
        )}
        {sub.listMode === 'stream' && sub.mode === 'sample' && (
          <TextField
            size="small"
            label="Every"
            value={sub.sampleSeconds}
            onChange={(event) => {
              const seconds = Number(event.target.value.replace(/[^\d.]/g, ''));
              setSub({ sampleSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 1 });
            }}
            slotProps={{
              htmlInput: { inputMode: 'decimal' },
              input: { endAdornment: <InputAdornment position="end">s</InputAdornment> },
            }}
            sx={{ width: 90, ...compactFieldSx }}
          />
        )}
      </Stack>
      {sub.listMode === 'stream' && (
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <FormControlLabel
            control={
              <Switch size="small" checked={sub.updatesOnly} onChange={(event) => setSub({ updatesOnly: event.target.checked })} />
            }
            label={<Typography variant="body2">Changes only</Typography>}
          />
          {sub.mode === 'sample' && (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={sub.suppressRedundant}
                  onChange={(event) => setSub({ suppressRedundant: event.target.checked })}
                />
              }
              label={<Typography variant="body2">Suppress unchanged samples</Typography>}
            />
          )}
          {(sub.mode === 'on-change' || sub.suppressRedundant) && (
            <TextField
              size="small"
              label="Heartbeat"
              value={sub.heartbeatSeconds ?? ''}
              placeholder="off"
              onChange={(event) => {
                const seconds = Number(event.target.value.replace(/[^\d.]/g, ''));
                setSub({ heartbeatSeconds: seconds > 0 ? seconds : undefined });
              }}
              slotProps={{
                input: { endAdornment: <InputAdornment position="end">s</InputAdornment> },
                inputLabel: { shrink: true },
              }}
              sx={{ width: 110, ...compactFieldSx }}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}

const SET_OPS: Array<{ value: GnmiSetOp; label: string; description: string }> = [
  { value: 'update', label: 'Update', description: 'Merge the value into the existing configuration' },
  { value: 'replace', label: 'Replace', description: 'Replace everything at the path with the value' },
  { value: 'delete', label: 'Delete', description: 'Remove the path and everything below it' },
];

function SetItems({ draft, onRun }: { draft: GnmiDraft; onRun: () => void }) {
  const { store, controller, connected } = useWorkbench();
  const [loading, setLoading] = useState<string | undefined>(undefined);
  const update = (id: string, patch: Partial<GnmiSetItem>) =>
    store.getState().setDraft((current) =>
      current.protocol === 'gnmi'
        ? { ...current, set: current.set.map((item) => (item.id === id ? { ...item, ...patch } : item)) }
        : current,
    );
  const remove = (id: string) =>
    store.getState().setDraft((current) =>
      current.protocol === 'gnmi' ? { ...current, set: current.set.filter((item) => item.id !== id) } : current,
    );
  const add = (op: GnmiSetOp) =>
    store.getState().setDraft((current) =>
      current.protocol === 'gnmi'
        ? {
            ...current,
            set: [...current.set, { id: newItemId(), op, path: '', value: '', encoding: 'json_ietf' }],
          }
        : current,
    );

  const loadCurrent = async (item: GnmiSetItem) => {
    setLoading(item.id);
    try {
      const result = await controller.request({
        ...defaultGnmiDraft(),
        paths: [item.path],
        dataType: 'config',
        encoding: item.encoding === 'ascii' ? 'ascii' : undefined,
      });
      if (result.op !== 'gnmi-get') return;
      const update0 = result.notifications.flatMap((notification) => notification.updates)[0];
      const value = update0?.value.value;
      update(item.id, {
        value:
          value === undefined
            ? ''
            : item.encoding === 'ascii' && typeof value === 'string'
              ? value
              : JSON.stringify(value, null, 2),
      });
    } catch (err) {
      showErrorToast(err);
    } finally {
      setLoading(undefined);
    }
  };

  return (
    <Stack spacing={1}>
      <FieldLabel>Changes</FieldLabel>
      {draft.set.map((item, index) => (
        <Box key={item.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1, bgcolor: 'background.paper' }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
            <TextField
              select
              size="small"
              value={item.op}
              onChange={(event) => update(item.id, { op: event.target.value as GnmiSetOp })}
              sx={{ width: 110, flexShrink: 0, ...selectSx }}
              slotProps={{
                htmlInput: { 'aria-label': `Change ${index + 1} operation` },
                select: { renderValue: (value) => SET_OPS.find((op) => op.value === value)?.label ?? String(value) },
              }}
            >
              {SET_OPS.map((op) => (
                <MenuItem key={op.value} value={op.value}>
                  <Stack>
                    <span>{op.label}</span>
                    <Typography variant="caption" color="textSecondary">
                      {op.description}
                    </Typography>
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
            <PathField
              value={item.path}
              ariaLabel={`Change ${index + 1} path`}
              placeholder="/interface[name=ethernet-1/1]/description"
              onRun={onRun}
              onChange={(path) => update(item.id, { path })}
            />
            {item.op !== 'delete' && (
              <Tooltip title="Load the current value from the device">
                <span>
                  <IconButton
                    size="small"
                    aria-label="Load the current value"
                    disabled={!connected || !item.path.trim() || loading === item.id}
                    onClick={() => void loadCurrent(item)}
                    sx={{ mt: 0.25 }}
                  >
                    <CloudDownloadOutlinedIcon sx={{ fontSize: 17 }} />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {draft.set.length > 1 && (
              <IconButton size="small" aria-label={`Remove change ${index + 1}`} onClick={() => remove(item.id)} sx={{ mt: 0.25 }}>
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            )}
          </Stack>
          {item.op !== 'delete' && (
            <Stack spacing={0.5} sx={{ mt: 0.75 }}>
              <CodeEditor
                value={item.value}
                onChange={(value) => update(item.id, { value })}
                language={item.encoding === 'ascii' ? 'plaintext' : 'json'}
                autoHeight={{ min: 3, max: 14 }}
                onRun={onRun}
                placeholder={item.encoding === 'ascii' ? 'Text value' : '"a JSON value" — a string, number, or an object for a container'}
                ariaLabel={`Change ${index + 1} value`}
                lineNumbers={false}
              />
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <TextField
                  select
                  size="small"
                  value={item.encoding}
                  onChange={(event) => update(item.id, { encoding: event.target.value as GnmiSetItem['encoding'] })}
                  sx={{ width: 130, ...selectSx }}
                  slotProps={{ htmlInput: { 'aria-label': 'Value encoding' } }}
                >
                  <MenuItem value="json_ietf">JSON_IETF</MenuItem>
                  <MenuItem value="json">JSON</MenuItem>
                  <MenuItem value="ascii">ASCII</MenuItem>
                </TextField>
                <Typography variant="caption" color="textSecondary">
                  {item.encoding === 'ascii' ? 'Sent as text.' : 'Leaves take a JSON scalar, containers a JSON object.'}
                </Typography>
              </Stack>
            </Stack>
          )}
        </Box>
      ))}
      <Stack direction="row" spacing={0.5}>
        {SET_OPS.map((op) => (
          <Button key={op.value} size="small" startIcon={<AddIcon sx={{ fontSize: 16 }} />} onClick={() => add(op.value)}>
            {op.label}
          </Button>
        ))}
      </Stack>
    </Stack>
  );
}
