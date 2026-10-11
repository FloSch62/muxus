import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { formatGnmiPath, GRPC_METHODS, tryParseGnmiPath, type ManagementError } from '@muxus/shared';
import { confirmAction } from '../../../state/dialogs.js';
import { showToast } from '../../../state/toast.js';
import { defaultGnmiDraft } from '../../../management/requests.js';
import { useWorkbench } from '../context.js';
import { compactFieldSx } from '../GnmiForm.js';
import { MONO_FONT, PathText } from '../PathText.js';
import { deviceTime, ErrorAlert, errorOf, gnoiPath, Section, shrunkLabel, Stat, ToolHeader, TypedConfirmDialog, useGrpc, useNetworkInstances, useToolState } from './common.js';

// Health

interface Component {
  path?: { origin?: string; elem?: Array<{ name: string; key?: Record<string, string> }> };
  status?: string;
  id?: string;
  acknowledged?: boolean;
  created?: { seconds?: number | string; nanos?: number };
  expires?: { seconds?: number | string; nanos?: number };
  artifacts?: Array<{ id?: string; file?: { name?: string; size?: number; mimetype?: string } }>;
  subcomponents?: Component[];
}

function componentPathText(path: Component['path']): string {
  if (!path) return '/';
  return formatGnmiPath({
    ...(path.origin ? { origin: path.origin } : {}),
    elems: (path.elem ?? []).map((elem) => ({ name: elem.name, ...(elem.key ? { keys: elem.key } : {}) })),
  });
}

function timestamp(value: Component['created']): string {
  if (!value?.seconds || value.seconds === '0') return '—';
  return new Date(Number(value.seconds) * 1000).toLocaleString();
}

