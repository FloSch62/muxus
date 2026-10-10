import { useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { netconfRpcBody, type Datastore, type NetconfDraft } from '../../management/requests.js';
import { prettyXml, rpcEnvelope, xmlFragmentError } from '../../management/xml.js';
import { CodeEditor } from './CodeEditor.js';
import { useWorkbench } from './context.js';
import { compactFieldSx, FieldLabel } from './GnmiForm.js';
import { MONO_FONT } from './PathText.js';

const selectSx = compactFieldSx;
const toggleSx = { '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12, fontFamily: MONO_FONT } } as const;

/** YANG modules the device lists in its hello, for get-schema. */
export function helloModules(capabilities: readonly string[]): Array<{ name: string; revision?: string; namespace: string }> {
  const modules: Array<{ name: string; revision?: string; namespace: string }> = [];
  for (const capability of capabilities) {
    const query = capability.indexOf('?');
    if (query < 0) continue;
    const params = new URLSearchParams(capability.slice(query + 1).replace(/&amp;/g, '&'));
    const name = params.get('module');
    if (!name) continue;
    modules.push({ name, revision: params.get('revision') ?? undefined, namespace: capability.slice(0, query) });
  }
  return modules.sort((a, b) => a.name.localeCompare(b.name));
}

function DatastoreToggle({
  value,
  options,
  onChange,
  label,
}: {
  value: Datastore;
  options: Datastore[];
  onChange: (value: Datastore) => void;
  label: string;
}) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" color="textSecondary" sx={{ minWidth: 52 }}>
        {label}
      </Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={value}
        onChange={(_event, next: Datastore | null) => next && onChange(next)}
        aria-label={label}
        sx={toggleSx}
      >
        {options.map((option) => (
          <ToggleButton key={option} value={option}>
            {option}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Stack>
  );
}

export function NetconfForm({ draft, onRun }: { draft: NetconfDraft; onRun: () => void }) {
  const { store, controller } = useWorkbench();
  const set = (patch: Partial<NetconfDraft>) => store.getState().setDraft(patch);
  const [preview, setPreview] = useState(false);
  const has = (fragment: string) => controller.hasCapability(fragment);
  const datastores: Datastore[] = ['running', ...(has(':candidate') ? ['candidate' as const] : []), ...(has(':startup') ? ['startup' as const] : [])];
  const writable: Datastore[] = [
    ...(has(':writable-running') ? ['running' as const] : []),
    ...(has(':candidate') ? ['candidate' as const] : []),
    ...(has(':startup') ? ['startup' as const] : []),
  ];
  const editTargets = writable.length ? writable : (['running', 'candidate'] as Datastore[]);
  const modules = useMemo(() => helloModules(controller.netconfInfo?.capabilities ?? []), [controller.netconfInfo]);
  const op = draft.operation;
  const filterError = draft.filterType === 'subtree' ? xmlFragmentError(draft.filter) : undefined;
  const configError = op === 'edit-config' ? xmlFragmentError(draft.config) : undefined;
  const rpcError = op === 'custom' ? xmlFragmentError(draft.rpc) : undefined;

  return (
    <Stack spacing={1.25}>
      {op === 'get-config' && (
        <DatastoreToggle label="Source" value={draft.source} options={datastores} onChange={(source) => set({ source })} />
      )}
      {(op === 'edit-config' || op === 'lock' || op === 'unlock' || op === 'delete-config') && (
        <DatastoreToggle
          label="Target"
          value={draft.target}
          options={op === 'edit-config' ? editTargets : op === 'delete-config' ? datastores.filter((store) => store !== 'running') : datastores}
          onChange={(target) => set({ target })}
        />
      )}
      {op === 'validate' && (
        <DatastoreToggle label="Source" value={draft.source} options={datastores} onChange={(source) => set({ source })} />
      )}
      {op === 'copy-config' && (
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <DatastoreToggle label="From" value={draft.source} options={datastores} onChange={(source) => set({ source })} />
          <DatastoreToggle label="To" value={draft.target} options={editTargets} onChange={(target) => set({ target })} />
        </Stack>
      )}

      {(op === 'get' || op === 'get-config' || op === 'create-subscription') && (
        <Stack spacing={0.75}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <FieldLabel>Filter</FieldLabel>
            <Box sx={{ flex: 1 }} />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={draft.filterType}
              onChange={(_event, filterType: NetconfDraft['filterType'] | null) => filterType && set({ filterType })}
              aria-label="Filter type"
              sx={{ '& .MuiToggleButton-root': { py: 0.2, px: 1, fontSize: 11.5 } }}
            >
              <ToggleButton value="subtree">Subtree</ToggleButton>
              {has(':xpath') && op !== 'create-subscription' && <ToggleButton value="xpath">XPath</ToggleButton>}
              <ToggleButton value="none">None</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          {draft.filterType === 'subtree' && (
            <>
              <CodeEditor
                value={draft.filter}
                onChange={(filter) => set({ filter })}
                language="xml"
                autoHeight={{ min: 3, max: 16 }}
                onRun={onRun}
                placeholder={'<interface xmlns="urn:example:interfaces">\n  <name>eth0</name>\n</interface>'}
                ariaLabel="Subtree filter"
                modelPath="netconf-filter.xml"
              />
              {filterError ? (
                <Typography variant="caption" color="error">
                  {filterError}
                </Typography>
              ) : (
                <Typography variant="caption" color="textSecondary">
                  Empty selects everything. Right-click a node in the explorer to filter on it.
                </Typography>
              )}
            </>
          )}
          {draft.filterType === 'xpath' && (
            <TextField
              size="small"
              value={draft.filter}
              placeholder="/interfaces/interface[name='eth0']"
              onChange={(event) => set({ filter: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onRun();
                }
              }}
              sx={{ '& input': { fontFamily: MONO_FONT, fontSize: 12.5 } }}
              slotProps={{ htmlInput: { 'aria-label': 'XPath filter', spellCheck: false } }}
            />
          )}
        </Stack>
      )}

      {(op === 'get' || op === 'get-config') && has('with-defaults') && (
        <TextField
          select
          size="small"
          label="Defaults"
          value={draft.withDefaults}
          onChange={(event) => set({ withDefaults: event.target.value as NetconfDraft['withDefaults'] })}
          slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
          sx={{ width: 220, ...selectSx }}
        >
          <MenuItem value="">Device default</MenuItem>
          <MenuItem value="report-all">report-all: include defaults</MenuItem>
          <MenuItem value="report-all-tagged">report-all-tagged</MenuItem>
          <MenuItem value="trim">trim: leave defaults out</MenuItem>
          <MenuItem value="explicit">explicit: only what was set</MenuItem>
        </TextField>
      )}

      {op === 'edit-config' && (
        <Stack spacing={0.75}>
          <FieldLabel>Configuration</FieldLabel>
          <CodeEditor
            value={draft.config}
            onChange={(config) => set({ config })}
            language="xml"
            autoHeight={{ min: 6, max: 24 }}
            onRun={onRun}
            placeholder={'<interface xmlns="urn:example:interfaces">\n  <name>eth0</name>\n  <description>uplink</description>\n</interface>'}
            ariaLabel="Configuration to apply"
            modelPath="netconf-config.xml"
          />
          {configError && (
            <Typography variant="caption" color="error">
              {configError}
            </Typography>
          )}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <TextField
              select
              size="small"
              label="Default operation"
              value={draft.defaultOperation}
              onChange={(event) => set({ defaultOperation: event.target.value as NetconfDraft['defaultOperation'] })}
              slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
              sx={{ width: 170, ...selectSx }}
            >
              <MenuItem value="">merge (default)</MenuItem>
              <MenuItem value="merge">merge</MenuItem>
              <MenuItem value="replace">replace</MenuItem>
              <MenuItem value="none">none</MenuItem>
            </TextField>
            {has(':validate') && (
              <TextField
                select
                size="small"
                label="Test option"
                value={draft.testOption}
                onChange={(event) => set({ testOption: event.target.value as NetconfDraft['testOption'] })}
                slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                sx={{ width: 160, ...selectSx }}
              >
                <MenuItem value="">default</MenuItem>
                <MenuItem value="test-then-set">test-then-set</MenuItem>
                <MenuItem value="set">set</MenuItem>
                <MenuItem value="test-only">test-only</MenuItem>
              </TextField>
            )}
            <TextField
              select
              size="small"
              label="On error"
              value={draft.errorOption}
              onChange={(event) => set({ errorOption: event.target.value as NetconfDraft['errorOption'] })}
              slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
              sx={{ width: 180, ...selectSx }}
            >
              <MenuItem value="">stop-on-error (default)</MenuItem>
              <MenuItem value="stop-on-error">stop-on-error</MenuItem>
              <MenuItem value="continue-on-error">continue-on-error</MenuItem>
              {has(':rollback-on-error') && <MenuItem value="rollback-on-error">rollback-on-error</MenuItem>}
            </TextField>
          </Stack>
          {draft.target === 'candidate' && (
            <Typography variant="caption" color="textSecondary">
              Changes land in the candidate. Review and commit them from the bar above.
            </Typography>
          )}
        </Stack>
      )}

      {(op === 'commit' || op === 'cancel-commit') && (
        <Stack spacing={1}>
          {op === 'commit' && has(':confirmed-commit') && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <FormControlLabel
                control={<Switch size="small" checked={draft.confirmed} onChange={(event) => set({ confirmed: event.target.checked })} />}
                label={<Typography variant="body2">Confirmed commit — roll back unless confirmed within</Typography>}
              />
              <TextField
                size="small"
                value={draft.confirmTimeout}
                disabled={!draft.confirmed}
                onChange={(event) => set({ confirmTimeout: Number(event.target.value.replace(/[^\d]/g, '')) || 1 })}
                slotProps={{ input: { endAdornment: <InputAdornment position="end">s</InputAdornment> } }}
                sx={{ width: 100, '& input': { py: 0.75 } }}
              />
            </Stack>
          )}
          {has(':confirmed-commit:1.1') && (
            <TextField
              size="small"
              label={op === 'commit' && draft.confirmed ? 'Persist id (optional)' : 'Persist id of a persistent confirmed commit'}
              value={draft.persist}
              onChange={(event) => set({ persist: event.target.value })}
              sx={{ maxWidth: 360 }}
            />
          )}
        </Stack>
      )}

      {op === 'get-schema' && (
        <Stack direction="row" spacing={1}>
          <Autocomplete
            freeSolo
            size="small"
            options={modules.map((module) => module.name)}
            value={draft.schemaIdentifier}
            onInputChange={(_event, value) => {
              const module = modules.find((candidate) => candidate.name === value);
              set({ schemaIdentifier: value, schemaVersion: module?.revision ?? '' });
            }}
            renderInput={(params) => <TextField {...params} label="Module" placeholder="ietf-interfaces" />}
            sx={{ flex: 1, maxWidth: 420 }}
          />
          <TextField
            size="small"
            label="Revision"
            value={draft.schemaVersion}
            placeholder="latest"
            onChange={(event) => set({ schemaVersion: event.target.value })}
            sx={{ width: 140 }}
          />
        </Stack>
      )}

      {op === 'kill-session' && (
        <TextField
          size="small"
          label="Session id"
          value={draft.sessionId}
          onChange={(event) => set({ sessionId: event.target.value.replace(/[^\d]/g, '') })}
          sx={{ width: 160 }}
        />
      )}

      {op === 'custom' && (
        <Stack spacing={0.75}>
          <FieldLabel>RPC</FieldLabel>
          <CodeEditor
            value={draft.rpc}
            onChange={(rpc) => set({ rpc })}
            language="xml"
            autoHeight={{ min: 6, max: 24 }}
            onRun={onRun}
            placeholder={'<get-config>\n  <source><running/></source>\n</get-config>'}
            ariaLabel="Custom RPC"
            modelPath="netconf-custom.xml"
          />
          <Typography variant="caption" color={rpcError ? 'error' : 'textSecondary'}>
            {rpcError ?? 'The operation goes inside <rpc>; Muxus adds the envelope and message-id. A whole <rpc> pasted in works too.'}
          </Typography>
        </Stack>
      )}

      {(op === 'discard-changes' || op === 'lock' || op === 'unlock' || op === 'validate') && (
        <Typography variant="caption" color="textSecondary">
          {op === 'discard-changes'
            ? 'Throws away every uncommitted change in the candidate, yours and other sessions’.'
            : op === 'lock'
              ? 'Keeps other sessions from changing the datastore until you unlock it or this session ends.'
              : op === 'unlock'
                ? 'Releases a lock this session holds.'
                : 'Checks the datastore for errors without applying anything.'}
        </Typography>
      )}

      <Box>
        <Button
          size="small"
          color="inherit"
          onClick={() => setPreview((open) => !open)}
          endIcon={<ExpandMoreIcon sx={{ transform: preview ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }} />}
          sx={{ color: 'text.secondary', fontSize: 12, px: 0.5 }}
        >
          RPC as sent
        </Button>
        <Collapse in={preview} unmountOnExit>
          <Box sx={{ pt: 0.5 }}>
            <CodeEditor
              value={prettyXml(rpcEnvelope(netconfRpcBody(draft)))}
              language="xml"
              readOnly
              autoHeight={{ min: 3, max: 16 }}
              ariaLabel="RPC preview"
              lineNumbers={false}
            />
          </Box>
        </Collapse>
      </Box>
    </Stack>
  );
}
