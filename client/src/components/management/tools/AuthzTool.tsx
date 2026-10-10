import { useEffect, useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import { GRPC_METHODS, type ManagementError } from '@muxus/shared';
import { useWorkbench } from '../context.js';
import { CodeEditor } from '../CodeEditor.js';
import { compactFieldSx } from '../GnmiForm.js';
import { MONO_FONT } from '../PathText.js';
import { ReviewDialog } from '../ReviewDialog.js';
import { deviceTime, ErrorAlert, errorOf, Section, shrunkLabel, ToolHeader, useGrpc, useToolState } from './common.js';
import {
  finalizeRotation,
  rollBackRotation,
  RotationBar,
  rotationVersion,
  startRotation,
  type RotationState,
} from './rotation.js';

interface AuthzRule {
  name?: string;
  source?: { principals?: string[] };
  request?: { paths?: string[]; headers?: Array<{ key?: string; values?: string[] }> };
}

interface AuthzPolicy {
  name?: string;
  allow_rules?: AuthzRule[];
  deny_rules?: AuthzRule[];
}

interface ProbeRecord {
  user: string;
  rpc: string;
  action: string;
  version?: string;
  at: number;
}

interface AuthzState {
  loading: boolean;
  version?: string;
  createdOn?: number | string;
  policy?: string;
  error?: ManagementError;
  view: 'rules' | 'json';
  editing: boolean;
  draft: string;
  probeUser: string;
  probeRpc: string;
  probes: ProbeRecord[];
  rotation: RotationState;
}

/** The RPCs worth probing: the gNMI ones and every gNOI/gNSI call Muxus knows. */
const PROBE_RPCS = [
  '/gnmi.gNMI/Capabilities',
  '/gnmi.gNMI/Get',
  '/gnmi.gNMI/Set',
  '/gnmi.gNMI/Subscribe',
  ...Object.values(GRPC_METHODS),
];

function prettyPolicy(text: string | undefined): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function RuleRow({ rule, effect }: { rule: AuthzRule; effect: 'allow' | 'deny' }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ py: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'flex-start' }}>
      <Chip size="small" color={effect === 'allow' ? 'success' : 'error'} label={effect === 'allow' ? 'Allow' : 'Deny'} sx={{ height: 22, minWidth: 58 }} />
      <Box sx={{ width: 180, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {rule.name ?? 'unnamed'}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" color="textSecondary">
          Who
        </Typography>
        <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap', mb: 0.5 }}>
          {(rule.source?.principals?.length ? rule.source.principals : ['anyone']).map((principal) => (
            <Chip key={principal} size="small" variant="outlined" label={principal === '*' ? 'everyone' : principal} sx={{ height: 20, fontSize: 11 }} />
          ))}
        </Stack>
        <Typography variant="caption" color="textSecondary">
          What
        </Typography>
        <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap' }}>
          {(rule.request?.paths?.length ? rule.request.paths : ['every RPC']).map((path) => (
            <Chip key={path} size="small" label={path === '/*' ? 'every RPC' : path || '(empty)'} sx={{ height: 20, fontSize: 11, fontFamily: MONO_FONT }} />
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}

export function AuthzTool() {
  const { store, controller } = useWorkbench();
  const grpc = useGrpc();
  const defaultUser = controller.info?.address.includes('@') ? controller.info.address.split('@')[0]! : '';
  const [state, setState] = useToolState<AuthzState>('authz', () => ({
    loading: false,
    view: 'rules',
    editing: false,
    draft: '',
    probeUser: defaultUser,
    probeRpc: '/gnmi.gNMI/Set',
    probes: [],
    rotation: { phase: 'idle' },
  }));
  const [reviewing, setReviewing] = useState(false);
  const setRotation = (rotation: Partial<RotationState>) =>
    setState((current) => ({ ...current, rotation: { ...current.rotation, ...rotation } }));
  const rotationPhase = () => (store.getState().tools.authz as AuthzState | undefined)?.rotation.phase ?? 'idle';

  const load = async () => {
    if (!grpc) return;
    setState({ loading: true, error: undefined });
    try {
      const response = await grpc.grpcCall<{ version?: string; created_on?: number | string; policy?: string }>(GRPC_METHODS.authzGet, {});
      setState({ loading: false, version: response.version, createdOn: response.created_on, policy: response.policy ?? '' });
    } catch (err) {
      setState({ loading: false, error: errorOf(err) });
    }
  };

  useEffect(() => {
    if (grpc && state.policy === undefined && !state.loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grpc]);

  useEffect(() => {
    if (state.rotation.phase === 'done' || state.rotation.phase === 'rolled-back') void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rotation.phase]);

  const policy = useMemo<AuthzPolicy | undefined>(() => {
    try {
      return state.policy ? (JSON.parse(state.policy) as AuthzPolicy) : undefined;
    } catch {
      return undefined;
    }
  }, [state.policy]);

  const probe = async () => {
    if (!grpc || !state.probeUser.trim() || !state.probeRpc.trim()) return;
    try {
      const response = await grpc.grpcCall<{ action?: string; version?: string }>(GRPC_METHODS.authzProbe, {
        user: state.probeUser.trim(),
        rpc: state.probeRpc.trim(),
      });
      const record: ProbeRecord = {
        user: state.probeUser.trim(),
        rpc: state.probeRpc.trim(),
        action: response.action ?? 'ACTION_UNSPECIFIED',
        version: response.version,
        at: Date.now(),
      };
      setState((current) => ({ ...current, probes: [record, ...current.probes].slice(0, 12) }));
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  const draftError = useMemo(() => {
    if (!state.editing) return undefined;
    try {
      JSON.parse(state.draft);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }, [state.editing, state.draft]);

  const rotate = () => {
    if (!grpc) return;
    setReviewing(false);
    const version = rotationVersion();
    startRotation(
      grpc,
      store,
      'authz',
      {
        method: GRPC_METHODS.authzRotate,
        finalizeField: 'finalize_rotation',
        version,
        upload: {
          upload_request: { version, created_on: Math.floor(Date.now() / 1000), policy: JSON.stringify(JSON.parse(state.draft)) },
        },
      },
      setRotation,
      rotationPhase,
    );
    setState({ editing: false });
  };

  const rotating = state.rotation.phase === 'pending' || state.rotation.phase === 'uploading' || state.rotation.phase === 'finalizing';

  return (
    <Box>
      <ToolHeader
        icon={<AdminPanelSettingsOutlinedIcon fontSize="small" />}
        title="Authorization"
        service="gnsi.authz.v1.Authz"
        description="Who may call which gRPC methods on this device. Probe a user and RPC against the policy in force, and replace the policy safely: it takes effect, you test it, then make it final."
        actions={
          <Button size="small" onClick={() => void load()} disabled={!grpc || rotating}>
            Reload
          </Button>
        }
      />
      <RotationBar
        rotation={state.rotation}
        what="policy"
        testHint="Probe it now: probes run against the new policy."
        onFinalize={() => finalizeRotation(store, 'authz', setRotation)}
        onRollBack={() => rollBackRotation(store, 'authz')}
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
            sx={{ width: 160, ...compactFieldSx }}
          />
          <Autocomplete
            freeSolo
            size="small"
            options={PROBE_RPCS}
            value={state.probeRpc}
            onInputChange={(_event, probeRpc) => setState({ probeRpc })}
            renderInput={(params) => <TextField {...shrunkLabel(params)} label="RPC" />}
            sx={{ flex: '1 1 300px', ...compactFieldSx, '& input': { fontFamily: MONO_FONT } }}
          />
          <Button variant="contained" disabled={!grpc} onClick={() => void probe()}>
            Probe
          </Button>
        </Stack>
        {state.probes.length > 0 && (
          <Stack spacing={0.5} sx={{ mt: 1.5 }}>
            {state.probes.map((record) => {
              const permit = record.action === 'ACTION_PERMIT';
              return (
                <Stack key={record.at} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Chip size="small" color={permit ? 'success' : 'error'} label={permit ? 'Permit' : record.action === 'ACTION_DENY' ? 'Deny' : 'Unspecified'} sx={{ height: 20, minWidth: 64 }} />
                  <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12 }}>
                    {record.user} → {record.rpc}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="caption" color="textSecondary">
                    policy {record.version || '—'} · {new Date(record.at).toLocaleTimeString()}
                  </Typography>
                </Stack>
              );
            })}
          </Stack>
        )}
      </Section>
      <Section
        title="Policy in force"
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {state.version && (
              <Typography variant="caption" color="textSecondary">
                {state.version} · {deviceTime(state.createdOn, 's')}
              </Typography>
            )}
            {!state.editing && (
              <ToggleButtonGroup
                size="small"
                exclusive
                value={state.view}
                onChange={(_event, view: AuthzState['view'] | null) => view && setState({ view })}
                sx={{ '& .MuiToggleButton-root': { py: 0.2, px: 1, fontSize: 11.5 } }}
              >
                <ToggleButton value="rules">Rules</ToggleButton>
                <ToggleButton value="json">JSON</ToggleButton>
              </ToggleButtonGroup>
            )}
            {!state.editing ? (
              <Button size="small" disabled={!grpc || rotating || state.policy === undefined} onClick={() => setState({ editing: true, draft: prettyPolicy(state.policy) })}>
                Edit…
              </Button>
            ) : (
              <>
                <Button size="small" color="inherit" onClick={() => setState({ editing: false })}>
                  Cancel
                </Button>
                <Button size="small" variant="contained" disabled={!!draftError} onClick={() => setReviewing(true)}>
                  Review & rotate…
                </Button>
              </>
            )}
          </Stack>
        }
      >
        {state.loading ? (
          <CircularProgress size={20} />
        ) : state.editing ? (
          <Stack spacing={0.75}>
            <CodeEditor value={state.draft} onChange={(draft) => setState({ draft })} language="json" autoHeight={{ min: 12, max: 32 }} ariaLabel="Authorization policy" />
            <Typography variant="caption" color={draftError ? 'error' : 'textSecondary'}>
              {draftError ?? 'A gRPC authorization policy: allow_rules and deny_rules naming principals and RPC paths.'}
            </Typography>
          </Stack>
        ) : state.view === 'json' || !policy ? (
          <CodeEditor value={prettyPolicy(state.policy)} language="json" readOnly autoHeight={{ min: 4, max: 28 }} ariaLabel="Authorization policy" />
        ) : (
          <Box>
            {policy.name && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                <b>{policy.name}</b>
              </Typography>
            )}
            {(policy.deny_rules ?? []).map((rule, index) => (
              <RuleRow key={`deny-${index}`} rule={rule} effect="deny" />
            ))}
            {(policy.allow_rules ?? []).map((rule, index) => (
              <RuleRow key={`allow-${index}`} rule={rule} effect="allow" />
            ))}
            <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 1 }}>
              Deny rules win over allow rules; anything no rule allows is denied.
            </Typography>
          </Box>
        )}
      </Section>
      <ReviewDialog
        open={reviewing}
        title="Rotate the authorization policy"
        description="The new policy takes effect as soon as it is uploaded, but stays provisional until you finalize it. Test it with a probe first; if anything is off, roll back."
        sections={[{ label: 'policy', original: prettyPolicy(state.policy), modified: prettyPolicy(state.draft), language: 'json' }]}
        applyLabel="Upload"
        applyColor="primary"
        onApply={rotate}
        onClose={() => setReviewing(false)}
      />
    </Box>
  );
}
