import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import { formatGnmiPath, GRPC_METHODS, tryParseGnmiPath, type ManagementError } from '@muxus/shared';
import { useWorkbench } from '../context.js';
import { compactFieldSx } from '../GnmiForm.js';
import { PathField } from '../PathField.js';
import { MONO_FONT, PathText } from '../PathText.js';
import { ReviewDialog } from '../ReviewDialog.js';
import { canonicalJson } from '../../../management/set-review.js';
import { deviceTime, ErrorAlert, errorOf, gnoiPath, Section, ToolHeader, useGrpc, useToolState } from './common.js';
import {
  finalizeRotation,
  rollBackRotation,
  RotationBar,
  rotationVersion,
  startRotation,
  type RotationState,
} from './rotation.js';

interface PathJson {
  origin?: string;
  elem?: Array<{ name: string; key?: Record<string, string> }>;
}

interface RuleJson {
  id?: string;
  user?: string;
  group?: string;
  path?: PathJson;
  action?: string;
  mode?: string;
}

interface GroupJson {
  name?: string;
  users?: Array<{ name?: string }>;
}

/** A rule as the editor holds it: the path as text. */
interface RuleDraft {
  id: string;
  principal: 'user' | 'group';
  name: string;
  path: string;
  mode: 'MODE_READ' | 'MODE_WRITE';
  action: 'ACTION_PERMIT' | 'ACTION_DENY';
}

interface GroupDraft {
  name: string;
  users: string;
}

interface PathzState {
  loading: boolean;
  noPolicy: boolean;
  version?: string;
  createdOn?: number | string;
  rules: RuleJson[];
  groups: GroupJson[];
  error?: ManagementError;
  editing: boolean;
  ruleDrafts: RuleDraft[];
  groupDrafts: GroupDraft[];
  probeUser: string;
  probePath: string;
  probeMode: 'MODE_READ' | 'MODE_WRITE';
  probeInstance: 'POLICY_INSTANCE_ACTIVE' | 'POLICY_INSTANCE_SANDBOX';
  probe?: { action: string; version?: string; user: string; path: string; mode: string };
  rotation: RotationState;
}

function pathText(path: PathJson | undefined): string {
  if (!path) return '/';
  return formatGnmiPath({
    ...(path.origin ? { origin: path.origin } : {}),
    elems: (path.elem ?? []).map((elem) => ({ name: elem.name, ...(elem.key ? { keys: elem.key } : {}) })),
  });
}

function toDrafts(rules: RuleJson[], groups: GroupJson[]): { ruleDrafts: RuleDraft[]; groupDrafts: GroupDraft[] } {
  return {
    ruleDrafts: rules.map((rule, index) => ({
      id: rule.id ?? `rule-${index + 1}`,
      principal: rule.group ? 'group' : 'user',
      name: rule.group ?? rule.user ?? '',
      path: pathText(rule.path),
      mode: rule.mode === 'MODE_WRITE' ? 'MODE_WRITE' : 'MODE_READ',
      action: rule.action === 'ACTION_DENY' ? 'ACTION_DENY' : 'ACTION_PERMIT',
    })),
    groupDrafts: groups.map((group) => ({
      name: group.name ?? '',
      users: (group.users ?? []).map((user) => user.name ?? '').join(', '),
    })),
  };
}

function policyFromDrafts(rules: RuleDraft[], groups: GroupDraft[]): { rules: RuleJson[]; groups: GroupJson[] } {
  return {
    rules: rules.map((rule) => {
      const parsed = tryParseGnmiPath(rule.path) ?? { elems: [] };
      return {
        id: rule.id,
        [rule.principal]: rule.name,
        path: gnoiPath(parsed.elems, parsed.origin),
        mode: rule.mode,
        action: rule.action,
      };
    }),
    groups: groups
      .filter((group) => group.name.trim())
      .map((group) => ({
        name: group.name.trim(),
        users: group.users
          .split(',')
          .map((user) => user.trim())
          .filter(Boolean)
          .map((name) => ({ name })),
      })),
  };
}

function draftProblem(rules: RuleDraft[]): string | undefined {
  for (const rule of rules) {
    if (!rule.id.trim()) return 'Every rule needs an id.';
    if (!rule.name.trim()) return `Rule ${rule.id} needs a ${rule.principal}.`;
    if (!tryParseGnmiPath(rule.path)) return `The path of rule ${rule.id} does not parse.`;
  }
  if (new Set(rules.map((rule) => rule.id.trim())).size !== rules.length) return 'Rule ids must be unique.';
  return undefined;
}