function HealthCard({ component, onAcknowledge }: { component: Component; onAcknowledge: (component: Component) => void }) {
  const healthy = component.status === 'STATUS_HEALTHY';
  const unhealthy = component.status === 'STATUS_UNHEALTHY';
  return (
    <Box sx={{ border: 1, borderColor: unhealthy ? 'error.main' : 'divider', borderRadius: 1.5, p: 1.5, mb: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        {healthy ? (
          <CheckCircleRoundedIcon sx={{ color: 'success.main', fontSize: 20 }} />
        ) : unhealthy ? (
          <ErrorRoundedIcon sx={{ color: 'error.main', fontSize: 20 }} />
        ) : (
          <HealthAndSafetyOutlinedIcon sx={{ color: 'text.disabled', fontSize: 20 }} />
        )}
        <Box sx={{ flex: 1, minWidth: 0, fontSize: 13 }}>
          <PathText path={componentPathText(component.path)} />
        </Box>
        <Chip
          size="small"
          color={healthy ? 'success' : unhealthy ? 'error' : 'default'}
          label={healthy ? 'Healthy' : unhealthy ? 'Unhealthy' : 'Unknown'}
          sx={{ height: 22 }}
        />
        {component.acknowledged && <Chip size="small" variant="outlined" label="Acknowledged" sx={{ height: 22 }} />}
        {unhealthy && !component.acknowledged && component.id && (
          <Button size="small" onClick={() => onAcknowledge(component)}>
            Acknowledge
          </Button>
        )}
      </Stack>
      <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap', mt: 1, pl: 3.5 }}>
        <Typography variant="caption" color="textSecondary">
          Since {timestamp(component.created)}
        </Typography>
        {component.expires?.seconds && component.expires.seconds !== '0' && (
          <Typography variant="caption" color="textSecondary">
            Expires {timestamp(component.expires)}
          </Typography>
        )}
        {component.id && (
          <Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO_FONT }}>
            event {component.id}
          </Typography>
        )}
      </Stack>
      {component.artifacts?.length ? (
        <Stack spacing={0.25} sx={{ mt: 1, pl: 3.5 }}>
          {component.artifacts.map((artifact) => (
            <Typography key={artifact.id} variant="caption" sx={{ fontFamily: MONO_FONT }}>
              artifact {artifact.file?.name ?? artifact.id}
              {artifact.file?.size ? ` · ${artifact.file.size} bytes` : ''}
            </Typography>
          ))}
        </Stack>
      ) : null}
      {component.subcomponents?.length ? (
        <Box sx={{ mt: 1, pl: 3.5 }}>
          {component.subcomponents.map((child, index) => (
            <HealthCard key={index} component={child} onAcknowledge={onAcknowledge} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

interface HealthState {
  path: string;
  includeAcknowledged: boolean;
  loading: boolean;
  components?: Component[];
  error?: ManagementError;
}

export function HealthTool() {
  const { controller } = useWorkbench();
  const grpc = useGrpc();
  const [state, setState] = useToolState<HealthState>('health', () => ({ path: '', includeAcknowledged: false, loading: false }));
  const models = controller.gnmiInfo?.models.map((model) => model.name) ?? [];
  const suggestions = models.some((model) => model.includes('srl_nokia'))
    ? ['/platform/control[slot=A]', '/platform/chassis', '/platform/linecard[slot=1]', '/platform/fan-tray[id=1]', '/platform/power-supply[id=1]']
    : ['/components/component[name=chassis]', '/components/component[name=Supervisor1]'];

  const run = async (mode: 'get' | 'list') => {
    if (!grpc) return;
    const parsed = tryParseGnmiPath(state.path.trim() || suggestions[0]!);
    if (!parsed) {
      setState({ error: { message: 'The component path does not parse.' } });
      return;
    }
    setState({ loading: true, error: undefined });
    try {
      const path = gnoiPath(parsed.elems, parsed.origin);
      if (mode === 'get') {
        const response = await grpc.grpcCall<{ component?: Component }>(GRPC_METHODS.healthzGet, { path });
        setState({ loading: false, components: response.component ? [response.component] : [] });
      } else {
        const response = await grpc.grpcCall<{ statuses?: Component[] }>(GRPC_METHODS.healthzList, {
          path,
          include_acknowledged: state.includeAcknowledged,
        });
        setState({ loading: false, components: response.statuses ?? [] });
      }
    } catch (err) {
      setState({ loading: false, error: errorOf(err) });
    }
  };

  const acknowledge = async (component: Component) => {
    if (!grpc || !component.path || !component.id) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.healthzAcknowledge, { path: component.path, id: component.id });
      showToast('success', 'Acknowledged.');
      void run('list');
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  return (
    <Box>
      <ToolHeader
        icon={<HealthAndSafetyOutlinedIcon fontSize="small" />}
        title="Health"
        service="gnoi.healthz.Healthz"
        description="The health the device reports for a component: its current status, past unhealthy events with their debug artifacts, and acknowledging them."
      />
      <Section title="Component">
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Autocomplete
            freeSolo
            size="small"
            options={suggestions}
            value={state.path}
            onInputChange={(_event, path) => setState({ path })}
            renderInput={(params) => (
              <TextField {...shrunkLabel(params)} label="Component path" placeholder={suggestions[0]} />
            )}
            sx={{ flex: '1 1 320px', ...compactFieldSx, '& input': { fontFamily: MONO_FONT } }}
          />
          <FormControlLabel
            control={<Switch size="small" checked={state.includeAcknowledged} onChange={(event) => setState({ includeAcknowledged: event.target.checked })} />}
            label={<Typography variant="body2">Include acknowledged</Typography>}
          />
          <Button variant="outlined" disabled={!grpc || state.loading} onClick={() => void run('list')}>
            Events
          </Button>
          <Button variant="contained" disabled={!grpc || state.loading} onClick={() => void run('get')}>
            Get health
          </Button>
        </Stack>
      </Section>
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      {state.loading && <CircularProgress size={22} />}
      {state.components && !state.loading && (
        <Section title={state.components.length === 1 ? 'Status' : `${state.components.length} events`}>
          {state.components.length === 0 ? (
            <Typography variant="body2" color="textSecondary">
              No health events for this component.
            </Typography>
          ) : (
            state.components.map((component, index) => (
              <HealthCard key={index} component={component} onAcknowledge={(item) => void acknowledge(item)} />
            ))
          )}
        </Section>
      )}
    </Box>
  );
}

// Reboot

const REBOOT_METHODS: Array<{ value: string; label: string; detail: string }> = [
  { value: 'COLD', label: 'Cold', detail: 'Restart the whole system' },
  { value: 'WARM', label: 'Warm', detail: 'Restart the software, keep forwarding where supported' },
  { value: 'NSF', label: 'Non-stop forwarding', detail: 'Restart without interrupting traffic' },
  { value: 'POWERDOWN', label: 'Power down', detail: 'Turn the system off' },
  { value: 'HALT', label: 'Halt', detail: 'Stop the system without powering off' },
  { value: 'POWERUP', label: 'Power up', detail: 'Power up a component' },
];

interface RebootStatusJson {
  active?: boolean;
  wait?: number | string;
  when?: number | string;
  reason?: string;
  count?: number;
  method?: string;
  status?: { status?: string; message?: string };
}

interface RebootState {
  method: string;
  delaySeconds: number;
  message: string;
  force: boolean;
  status?: RebootStatusJson;
  error?: ManagementError;
  checkedAt?: number;
}

export function RebootTool() {
  const { title } = useWorkbench();
  const grpc = useGrpc();
  const [state, setState] = useToolState<RebootState>('reboot', () => ({ method: 'COLD', delaySeconds: 0, message: 'Requested from Muxus', force: false }));
  const [confirming, setConfirming] = useState(false);

  const refresh = async () => {
    if (!grpc) return;
    try {
      const status = await grpc.grpcCall<RebootStatusJson>(GRPC_METHODS.rebootStatus, {});
      setState({ status, checkedAt: Date.now() });
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  useEffect(() => {
    void refresh();
    // While a reboot is scheduled, keep the countdown current.
    if (!state.status?.active) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grpc, state.status?.active]);

  const reboot = async () => {
    setConfirming(false);
    if (!grpc) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.reboot, {
        method: state.method,
        ...(state.delaySeconds ? { delay: String(BigInt(state.delaySeconds) * 1_000_000_000n) } : {}),
        ...(state.message.trim() ? { message: state.message.trim() } : {}),
        ...(state.force ? { force: true } : {}),
      });
      showToast('success', state.delaySeconds ? `Reboot scheduled in ${state.delaySeconds} s.` : 'Reboot requested.');
      void refresh();
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  const cancel = async () => {
    if (!grpc) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.cancelReboot, { message: 'Cancelled from Muxus' });
      showToast('success', 'The reboot was cancelled.');
      void refresh();
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  const status = state.status;
  const waitSeconds = status?.wait ? Math.round(Number(status.wait) / 1e9) : 0;

  return (
    <Box>
      <ToolHeader
        icon={<RestartAltIcon fontSize="small" />}
        title="Reboot"
        service="gnoi.system.System"
        description="See whether a reboot is pending, schedule one with a delay, or cancel it before it happens."
        actions={
          <Button size="small" onClick={() => void refresh()} disabled={!grpc}>
            Refresh
          </Button>
        }
      />
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      <Section title="Status">
        {status?.active ? (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={() => void cancel()}>
                Cancel reboot
              </Button>
            }
          >
            A {String(status.method ?? '').toLowerCase()} reboot is pending
            {waitSeconds ? `, in ${waitSeconds} s` : ''}
            {status.reason ? `: ${status.reason}` : '.'}
          </Alert>
        ) : (
          <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Stat label="Pending" value="No" tone="success" />
            <Stat label="Reboots" value={status?.count ?? 0} />
            {status?.status?.status && status.status.status !== 'STATUS_UNKNOWN' && (
              <Stat label="Last result" value={status.status.status.replace('STATUS_', '').toLowerCase()} />
            )}
            {status?.when && status.when !== '0' && <Stat label="Last at" value={deviceTime(status.when)} />}
          </Stack>
        )}
      </Section>
      <Section title="Reboot the device">
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <TextField
              select
              size="small"
              label="Method"
              value={state.method}
              onChange={(event) => setState({ method: event.target.value })}
              slotProps={{
                inputLabel: { shrink: true },
                select: { renderValue: (value) => REBOOT_METHODS.find((method) => method.value === value)?.label ?? String(value) },
              }}
              sx={{ width: 200, ...compactFieldSx }}
            >
              {REBOOT_METHODS.map((method) => (
                <MenuItem key={method.value} value={method.value}>
                  <Stack>
                    <span>{method.label}</span>
                    <Typography variant="caption" color="textSecondary">
                      {method.detail}
                    </Typography>
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="Delay"
              value={state.delaySeconds}
              onChange={(event) => setState({ delaySeconds: Math.max(0, Number(event.target.value.replace(/\D/g, '')) || 0) })}
              slotProps={{ inputLabel: { shrink: true }, input: { endAdornment: <InputAdornment position="end">s</InputAdornment> } }}
              sx={{ width: 110, ...compactFieldSx }}
            />
            <TextField
              size="small"
              label="Message"
              value={state.message}
              onChange={(event) => setState({ message: event.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: '1 1 200px', ...compactFieldSx }}
            />
            <FormControlLabel
              control={<Switch size="small" checked={state.force} onChange={(event) => setState({ force: event.target.checked })} />}
              label={<Typography variant="body2">Force</Typography>}
            />
          </Stack>
          <Box>
            <Button variant="contained" color="error" startIcon={<RestartAltIcon />} disabled={!grpc || status?.active} onClick={() => setConfirming(true)}>
              Reboot…
            </Button>
          </Box>
        </Stack>
      </Section>
      <TypedConfirmDialog
        open={confirming}
        title={`Reboot ${title}?`}
        description={
          state.delaySeconds
            ? `The device reboots (${state.method.toLowerCase()}) in ${state.delaySeconds} seconds. You can cancel it until then.`
            : `The device reboots (${state.method.toLowerCase()}) right away. Every session to it drops, this one included.`
        }
        expected={title}
        confirmLabel="Reboot"
        onConfirm={() => void reboot()}
        onClose={() => setConfirming(false)}
      />
    </Box>
  );
}

// Processes

interface ProcessState {
  name: string;
  pid: string;
  signal: string;
  restart: boolean;
  error?: ManagementError;
  applications?: string[];
}

export function ProcessTool() {
  const { controller, title } = useWorkbench();
  const grpc = useGrpc();
  const [state, setState] = useToolState<ProcessState>('process', () => ({ name: '', pid: '', signal: 'SIGNAL_TERM', restart: true }));

  useEffect(() => {
    if (!grpc || state.applications) return;
    // SR Linux names its processes as applications; offer them.
    void controller
      .request({ ...defaultGnmiDraft(), paths: ['/system/app-management/application[name=*]/name'], dataType: 'state' })
      .then((result) => {
        if (result.op !== 'gnmi-get') return;
        const names = new Set<string>();
        for (const notification of result.notifications) {
          for (const update of notification.updates) {
            const match = /application\[name=([^\]]+)\]/.exec(update.path);
            if (match) names.add(match[1]!);
            JSON.stringify(update.value.value).replace(/"name":"([^"]+)"/g, (_all, name: string) => {
              names.add(name);
              return '';
            });
          }
        }
        setState({ applications: [...names].sort() });
      })
      .catch(() => setState({ applications: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grpc]);

  const send = async () => {
    if (!grpc || (!state.name.trim() && !state.pid.trim())) return;
    const target = state.name.trim() || `PID ${state.pid}`;
    const confirmed = await confirmAction({
      title: `${state.restart ? 'Restart' : 'Stop'} ${target}?`,
      description: `${state.signal.replace('SIGNAL_', '')} goes to ${target} on ${title}${state.restart ? ', and the device starts it again' : ''}.`,
      confirmLabel: state.restart ? 'Restart' : 'Send signal',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.killProcess, {
        ...(state.name.trim() ? { name: state.name.trim() } : {}),
        ...(state.pid.trim() ? { pid: Number(state.pid) } : {}),
        signal: state.signal,
        restart: state.restart,
      });
      showToast('success', `${state.restart ? 'Restarted' : 'Signalled'} ${target}.`);
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  return (
    <Box>
      <ToolHeader
        icon={<MemoryOutlinedIcon fontSize="small" />}
        title="Processes"
        service="gnoi.system.System"
        description="Restart a misbehaving daemon, or send it a signal, without logging in to a shell."
      />
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      <Section title="Process">
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Autocomplete
            freeSolo
            size="small"
            options={state.applications ?? []}
            value={state.name}
            onInputChange={(_event, name) => setState({ name })}
            renderInput={(params) => <TextField {...shrunkLabel(params)} label="Name" placeholder="bgp_mgr" />}
            sx={{ flex: '1 1 220px', ...compactFieldSx }}
          />
          <TextField
            size="small"
            label="PID"
            placeholder="optional"
            value={state.pid}
            onChange={(event) => setState({ pid: event.target.value.replace(/\D/g, '') })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ width: 100, ...compactFieldSx }}
          />
          <TextField
            select
            size="small"
            label="Signal"
            value={state.signal}
            onChange={(event) => setState({ signal: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ width: 120, ...compactFieldSx }}
          >
            {['SIGNAL_TERM', 'SIGNAL_KILL', 'SIGNAL_HUP', 'SIGNAL_ABRT'].map((signal) => (
              <MenuItem key={signal} value={signal}>
                {signal.replace('SIGNAL_', '')}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={<Switch size="small" checked={state.restart} onChange={(event) => setState({ restart: event.target.checked })} />}
            label={<Typography variant="body2">Restart it</Typography>}
          />
          <Box sx={{ flex: 1 }} />
          <Button variant="contained" color="warning" disabled={!grpc || (!state.name.trim() && !state.pid.trim())} onClick={() => void send()}>
            {state.restart ? 'Restart…' : 'Send…'}
          </Button>
        </Stack>
      </Section>
    </Box>
  );
}

// BGP

interface BgpState {
  address: string;
  instance: string;
  mode: string;
  error?: ManagementError;
}

export function BgpTool() {
  const grpc = useGrpc();
  const instances = useNetworkInstances();
  const [state, setState] = useToolState<BgpState>('bgp', () => ({ address: '', instance: '', mode: 'SOFT' }));
  const modes = [
    { value: 'SOFT', label: 'Soft', detail: 'Re-send routes to the neighbor' },
    { value: 'SOFTIN', label: 'Soft in', detail: 'Ask the neighbor to re-send its routes' },
    { value: 'GRACEFUL_RESET', label: 'Graceful reset', detail: 'Reset with graceful restart' },
    { value: 'HARD_RESET', label: 'Hard reset', detail: 'Tear the session down' },
  ];
  const clear = async () => {
    if (!grpc || !state.address.trim()) return;
    const mode = modes.find((candidate) => candidate.value === state.mode)!;
    const confirmed = await confirmAction({
      title: `Clear BGP neighbor ${state.address.trim()}?`,
      description: `${mode.label}: ${mode.detail.toLowerCase()}.`,
      confirmLabel: 'Clear',
      destructive: state.mode === 'HARD_RESET',
    });
    if (!confirmed) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.bgpClear, {
        address: state.address.trim(),
        mode: state.mode,
        ...(state.instance.trim() ? { routing_instance: state.instance.trim() } : {}),
      });
      showToast('success', `Cleared ${state.address.trim()}.`);
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };
  return (
    <Box>
      <ToolHeader
        icon={<HubOutlinedIcon fontSize="small" />}
        title="BGP"
        service="gnoi.bgp.BGP"
        description="Clear a BGP session: soft to exchange routes again, or a reset to bring it down and up."
      />
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      <Section title="Neighbor">
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            label="Neighbor address"
            placeholder="192.0.2.1"
            value={state.address}
            onChange={(event) => setState({ address: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: '1 1 200px', ...compactFieldSx, '& input': { fontFamily: MONO_FONT } }}
          />
          <Autocomplete
            freeSolo
            size="small"
            options={instances}
            value={state.instance}
            onInputChange={(_event, instance) => setState({ instance })}
            renderInput={(params) => <TextField {...shrunkLabel(params)} label="Network instance" placeholder="default" />}
            sx={{ width: 190, ...compactFieldSx }}
          />
          <TextField
            select
            size="small"
            label="Mode"
            value={state.mode}
            onChange={(event) => setState({ mode: event.target.value })}
            slotProps={{ inputLabel: { shrink: true }, select: { renderValue: (value) => modes.find((mode) => mode.value === value)?.label ?? String(value) } }}
            sx={{ width: 170, ...compactFieldSx }}
          >
            {modes.map((mode) => (
              <MenuItem key={mode.value} value={mode.value}>
                <Stack>
                  <span>{mode.label}</span>
                  <Typography variant="caption" color="textSecondary">
                    {mode.detail}
                  </Typography>
                </Stack>
              </MenuItem>
            ))}
          </TextField>
          <Box sx={{ flex: 1 }} />
          <Button variant="contained" disabled={!grpc || !state.address.trim()} onClick={() => void clear()}>
            Clear…
          </Button>
        </Stack>
      </Section>
    </Box>
  );
}

// System: clock and OS

interface SystemState {
  deviceTime?: string;
  localAt?: number;
  roundTripMs?: number;
  version?: string;
  osError?: ManagementError;
  error?: ManagementError;
}

export function SystemTool() {
  const grpc = useGrpc();
  const [state, setState] = useToolState<SystemState>('system', () => ({}));
  const refresh = async () => {
    if (!grpc) return;
    const started = performance.now();
    try {
      const time = await grpc.grpcCall<{ time?: number | string }>(GRPC_METHODS.time, {});
      setState({ deviceTime: String(time.time ?? '0'), localAt: Date.now(), roundTripMs: Math.round(performance.now() - started), error: undefined });
    } catch (err) {
      setState({ error: errorOf(err) });
    }
    try {
      const os = await grpc.grpcCall<{ version?: string; activation_fail_message?: string }>(GRPC_METHODS.osVerify, {});
      setState({ version: os.version ?? '', osError: os.activation_fail_message ? { message: os.activation_fail_message } : undefined });
    } catch (err) {
      setState({ version: undefined, osError: errorOf(err) });
    }
  };
  useEffect(() => {
    if (grpc && !state.localAt) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grpc]);
  // Device time minus local time, corrected for half the round trip.
  const skewMs =
    state.deviceTime && state.localAt && state.roundTripMs !== undefined
      ? Number(BigInt(state.deviceTime) / 1_000_000n) - (state.localAt - state.roundTripMs / 2)
      : undefined;
  return (
    <Box>
      <ToolHeader
        icon={<AccessTimeIcon fontSize="small" />}
        title="System"
        service="gnoi.system.System · gnoi.os.OS"
        description="The device's clock compared with this computer's, and the software version it runs."
        actions={
          <Button size="small" onClick={() => void refresh()} disabled={!grpc}>
            Refresh
          </Button>
        }
      />
      <ErrorAlert error={state.error} />
      <Section title="Clock">
        <Stack direction="row" spacing={4} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Stat label="Device time" value={state.deviceTime ? deviceTime(state.deviceTime) : '—'} />
          <Stat
            label="Offset"
            value={skewMs === undefined ? '—' : `${skewMs > 0 ? '+' : ''}${(skewMs / 1000).toFixed(Math.abs(skewMs) < 10_000 ? 2 : 0)} s`}
            tone={skewMs === undefined ? undefined : Math.abs(skewMs) < 1000 ? 'success' : Math.abs(skewMs) < 60_000 ? 'warning' : 'error'}
          />
          <Stat label="Round trip" value={state.roundTripMs !== undefined ? `${state.roundTripMs} ms` : '—'} />
        </Stack>
      </Section>
      <Section title="Software">
        {state.version ? (
          <Stat label="Version" value={state.version} />
        ) : (
          <Typography variant="body2" color="textSecondary">
            {state.osError?.code === 'UNIMPLEMENTED'
              ? 'The device does not report its version over gNOI OS.'
              : (state.osError?.message ?? 'Not read yet.')}
          </Typography>
        )}
      </Section>
    </Box>
  );
}
