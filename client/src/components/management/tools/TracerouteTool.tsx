import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import RouteOutlinedIcon from '@mui/icons-material/RouteOutlined';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import { GRPC_METHODS, type GrpcJson, type ManagementError } from '@muxus/shared';
import { useWorkbench } from '../context.js';
import { compactFieldSx } from '../GnmiForm.js';
import { MONO_FONT } from '../PathText.js';
import { activeStream, ErrorAlert, nanosToMs, Section, setActiveStream, shrunkLabel, ToolHeader, useGrpc, useNetworkInstances, useToolState } from './common.js';

interface Hop {
  hop: number;
  address: string;
  name?: string;
  /** Nanoseconds, one per probe. */
  rtts: number[];
  state?: string;
  asPath?: number[];
  mpls?: Record<string, string>;
}

interface TracerouteState {
  destination: string;
  networkInstance: string;
  maxTtl: number;
  l4: 'ICMP' | 'UDP' | 'TCP';
  doNotResolve: boolean;
  running: boolean;
  hops: Hop[];
  header?: { address: string; name?: string; hops: number; packetSize: number };
  error?: ManagementError;
}

const initialTraceroute = (): TracerouteState => ({
  destination: '',
  networkInstance: '',
  maxTtl: 30,
  l4: 'ICMP',
  doNotResolve: true,
  running: false,
  hops: [],
});

