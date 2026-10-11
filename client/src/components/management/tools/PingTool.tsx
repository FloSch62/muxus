import { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import NetworkPingIcon from '@mui/icons-material/NetworkPing';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import { GRPC_METHODS, type GrpcJson, type ManagementError } from '@muxus/shared';
import { useWorkbench } from '../context.js';
import { compactFieldSx } from '../GnmiForm.js';
import { MONO_FONT } from '../PathText.js';
import { activeStream, ErrorAlert, nanosToMs, Section, setActiveStream, shrunkLabel, Stat, ToolHeader, useGrpc, useNetworkInstances, useToolState } from './common.js';

interface PingReply {
  sequence: number;
  source: string;
  bytes: number;
  ttl: number;
  /** Nanoseconds. */
  time: number;
}

interface PingSummary {
  sent: number;
  received: number;
  min: number;
  avg: number;
  max: number;
  stdDev: number;
}

interface PingState {
  destination: string;
  networkInstance: string;
  count: number;
  intervalMs: number;
  size: number;
  source: string;
  l3: 'auto' | 'IPV4' | 'IPV6';
  doNotFragment: boolean;
  doNotResolve: boolean;
  running: boolean;
  replies: PingReply[];
  summary?: PingSummary;
  error?: ManagementError;
  target?: string;
}

const initialPing = (): PingState => ({
  destination: '',
  networkInstance: '',
  count: 5,
  intervalMs: 1000,
  size: 56,
  source: '',
  l3: 'auto',
  doNotFragment: false,
  doNotResolve: false,
  running: false,
  replies: [],
});

function num(value: unknown): number {
  return Number(value ?? 0);
}

/** One bar per reply, scaled to the slowest. */
function RttChart({ replies, expected }: { replies: PingReply[]; expected: number }) {
  const theme = useTheme();
  const slots = Math.max(expected, replies.length);
  const max = Math.max(1, ...replies.map((reply) => reply.time));
  const width = 100 / Math.max(1, slots);
  return (
    <Box sx={{ height: 72, display: 'flex', alignItems: 'flex-end', gap: '2px', mb: 1.5 }} aria-hidden>
      {Array.from({ length: slots }, (_, index) => {
        const reply = replies.find((candidate) => candidate.sequence === index + 1) ?? replies[index];
        const height = reply ? Math.max(4, (reply.time / max) * 68) : 2;
        return (
          <Tooltip key={index} title={reply ? `seq ${reply.sequence}: ${nanosToMs(reply.time)} ms` : 'waiting'}>
            <Box
              sx={{
                width: `${width}%`,
                maxWidth: 28,
                height,
                borderRadius: '3px 3px 0 0',
                bgcolor: reply ? theme.palette.primary.main : theme.palette.action.selected,
                opacity: reply ? 0.85 : 1,
                transition: 'height 200ms ease',
              }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}

export function PingTool() {
  const { store } = useWorkbench();
  const grpc = useGrpc();
  const instances = useNetworkInstances();
  const [state, setState] = useToolState('ping', initialPing);
  const [more, setMore] = useState(false);

  const start = () => {
    if (!grpc || !state.destination.trim()) return;
    activeStream(store, 'ping')?.cancel();
    const request: GrpcJson = {
      destination: state.destination.trim(),
      count: state.count,
      interval: String(Math.round(state.intervalMs * 1e6)),
      size: state.size,
      ...(state.networkInstance.trim() ? { network_instance: state.networkInstance.trim() } : {}),
      ...(state.source.trim() ? { source: state.source.trim() } : {}),
      ...(state.l3 !== 'auto' ? { l3protocol: state.l3 } : {}),
      ...(state.doNotFragment ? { do_not_fragment: true } : {}),
      ...(state.doNotResolve ? { do_not_resolve: true } : {}),
    };
    setState({ running: true, replies: [], summary: undefined, error: undefined, target: state.destination.trim() });
    const stream = grpc.grpcStream(GRPC_METHODS.ping, request, {
      messages: (messages) =>
        setState((current) => {
          const replies = [...current.replies];
          let summary = current.summary;
          for (const message of messages) {
            if (message.sent !== undefined || message.received !== undefined) {
              summary = {
                sent: num(message.sent),
                received: num(message.received),
                min: num(message.min_time),
                avg: num(message.avg_time),
                max: num(message.max_time),
                stdDev: num(message.std_dev),
              };
            } else {
              replies.push({
                sequence: num(message.sequence),
                source: String((message.source as string | undefined) ?? ''),
                bytes: num(message.bytes),
                ttl: num(message.ttl),
                time: num(message.time),
              });
            }
          }
          return { ...current, replies, summary };
        }),
      end: (error) => {
        setActiveStream(store, 'ping', undefined);
        setState({ running: false, ...(error && !error.cancelled ? { error } : {}) });
      },
    });
    setActiveStream(store, 'ping', stream);
  };

  const stop = () => activeStream(store, 'ping')?.cancel();
  const received = state.summary?.received ?? state.replies.length;
  const sent = state.summary?.sent ?? Math.max(state.replies.length, state.running ? state.replies.length : 0);
  const loss = state.summary && state.summary.sent ? (1 - state.summary.received / state.summary.sent) * 100 : undefined;
  const times = state.replies.map((reply) => reply.time);

  return (
    <Box>
      <ToolHeader
        icon={<NetworkPingIcon fontSize="small" />}
        title="Ping"
        service="gnoi.system.System"
        description="Ping from the device itself, in any of its network instances. Replies stream in as they arrive."
      />
      <Section title="Target">
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            label="Destination"
            placeholder="10.0.0.2 or host name"
            value={state.destination}
            onChange={(event) => setState({ destination: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') start();
            }}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { spellCheck: false } }}
            sx={{ flex: '1 1 220px', ...compactFieldSx, '& input': { fontFamily: MONO_FONT } }}
          />
          <Autocomplete
            freeSolo
            size="small"
            options={instances}
            value={state.networkInstance}
            onInputChange={(_event, value) => setState({ networkInstance: value })}
            renderInput={(params) => (
              <TextField {...shrunkLabel(params)} label="Network instance" placeholder="default" />
            )}
            sx={{ width: 190, ...compactFieldSx }}
          />
          <TextField
            size="small"
            label="Count"
            value={state.count}
            onChange={(event) => setState({ count: Math.max(1, Math.min(1000, Number(event.target.value.replace(/\D/g, '')) || 1)) })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { inputMode: 'numeric' } }}
            sx={{ width: 76, ...compactFieldSx }}
          />
          <TextField
            size="small"
            label="Interval"
            value={state.intervalMs}
            onChange={(event) => setState({ intervalMs: Math.max(10, Number(event.target.value.replace(/\D/g, '')) || 1000) })}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { inputMode: 'numeric' },
              input: { endAdornment: <InputAdornment position="end">ms</InputAdornment> },
            }}
            sx={{ width: 110, ...compactFieldSx }}
          />
          <Button size="small" color="inherit" onClick={() => setMore((open) => !open)} endIcon={<ExpandMoreIcon sx={{ transform: more ? 'rotate(180deg)' : 'none' }} />} sx={{ color: 'text.secondary' }}>
            More
          </Button>
          <Box sx={{ flex: 1 }} />
          {state.running ? (
            <Button variant="outlined" color="error" startIcon={<StopRoundedIcon />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="contained" startIcon={<PlayArrowRoundedIcon />} disabled={!grpc || !state.destination.trim()} onClick={start}>
              Ping
            </Button>
          )}
        </Stack>
        <Collapse in={more} unmountOnExit>
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', pt: 1.5 }}>
            <TextField
              size="small"
              label="Size"
              value={state.size}
              onChange={(event) => setState({ size: Math.max(0, Math.min(65_000, Number(event.target.value.replace(/\D/g, '')) || 0)) })}
              slotProps={{ inputLabel: { shrink: true }, input: { endAdornment: <InputAdornment position="end">bytes</InputAdornment> } }}
              sx={{ width: 130, ...compactFieldSx }}
            />
            <TextField
              size="small"
              label="Source"
              placeholder="any"
              value={state.source}
              onChange={(event) => setState({ source: event.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 170, ...compactFieldSx }}
            />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={state.l3}
              onChange={(_event, l3: PingState['l3'] | null) => l3 && setState({ l3 })}
              sx={{ '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12 } }}
            >
              <ToggleButton value="auto">Auto</ToggleButton>
              <ToggleButton value="IPV4">IPv4</ToggleButton>
              <ToggleButton value="IPV6">IPv6</ToggleButton>
            </ToggleButtonGroup>
            <FormControlLabel
              control={<Switch size="small" checked={state.doNotFragment} onChange={(event) => setState({ doNotFragment: event.target.checked })} />}
              label={<Typography variant="body2">Don’t fragment</Typography>}
            />
            <FormControlLabel
              control={<Switch size="small" checked={state.doNotResolve} onChange={(event) => setState({ doNotResolve: event.target.checked })} />}
              label={<Typography variant="body2">Don’t resolve names</Typography>}
            />
          </Stack>
        </Collapse>
      </Section>
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      {(state.replies.length > 0 || state.running || state.summary) && (
        <Section title={state.target ? `Ping ${state.target}` : 'Ping'}>
          {state.running && <LinearProgress variant="determinate" value={(state.replies.length / Math.max(1, state.count)) * 100} sx={{ mb: 1.5, borderRadius: 1 }} />}
          <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }}>
            <Stat label="Sent" value={sent} />
            <Stat label="Received" value={received} tone={received ? 'success' : undefined} />
            <Stat
              label="Loss"
              value={loss !== undefined ? `${loss.toFixed(loss % 1 ? 1 : 0)}%` : '—'}
              tone={loss === undefined ? undefined : loss === 0 ? 'success' : loss < 100 ? 'warning' : 'error'}
            />
            <Stat label="Min" value={times.length ? `${nanosToMs(state.summary?.min || Math.min(...times))} ms` : '—'} />
            <Stat label="Avg" value={times.length ? `${nanosToMs(state.summary?.avg || times.reduce((a, b) => a + b, 0) / times.length)} ms` : '—'} />
            <Stat label="Max" value={times.length ? `${nanosToMs(state.summary?.max || Math.max(...times))} ms` : '—'} />
            {state.summary && <Stat label="Std dev" value={`${nanosToMs(state.summary.stdDev)} ms`} />}
          </Stack>
          <RttChart replies={state.replies} expected={state.count} />
          <Box sx={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: 1.7, maxHeight: 240, overflow: 'auto' }}>
            {state.replies.map((reply, index) => (
              <div key={index}>
                {reply.bytes} bytes from <b>{reply.source}</b>: seq={reply.sequence} ttl={reply.ttl} time=
                <Box component="span" sx={{ color: 'info.main' }}>
                  {nanosToMs(reply.time)} ms
                </Box>
              </div>
            ))}
          </Box>
        </Section>
      )}
    </Box>
  );
}