const selectSx = { ...compactFieldSx, '& .MuiSelect-select': { py: 0, display: 'flex', alignItems: 'center', fontSize: 12.5 } };

export function PathzTool() {
  const { store, controller } = useWorkbench();
  const grpc = useGrpc();
  const defaultUser = controller.info?.address.includes('@') ? controller.info.address.split('@')[0]! : '';
  const [state, setState] = useToolState<PathzState>('pathz', () => ({
    loading: false,
    noPolicy: false,
    rules: [],
    groups: [],
    editing: false,
    ruleDrafts: [],
    groupDrafts: [],
    probeUser: defaultUser,
    probePath: '/interface',
    probeMode: 'MODE_WRITE',
    probeInstance: 'POLICY_INSTANCE_ACTIVE',
    rotation: { phase: 'idle' },
  }));
  const [reviewing, setReviewing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const setRotation = (rotation: Partial<RotationState>) =>
    setState((current) => ({ ...current, rotation: { ...current.rotation, ...rotation } }));
  const rotationPhase = () => (store.getState().tools.pathz as PathzState | undefined)?.rotation.phase ?? 'idle';

  const load = async () => {
    if (!grpc) return;
    setState({ loading: true, error: undefined });
    try {
      const response = await grpc.grpcCall<{ version?: string; created_on?: number | string; policy?: { rules?: RuleJson[]; groups?: GroupJson[] } }>(
        GRPC_METHODS.pathzGet,
        { policy_instance: 'POLICY_INSTANCE_ACTIVE' },
      );
      setState({
        loading: false,
        noPolicy: false,
        version: response.version,
        createdOn: response.created_on,
        rules: response.policy?.rules ?? [],
        groups: response.policy?.groups ?? [],
      });
    } catch (err) {
      const error = errorOf(err);
      if (error.code === 'FAILED_PRECONDITION' || error.code === 'NOT_FOUND') {
        setState({ loading: false, noPolicy: true, rules: [], groups: [], version: undefined });
      } else {
        setState({ loading: false, error });
      }
    }
  };

  useEffect(() => {
    if (grpc && !loaded) {
      setLoaded(true);
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grpc]);

  useEffect(() => {
    if (state.rotation.phase === 'done' || state.rotation.phase === 'rolled-back') void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rotation.phase]);

  const probe = async () => {
    if (!grpc) return;
    const parsed = tryParseGnmiPath(state.probePath);
    if (!parsed) {
      setState({ error: { message: 'The path does not parse.' } });
      return;
    }
    try {
      const response = await grpc.grpcCall<{ action?: string; version?: string }>(GRPC_METHODS.pathzProbe, {
        user: state.probeUser.trim(),
        path: gnoiPath(parsed.elems, parsed.origin),
        mode: state.probeMode,
        policy_instance: state.probeInstance,
      });
      setState({
        probe: {
          action: response.action ?? 'ACTION_UNSPECIFIED',
          version: response.version,
          user: state.probeUser.trim(),
          path: state.probePath,
          mode: state.probeMode,
        },
      });
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  const startEditing = () => setState({ editing: true, ...toDrafts(state.rules, state.groups) });
  const updateRule = (index: number, patch: Partial<RuleDraft>) =>
    setState((current) => ({ ...current, ruleDrafts: current.ruleDrafts.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)) }));
  const problem = state.editing ? draftProblem(state.ruleDrafts) : undefined;
  const current = { rules: state.rules, groups: state.groups };
  const proposed = policyFromDrafts(state.ruleDrafts, state.groupDrafts);

  const rotate = () => {
    if (!grpc) return;
    setReviewing(false);
    const version = rotationVersion();
    startRotation(
      grpc,
      store,
      'pathz',
      {
        method: GRPC_METHODS.pathzRotate,
        finalizeField: 'finalize_rotation',
        version,
        upload: { upload_request: { version, created_on: Math.floor(Date.now() / 1000), policy: proposed } },
      },
      setRotation,
      rotationPhase,
    );
    setState({ editing: false, probeInstance: 'POLICY_INSTANCE_SANDBOX' });
  };

  const rotating = state.rotation.phase === 'pending' || state.rotation.phase === 'uploading' || state.rotation.phase === 'finalizing';

  return (
    <Box>
      <ToolHeader
        icon={<RuleOutlinedIcon fontSize="small" />}
        title="Path authorization"
        service="gnsi.pathz.v1.Pathz"
        description="Which users and groups may read or write which gNMI paths. Probe a path, or upload new rules, test them in the sandbox and make them final."
        actions={
          <Button size="small" onClick={() => void load()} disabled={!grpc || rotating}>
            Reload
          </Button>
        }
      />
      <RotationBar
        rotation={state.rotation}
        what="path rules"
        plural
        testHint="Probe the sandbox instance to see what they allow."
        onFinalize={() => finalizeRotation(store, 'pathz', setRotation)}
        onRollBack={() => rollBackRotation(store, 'pathz')}
        onDismiss={() => setRotation({ phase: 'idle', error: undefined })}
      />
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      <Section title="Probe">
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            label="User"
            value={state.probeUser}
            onChange={(event) => setState({ probeUser: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ width: 140, ...compactFieldSx }}
          />
          <Box sx={{ flex: '1 1 260px', minWidth: 200 }}>
            <PathField value={state.probePath} onChange={(probePath) => setState({ probePath })} onRun={() => void probe()} ariaLabel="Path to probe" placeholder="/interface[name=ethernet-1/1]" />
          </Box>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={state.probeMode}
            onChange={(_event, probeMode: PathzState['probeMode'] | null) => probeMode && setState({ probeMode })}
            sx={{ '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12 } }}
          >
            <ToggleButton value="MODE_READ">Read</ToggleButton>
            <ToggleButton value="MODE_WRITE">Write</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={state.probeInstance}
            onChange={(_event, probeInstance: PathzState['probeInstance'] | null) => probeInstance && setState({ probeInstance })}
            sx={{ '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12 } }}
          >
            <ToggleButton value="POLICY_INSTANCE_ACTIVE">Active</ToggleButton>
            <ToggleButton value="POLICY_INSTANCE_SANDBOX">Sandbox</ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" disabled={!grpc} onClick={() => void probe()}>
            Probe
          </Button>
        </Stack>
        {state.probe && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1.5 }}>
            <Chip
              size="small"
              color={state.probe.action === 'ACTION_PERMIT' ? 'success' : 'error'}
              label={state.probe.action === 'ACTION_PERMIT' ? 'Permit' : state.probe.action === 'ACTION_DENY' ? 'Deny' : 'Unspecified'}
              sx={{ height: 22 }}
            />
            <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12 }}>
              {state.probe.user} {state.probe.mode === 'MODE_WRITE' ? 'writes' : 'reads'} {state.probe.path}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" color="textSecondary">
              policy {state.probe.version || '—'}
            </Typography>
          </Stack>
        )}
      </Section>
      <Section
        title="Rules in force"
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {state.version && (
              <Typography variant="caption" color="textSecondary">
                {state.version} · {deviceTime(state.createdOn, 's')}
              </Typography>
            )}
            {state.editing ? (
              <>
                <Button size="small" color="inherit" onClick={() => setState({ editing: false })}>
                  Cancel
                </Button>
                <Button size="small" variant="contained" disabled={!!problem} onClick={() => setReviewing(true)}>
                  Review & rotate…
                </Button>
              </>
            ) : (
              <Button size="small" disabled={!grpc || rotating || state.loading} onClick={startEditing}>
                {state.noPolicy ? 'Create rules…' : 'Edit…'}
              </Button>
            )}
          </Stack>
        }
      >
        {state.loading ? (
          <CircularProgress size={20} />
        ) : state.editing ? (
          <Stack spacing={1}>
            {state.ruleDrafts.map((rule, index) => (
              <Stack key={index} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <TextField size="small" label="Id" value={rule.id} onChange={(event) => updateRule(index, { id: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 110, ...compactFieldSx }} />
                <TextField select size="small" label="Who" value={rule.principal} onChange={(event) => updateRule(index, { principal: event.target.value as RuleDraft['principal'] })} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 90, ...selectSx }}>
                  <MenuItem value="user">User</MenuItem>
                  <MenuItem value="group">Group</MenuItem>
                </TextField>
                <TextField size="small" label={rule.principal === 'user' ? 'User' : 'Group'} value={rule.name} onChange={(event) => updateRule(index, { name: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 120, ...compactFieldSx }} />
                <TextField size="small" label="Path" value={rule.path} onChange={(event) => updateRule(index, { path: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} sx={{ flex: 1, ...compactFieldSx, '& input': { fontFamily: MONO_FONT } }} />
                <TextField select size="small" label="Mode" value={rule.mode} onChange={(event) => updateRule(index, { mode: event.target.value as RuleDraft['mode'] })} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 96, ...selectSx }}>
                  <MenuItem value="MODE_READ">Read</MenuItem>
                  <MenuItem value="MODE_WRITE">Write</MenuItem>
                </TextField>
                <TextField select size="small" label="Action" value={rule.action} onChange={(event) => updateRule(index, { action: event.target.value as RuleDraft['action'] })} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 104, ...selectSx }}>
                  <MenuItem value="ACTION_PERMIT">Permit</MenuItem>
                  <MenuItem value="ACTION_DENY">Deny</MenuItem>
                </TextField>
                <IconButton size="small" aria-label={`Remove rule ${rule.id}`} onClick={() => setState({ ruleDrafts: state.ruleDrafts.filter((_, at) => at !== index) })}>
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Stack>
            ))}
            <Box>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() =>
                  setState({
                    ruleDrafts: [
                      ...state.ruleDrafts,
                      { id: `rule-${state.ruleDrafts.length + 1}`, principal: 'user', name: defaultUser, path: '/', mode: 'MODE_WRITE', action: 'ACTION_PERMIT' },
                    ],
                  })
                }
              >
                Rule
              </Button>
            </Box>
            <Typography variant="subtitle2" sx={{ pt: 1 }}>
              Groups
            </Typography>
            {state.groupDrafts.map((group, index) => (
              <Stack key={index} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <TextField size="small" label="Group" value={group.name} onChange={(event) => setState({ groupDrafts: state.groupDrafts.map((candidate, at) => (at === index ? { ...candidate, name: event.target.value } : candidate)) })} slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 160, ...compactFieldSx }} />
                <TextField size="small" label="Users (comma separated)" value={group.users} onChange={(event) => setState({ groupDrafts: state.groupDrafts.map((candidate, at) => (at === index ? { ...candidate, users: event.target.value } : candidate)) })} slotProps={{ inputLabel: { shrink: true } }} sx={{ flex: 1, ...compactFieldSx }} />
                <IconButton size="small" aria-label={`Remove group ${group.name}`} onClick={() => setState({ groupDrafts: state.groupDrafts.filter((_, at) => at !== index) })}>
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Stack>
            ))}
            <Box>
              <Button size="small" startIcon={<AddIcon />} onClick={() => setState({ groupDrafts: [...state.groupDrafts, { name: '', users: '' }] })}>
                Group
              </Button>
            </Box>
            {problem && (
              <Typography variant="caption" color="error">
                {problem}
              </Typography>
            )}
          </Stack>
        ) : state.noPolicy ? (
          <Alert severity="info">No path authorization policy is active. gNMI access is only limited by the authorization policy and the device's own roles.</Alert>
        ) : state.rules.length === 0 ? (
          <Typography variant="body2" color="textSecondary">
            The policy has no rules.
          </Typography>
        ) : (
          <Box>
            {state.rules.map((rule, index) => (
              <Stack key={rule.id ?? index} direction="row" spacing={1.5} sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider', alignItems: 'center' }}>
                <Chip size="small" color={rule.action === 'ACTION_DENY' ? 'error' : 'success'} label={rule.action === 'ACTION_DENY' ? 'Deny' : 'Permit'} sx={{ height: 22, minWidth: 58 }} />
                <Chip size="small" variant="outlined" label={rule.mode === 'MODE_WRITE' ? 'write' : 'read'} sx={{ height: 20, fontSize: 11 }} />
                <Typography variant="body2" sx={{ width: 140 }} noWrap>
                  {rule.group ? `group ${rule.group}` : rule.user}
                </Typography>
                <Box sx={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
                  <PathText path={pathText(rule.path)} />
                </Box>
                <Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO_FONT }}>
                  {rule.id}
                </Typography>
              </Stack>
            ))}
            {state.groups.length > 0 && (
              <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap', mt: 1.5 }}>
                {state.groups.map((group) => (
                  <Chip key={group.name} size="small" variant="outlined" label={`${group.name}: ${(group.users ?? []).map((user) => user.name).join(', ')}`} />
                ))}
              </Stack>
            )}
          </Box>
        )}
      </Section>
      <ReviewDialog
        open={reviewing}
        title="Rotate the path rules"
        description="The rules are uploaded to the sandbox and take effect provisionally. Probe them, then finalize; rolling back restores the current rules."
        sections={[{ label: 'policy', original: state.noPolicy ? '' : canonicalJson(current), modified: canonicalJson(proposed), language: 'json' }]}
        applyLabel="Upload"
        onApply={rotate}
        onClose={() => setReviewing(false)}
      />
    </Box>
  );
}