export function TracerouteTool() {
  const { store } = useWorkbench();
  const grpc = useGrpc();
  const instances = useNetworkInstances();
  const [state, setState] = useToolState('traceroute', initialTraceroute);

  const start = () => {
    if (!grpc || !state.destination.trim()) return;
    activeStream(store, 'traceroute')?.cancel();
    const request: GrpcJson = {
      destination: state.destination.trim(),
      max_ttl: state.maxTtl,
      l4protocol: state.l4,
      ...(state.networkInstance.trim() ? { network_instance: state.networkInstance.trim() } : {}),
      ...(state.doNotResolve ? { do_not_resolve: true } : {}),
    };
    setState({ running: true, hops: [], header: undefined, error: undefined });
    const stream = grpc.grpcStream(GRPC_METHODS.traceroute, request, {
      messages: (messages) =>
        setState((current) => {
          const hops = [...current.hops];
          let header = current.header;
          for (const message of messages) {
            if (message.hop === undefined) {
              header = {
                address: String((message.destination_address as string | undefined) ?? ''),
                name: (message.destination_name as string | undefined) || undefined,
                hops: Number(message.hops ?? 0),
                packetSize: Number(message.packet_size ?? 0),
              };
              continue;
            }
            const number = Number(message.hop);
            const index = hops.findIndex((hop) => hop.hop === number && hop.address === (message.address ?? ''));
            const rtt = Number(message.rtt ?? 0);
            if (index >= 0) {
              hops[index] = { ...hops[index]!, rtts: [...hops[index]!.rtts, rtt] };
            } else {
              hops.push({
                hop: number,
                address: String((message.address as string | undefined) ?? '*'),
                name: (message.name as string | undefined) || undefined,
                rtts: [rtt],
                state: message.state && message.state !== 'DEFAULT' && message.state !== 'NONE' ? String(message.state as string) : undefined,
                asPath: (message.as_path as number[] | undefined)?.length ? (message.as_path as number[]) : undefined,
                mpls: message.mpls && Object.keys(message.mpls).length ? (message.mpls as Record<string, string>) : undefined,
              });
            }
          }
          hops.sort((a, b) => a.hop - b.hop);
          return { ...current, hops, header };
        }),
      end: (error) => {
        setActiveStream(store, 'traceroute', undefined);
        setState({ running: false, ...(error && !error.cancelled ? { error } : {}) });
      },
    });
    setActiveStream(store, 'traceroute', stream);
  };

  const reached = state.header && state.hops.some((hop) => hop.address === state.header?.address);

  return (
    <Box>
      <ToolHeader
        icon={<RouteOutlinedIcon fontSize="small" />}
        title="Traceroute"
        service="gnoi.system.System"
        description="Trace the path from the device to a destination, hop by hop, with round-trip times, AS paths and MPLS labels where the device reports them."
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
            label="Max hops"
            value={state.maxTtl}
            onChange={(event) => setState({ maxTtl: Math.max(1, Math.min(255, Number(event.target.value.replace(/\D/g, '')) || 30)) })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { inputMode: 'numeric' } }}
            sx={{ width: 90, ...compactFieldSx }}
          />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={state.l4}
            onChange={(_event, l4: TracerouteState['l4'] | null) => l4 && setState({ l4 })}
            sx={{ '& .MuiToggleButton-root': { py: 0.4, px: 1.1, fontSize: 12 } }}
          >
            <ToggleButton value="ICMP">ICMP</ToggleButton>
            <ToggleButton value="UDP">UDP</ToggleButton>
            <ToggleButton value="TCP">TCP</ToggleButton>
          </ToggleButtonGroup>
          <FormControlLabel
            control={<Switch size="small" checked={!state.doNotResolve} onChange={(event) => setState({ doNotResolve: !event.target.checked })} />}
            label={<Typography variant="body2">Resolve names</Typography>}
          />
          <Box sx={{ flex: 1 }} />
          {state.running ? (
            <Button variant="outlined" color="error" startIcon={<StopRoundedIcon />} onClick={() => activeStream(store, 'traceroute')?.cancel()}>
              Stop
            </Button>
          ) : (
            <Button variant="contained" startIcon={<PlayArrowRoundedIcon />} disabled={!grpc || !state.destination.trim()} onClick={start}>
              Trace
            </Button>
          )}
        </Stack>
      </Section>
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      {(state.hops.length > 0 || state.running) && (
        <Section
          title={state.header ? `Route to ${state.header.name ?? state.header.address}` : 'Route'}
          actions={
            state.header ? (
              <Typography variant="caption" color="textSecondary">
                {state.header.address} · {state.header.packetSize} byte packets · up to {state.header.hops} hops
              </Typography>
            ) : undefined
          }
        >
          <Box sx={{ position: 'relative', pl: 3 }}>
            <Box sx={{ position: 'absolute', left: 9, top: 10, bottom: 10, width: 2, bgcolor: 'divider', borderRadius: 1 }} />
            {state.hops.map((hop) => {
              const last = reached && hop.address === state.header?.address;
              return (
                <Stack key={`${hop.hop}-${hop.address}`} direction="row" spacing={1.5} sx={{ alignItems: 'center', py: 0.75, position: 'relative' }}>
                  <Box
                    sx={{
                      position: 'absolute',
                      left: -21,
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      border: 2,
                      borderColor: last ? 'success.main' : hop.address === '*' ? 'text.disabled' : 'primary.main',
                      bgcolor: last ? 'success.main' : 'background.paper',
                    }}
                  />
                  <Typography sx={{ width: 26, fontFamily: MONO_FONT, fontSize: 12, color: 'text.secondary' }}>{hop.hop}</Typography>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontFamily: MONO_FONT, fontSize: 13, fontWeight: 600 }}>
                      {hop.name && hop.name !== hop.address ? `${hop.name} ` : ''}
                      <Box component="span" sx={{ fontWeight: hop.name && hop.name !== hop.address ? 400 : 600, color: hop.name && hop.name !== hop.address ? 'text.secondary' : 'text.primary' }}>
                        {hop.name && hop.name !== hop.address ? `(${hop.address})` : hop.address}
                      </Box>
                    </Typography>
                    {(hop.asPath || hop.mpls || hop.state) && (
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.25 }}>
                        {hop.state && <Chip size="small" color="warning" variant="outlined" label={hop.state.replace(/_/g, ' ').toLowerCase()} sx={{ height: 18, fontSize: 10.5 }} />}
                        {hop.asPath && <Chip size="small" label={`AS ${hop.asPath.join(' ')}`} sx={{ height: 18, fontSize: 10.5 }} />}
                        {hop.mpls &&
                          Object.entries(hop.mpls).map(([key, value]) => (
                            <Chip key={key} size="small" label={`${key} ${value}`} sx={{ height: 18, fontSize: 10.5 }} />
                          ))}
                      </Stack>
                    )}
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    {hop.rtts.map((rtt, index) => (
                      <Chip key={index} size="small" variant="outlined" label={`${nanosToMs(rtt)} ms`} sx={{ height: 20, fontFamily: MONO_FONT, fontSize: 11 }} />
                    ))}
                  </Stack>
                </Stack>
              );
            })}
            {state.running && (
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', py: 0.75 }}>
                <CircularProgress size={12} sx={{ position: 'absolute', left: 3 }} />
                <Typography variant="body2" color="textSecondary">
                  Probing the next hop …
                </Typography>
              </Stack>
            )}
          </Box>
        </Section>
      )}
    </Box>
  );
}
