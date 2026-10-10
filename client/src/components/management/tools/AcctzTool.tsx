import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha, useTheme } from '@mui/material/styles';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import SearchIcon from '@mui/icons-material/Search';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import { GRPC_METHODS, type GrpcJson, type ManagementError } from '@muxus/shared';
import { accountingRecord, type AccountingRecord } from '../../../management/tool-format.js';
import { exportFilename, saveTextFile } from '../../../save-file.js';
import { useWorkbench } from '../context.js';
import { MONO_FONT } from '../PathText.js';
import { activeStream, ErrorAlert, Section, setActiveStream, ToolHeader, useGrpc, useToolState } from './common.js';

interface AcctzState {
  since: 'live' | '15m' | '1h' | '24h';
  running: boolean;
  records: AccountingRecord[];
  filter: string;
  error?: ManagementError;
}

const MAX_RECORDS = 5000;
const SINCE_SECONDS = { live: 0, '15m': 900, '1h': 3600, '24h': 86_400 } as const;

export function AcctzTool() {
  const { store, controller } = useWorkbench();
  const theme = useTheme();
  const grpc = useGrpc();
  const [state, setState] = useToolState<AcctzState>('acctz', () => ({ since: '1h', running: false, records: [], filter: '' }));
  const [now, setNow] = useState(() => Date.now());

  const start = () => {
    if (!grpc) return;
    activeStream(store, 'acctz')?.cancel();
    const sinceSeconds = Math.floor(Date.now() / 1000) - SINCE_SECONDS[state.since];
    const request: GrpcJson = { timestamp: { seconds: sinceSeconds } };
    // The server-streaming variant is simpler; older devices only have the bidirectional one.
    const method = controller.hasService('gnsi.acctz.v1.AcctzStream') ? GRPC_METHODS.acctzStream : GRPC_METHODS.acctzBidi;
    setState({ running: true, error: undefined, records: [] });
    const stream = grpc.grpcStream(method, request, {
      messages: (messages) => {
        setNow(Date.now());
        setState((current) => ({
          ...current,
          records: [...messages.map(accountingRecord).reverse(), ...current.records].slice(0, MAX_RECORDS),
        }));
      },
      end: (error) => {
        setActiveStream(store, 'acctz', undefined);
        setState({ running: false, ...(error && !error.cancelled ? { error } : {}) });
      },
    });
    setActiveStream(store, 'acctz', stream);
  };

  const records = useMemo(() => {
    const needle = state.filter.trim().toLowerCase();
    return needle
      ? state.records.filter((record) => `${record.user} ${record.service} ${record.action} ${record.remote ?? ''}`.toLowerCase().includes(needle))
      : state.records;
  }, [state.records, state.filter]);

  const exportCsv = () => {
    const lines = ['time,user,role,service,action,authorization,remote,session'];
    for (const record of records) {
      const cells = [new Date(record.at).toISOString(), record.user, record.role ?? '', record.service, record.action, record.authz ?? '', record.remote ?? '', record.session ?? ''];
      lines.push(cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','));
    }
    saveTextFile(exportFilename('accounting', 'csv'), lines.join('\n'), 'text/csv');
  };

  return (
    <Box>
      <ToolHeader
        icon={<ReceiptLongOutlinedIcon fontSize="small" />}
        title="Accounting"
        service="gnsi.acctz.v1"
        description="Who did what on the device: every CLI command and gRPC call, with the user, where they came from and whether it was allowed, as it happens."
      />
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      <Section
        title={state.running ? 'Live' : 'Records'}
        actions={
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, height: 28, border: 1, borderColor: 'divider', borderRadius: 1, width: 160 }}>
              <SearchIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
              <InputBase
                value={state.filter}
                onChange={(event) => setState({ filter: event.target.value })}
                placeholder="Filter"
                inputProps={{ 'aria-label': 'Filter records' }}
                sx={{ fontSize: 12.5, flex: 1 }}
              />
            </Box>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={state.since}
              disabled={state.running}
              onChange={(_event, since: AcctzState['since'] | null) => since && setState({ since })}
              sx={{ '& .MuiToggleButton-root': { py: 0.2, px: 1, fontSize: 11.5, whiteSpace: 'nowrap' } }}
            >
              <ToggleButton value="live">New only</ToggleButton>
              <ToggleButton value="15m">15 min</ToggleButton>
              <ToggleButton value="1h">1 h</ToggleButton>
              <ToggleButton value="24h">24 h</ToggleButton>
            </ToggleButtonGroup>
            <Tooltip title="Clear">
              <IconButton size="small" aria-label="Clear records" onClick={() => setState({ records: [] })}>
                <DeleteSweepOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Export as CSV">
              <span>
                <IconButton size="small" aria-label="Export as CSV" disabled={records.length === 0} onClick={exportCsv}>
                  <FileDownloadOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            {state.running ? (
              <Button size="small" color="error" variant="outlined" startIcon={<StopRoundedIcon />} onClick={() => activeStream(store, 'acctz')?.cancel()}>
                Stop
              </Button>
            ) : (
              <Button size="small" variant="contained" startIcon={<PlayArrowRoundedIcon />} disabled={!grpc} onClick={start}>
                Watch
              </Button>
            )}
          </Stack>
        }
      >
        {records.length === 0 ? (
          <Typography variant="body2" color="textSecondary">
            {state.running
              ? 'Waiting for activity on the device …'
              : 'Watch streams the accounting records: the history you choose, then everything that happens next.'}
          </Typography>
        ) : (
          <Box sx={{ maxHeight: 520, overflow: 'auto', mx: -1.75, mb: -1.75, '& > *': { minWidth: 720 } }}>
            <Stack
              direction="row"
              spacing={1.5}
              sx={{ px: 1.75, height: 28, alignItems: 'center', borderBottom: 1, borderColor: 'divider', position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1 }}
            >
              {[
                ['Time', 150],
                ['User', 120],
                ['Via', 120],
                ['What', 0],
                ['', 70],
              ].map(([label, width]) => (
                <Typography
                  key={String(label)}
                  variant="caption"
                  sx={{ fontWeight: 650, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5, ...(width ? { width } : { flex: 1 }) }}
                >
                  {label}
                </Typography>
              ))}
            </Stack>
            {records.map((record) => {
              const fresh = now - record.arrived < 1500;
              return (
                <Stack
                  key={record.key}
                  direction="row"
                  spacing={1.5}
                  sx={{
                    px: 1.75,
                    minHeight: 30,
                    alignItems: 'center',
                    borderBottom: 1,
                    borderColor: 'divider',
                    bgcolor: fresh ? alpha(theme.palette.info.main, 0.08) : 'transparent',
                    transition: 'background-color 800ms ease',
                  }}
                >
                  <Typography sx={{ width: 150, fontSize: 12, color: 'text.secondary', fontFamily: MONO_FONT }}>
                    {record.at ? new Date(record.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
                    <Box component="span" sx={{ color: 'text.disabled', ml: 0.75 }}>
                      {record.at ? new Date(record.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                    </Box>
                  </Typography>
                  <Box sx={{ width: 120, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600 }} noWrap>
                      {record.user}
                    </Typography>
                    {record.role && record.role !== record.user && (
                      <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }} noWrap>
                        {record.role}
                      </Typography>
                    )}
                  </Box>
                  <Box sx={{ width: 120, minWidth: 0 }}>
                    <Chip size="small" label={record.service} sx={{ height: 18, fontSize: 10.5 }} />
                    {record.remote && (
                      <Typography sx={{ fontSize: 10.5, color: 'text.secondary', fontFamily: MONO_FONT }} noWrap title={record.remote}>
                        {record.remote}
                      </Typography>
                    )}
                  </Box>
                  <Typography sx={{ flex: 1, minWidth: 0, fontFamily: MONO_FONT, fontSize: 12 }} noWrap title={record.action}>
                    {record.action}
                  </Typography>
                  <Box sx={{ width: 70, textAlign: 'right' }}>
                    {record.authz && (
                      <Tooltip title={record.authzDetail ?? ''}>
                        <Chip
                          size="small"
                          color={record.authz === 'permit' ? 'success' : 'error'}
                          variant="outlined"
                          label={record.authz === 'permit' ? 'allowed' : record.authz === 'deny' ? 'denied' : 'error'}
                          sx={{ height: 18, fontSize: 10.5 }}
                        />
                      </Tooltip>
                    )}
                  </Box>
                </Stack>
              );
            })}
          </Box>
        )}
      </Section>
    </Box>
  );
}
