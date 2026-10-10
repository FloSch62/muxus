import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import HttpsOutlinedIcon from '@mui/icons-material/HttpsOutlined';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import NoEncryptionGmailerrorredOutlinedIcon from '@mui/icons-material/NoEncryptionGmailerrorredOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import VerticalSplitOutlinedIcon from '@mui/icons-material/VerticalSplitOutlined';
import type { GnmiSessionInfo, ManagementProfile, NetconfSessionInfo } from '@muxus/shared';
import { AUTO_RECONNECT_DELAYS_MS } from '../../connection-recovery.js';
import type { WorkbenchController } from '../../management/controller.js';
import type { WorkbenchArea, WorkbenchStore } from '../../management/workbench-store.js';
import type { SessionPhase } from '../ManagementViewImpl.js';
import { PanelResizeHandle } from '../PanelResizeHandle.js';
import { CandidateBar, GnmiCommitBar } from './CandidateBar.js';
import { WorkbenchContext, useWorkbench, useWorkbenchState, type WorkbenchContextValue } from './context.js';
import { Navigator } from './Navigator.js';
import { MONO_FONT } from './PathText.js';
import { RequestEditor } from './RequestEditor.js';
import { ResultPane } from './ResultPane.js';
import { ToolsArea } from './tools/ToolsArea.js';

const NAVIGATOR_DEFAULT_WIDTH = 300;
const NAVIGATOR_MIN_WIDTH = 220;
/** Below this pane width the navigator floats over the work area instead of sitting beside it. */
const NARROW_WIDTH = 760;

export function Workbench({
  controller,
  store,
  profile,
  title,
  phase,
  statusText,
  endMessage,
  redial,
  active,
  onReconnect,
  onDisconnect,
}: {
  controller: WorkbenchController;
  store: WorkbenchStore;
  profile: ManagementProfile;
  title: string;
  phase: SessionPhase;
  statusText?: string;
  endMessage?: string;
  redial: { delayMs: number; attempt: number } | null;
  active: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = phase === 'connected' && controller.connected;
  const value = useMemo<WorkbenchContextValue>(
    () => ({ controller, store, connected, profile, title }),
    [controller, store, connected, profile, title],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1200);
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const narrow = width < NARROW_WIDTH;

  // The candidate may already hold someone's uncommitted changes.
  useEffect(() => {
    if (connected && controller.netconfInfo) void controller.checkCandidate();
  }, [connected, controller]);

  return (
    <WorkbenchContext.Provider value={value}>
      <Box
        ref={rootRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            const running = store.getState().runs.find((run) => run.status === 'running' && !run.hidden);
            if (running) controller.cancel(running.id);
          }
        }}
        sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, bgcolor: 'background.default' }}
      >
        <SessionHeader phase={phase} onReconnect={onReconnect} onDisconnect={onDisconnect} narrow={narrow} />
        {phase !== 'connected' && (
          <ConnectionBanner
            phase={phase}
            statusText={statusText}
            endMessage={endMessage}
            redial={redial}
            onReconnect={onReconnect}
            onCancel={onDisconnect}
          />
        )}
        <Areas narrow={narrow} active={active} />
      </Box>
    </WorkbenchContext.Provider>
  );
}

/**
 * gNMI sessions also carry gNOI and gNSI. The data area stays mounted while
 * a tools area is open, so its editors and live views carry on underneath.
 */
function Areas({ narrow, active }: { narrow: boolean; active: boolean }) {
  const { profile } = useWorkbench();
  const area = useWorkbenchState((state) => state.area);
  const tools = profile.kind === 'gnmi' && area !== 'data';
  return (
    <>
      <Box sx={{ flex: 1, minHeight: 0, display: tools ? 'none' : 'flex' }}>
        <Body narrow={narrow} active={active && !tools} />
      </Box>
      {tools && <ToolsArea area={area} narrow={narrow} />}
    </>
  );
}

function Body({ narrow, active }: { narrow: boolean; active: boolean }) {
  const { store, profile } = useWorkbench();
  const navigatorOpen = useWorkbenchState((state) => state.navigatorOpen);
  const [navigatorWidth, setNavigatorWidth] = useState(NAVIGATOR_DEFAULT_WIDTH);
  /** null: the request area fits its content; a share once the divider was dragged. */
  const [requestShare, setRequestShare] = useState<number | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);

  // Narrow panes start with the navigator tucked away.
  const wasNarrow = useRef(narrow);
  useEffect(() => {
    if (narrow && !wasNarrow.current) store.getState().setNavigatorOpen(false);
    wasNarrow.current = narrow;
  }, [narrow, store]);

  const navigatorRef = useRef<HTMLDivElement | null>(null);
  const clampNavigator = (width: number, containerWidth: number) =>
    Math.round(Math.max(NAVIGATOR_MIN_WIDTH, Math.min(width, Math.max(NAVIGATOR_MIN_WIDTH, containerWidth * 0.6), 640)));
  const dragSplit = (event: ReactPointerEvent) => {
    event.preventDefault();
    const element = mainRef.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const share = (moveEvent.clientY - box.top) / Math.max(1, box.height);
      setRequestShare(Math.max(0.15, Math.min(0.85, share)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
      {navigatorOpen && (
        <>
          {narrow && (
            <Box
              onClick={() => store.getState().setNavigatorOpen(false)}
              sx={{ position: 'absolute', inset: 0, zIndex: 4, bgcolor: 'rgba(0,0,0,0.25)' }}
            />
          )}
          <Box
            ref={navigatorRef}
            sx={{
              width: narrow ? Math.min(340, navigatorWidth) : navigatorWidth,
              flexShrink: 0,
              borderRight: 1,
              borderColor: 'divider',
              bgcolor: 'sidebar',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              ...(narrow
                ? { position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: 5, boxShadow: 8 }
                : { position: 'relative' }),
            }}
          >
            <Navigator />
            {!narrow && (
              <PanelResizeHandle
                panelRef={navigatorRef}
                edge="right"
                width={navigatorWidth}
                defaultWidth={NAVIGATOR_DEFAULT_WIDTH}
                minWidth={NAVIGATOR_MIN_WIDTH}
                maxWidth={(containerWidth) => clampNavigator(Number.POSITIVE_INFINITY, containerWidth)}
                clampWidth={clampNavigator}
                onWidthChange={setNavigatorWidth}
                label="Resize the navigator"
              />
            )}
          </Box>
        </>
      )}
      <Box ref={mainRef} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {profile.kind === 'netconf' ? <CandidateBar /> : <GnmiCommitBar />}
        <Box
          sx={{
            ...(requestShare === null
              ? { flex: '0 1 auto', maxHeight: '62%' }
              : { flex: `0 0 ${Math.round(requestShare * 100)}%` }),
            minHeight: 120,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <RequestEditor active={active} />
        </Box>
        <Box
          component="hr"
          aria-orientation="horizontal"
          aria-label="Resize the request and result areas"
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round((requestShare ?? 0.42) * 100)}
          tabIndex={0}
          onPointerDown={dragSplit}
          onDoubleClick={() => setRequestShare(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home') return;
            event.preventDefault();
            if (event.key === 'Home') {
              setRequestShare(null);
              return;
            }
            const current = requestShare ?? 0.42;
            setRequestShare(Math.max(0.15, Math.min(0.85, current + (event.key === 'ArrowDown' ? 0.05 : -0.05))));
          }}
          sx={(theme) => ({
            height: 6,
            flexShrink: 0,
            cursor: 'row-resize',
            border: 0,
            borderTop: 1,
            borderColor: 'divider',
            m: 0,
            p: 0,
            position: 'relative',
            outline: 'none',
            touchAction: 'none',
            '&::after': {
              content: '""',
              position: 'absolute',
              left: '50%',
              top: 1,
              width: 36,
              height: 3,
              ml: '-18px',
              borderRadius: 2,
              bgcolor: 'divider',
            },
            '&:hover, &:focus-visible': { bgcolor: alpha(theme.palette.primary.main, 0.15) },
          })}
        />
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ResultPane />
        </Box>
      </Box>
    </Box>
  );
}

function SessionHeader({
  phase,
  onReconnect,
  onDisconnect,
  narrow,
}: {
  phase: SessionPhase;
  onReconnect: () => void;
  onDisconnect: () => void;
  narrow: boolean;
}) {
  const { controller, profile, title, store } = useWorkbench();
  const navigatorOpen = useWorkbenchState((state) => state.navigatorOpen);
  const area = useWorkbenchState((state) => state.area);
  const dataArea = profile.kind !== 'gnmi' || area === 'data';
  const info = controller.info;
  const Icon = profile.kind === 'gnmi' ? SensorsOutlinedIcon : AccountTreeOutlinedIcon;
  const statusColor =
    phase === 'connected' ? 'success.main' : phase === 'connecting' ? 'warning.main' : 'text.disabled';
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: 'center',
        px: 1,
        minHeight: 44,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        flexShrink: 0,
        minWidth: 0,
      }}
    >
      <Tooltip title={dataArea ? (navigatorOpen ? 'Hide the navigator' : 'Show the navigator') : ''}>
        <span>
          <IconButton
            size="small"
            aria-label={navigatorOpen ? 'Hide the navigator' : 'Show the navigator'}
            onClick={() => store.getState().setNavigatorOpen(!navigatorOpen)}
            color={navigatorOpen && dataArea ? 'primary' : 'default'}
            disabled={!dataArea}
          >
            <VerticalSplitOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Box
        sx={(theme) => ({
          display: 'grid',
          placeItems: 'center',
          width: 28,
          height: 28,
          borderRadius: 1.5,
          flexShrink: 0,
          color: 'primary.main',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
        })}
      >
        <Icon sx={{ fontSize: 17 }} />
      </Box>
      <Stack sx={{ minWidth: 0, flexShrink: 1 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 650 }}>
            {title}
          </Typography>
          <Box
            component="span"
            title={phase}
            sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: statusColor, flexShrink: 0 }}
          />
        </Stack>
        <Typography variant="caption" color="textSecondary" noWrap sx={{ fontFamily: MONO_FONT, fontSize: 11 }}>
          {info?.address ?? `${profile.host}:${profile.port}`}
          {info?.via ? ` via ${info.via}` : ''}
        </Typography>
      </Stack>
      {profile.kind === 'gnmi' && <AreaSwitch narrow={narrow} />}
      <Box sx={{ flex: 1 }} />
      {!narrow && info?.protocol === 'gnmi' && <GnmiChips info={info} />}
      {!narrow && info?.protocol === 'netconf' && <NetconfChips info={info} />}
      <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
      <Tooltip title="Reconnect">
        <IconButton size="small" aria-label="Reconnect" onClick={onReconnect}>
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Disconnect">
        <span>
          <IconButton size="small" aria-label="Disconnect" onClick={onDisconnect} disabled={phase !== 'connected'}>
            <LinkOffOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

const AREAS: Array<{ value: WorkbenchArea; label: string; hint: string; Icon: typeof SensorsOutlinedIcon }> = [
  { value: 'data', label: 'Data', hint: 'gNMI: read, change and stream the configuration and state', Icon: DataObjectOutlinedIcon },
  { value: 'operations', label: 'Operations', hint: 'gNOI: ping, traceroute, files, health, reboot …', Icon: BuildOutlinedIcon },
  { value: 'security', label: 'Security', hint: 'gNSI: authorization, certificates, SSH keys, accounting', Icon: ShieldOutlinedIcon },
];

function AreaSwitch({ narrow }: { narrow: boolean }) {
  const { store } = useWorkbench();
  const area = useWorkbenchState((state) => state.area);
  // A rotation waiting for its finalize rolls back when the session ends; keep it in sight.
  const pendingRotation = useWorkbenchState((state) =>
    Object.values(state.tools).some((tool) => (tool as { rotation?: { phase?: string } } | undefined)?.rotation?.phase === 'pending'),
  );
  return (
    <Box
      sx={{
        display: 'flex',
        flexShrink: 0,
        ml: narrow ? 0.5 : 2,
        p: 0.375,
        gap: 0.25,
        borderRadius: 2,
        bgcolor: 'action.hover',
      }}
    >
      {AREAS.map(({ value, label, hint, Icon }) => {
        const selected = area === value;
        return (
          <Tooltip key={value} title={narrow ? `${label}: ${hint}` : hint}>
            <Box
              component="button"
              type="button"
              aria-pressed={selected}
              aria-label={label}
              onClick={() => store.getState().setArea(value)}
              sx={(theme) => ({
                all: 'unset',
                cursor: 'pointer',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 0.6,
                px: narrow ? 0.9 : 1.25,
                height: 26,
                borderRadius: 1.5,
                fontSize: 12.5,
                fontWeight: selected ? 650 : 500,
                color: selected ? 'text.primary' : 'text.secondary',
                bgcolor: selected ? 'background.paper' : 'transparent',
                boxShadow: selected ? `0 1px 2px ${alpha(theme.palette.common.black, 0.18)}` : 'none',
                transition: 'background-color 120ms ease, color 120ms ease',
                '&:hover': { color: 'text.primary' },
                '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 },
                '& svg': { fontSize: 16, color: selected ? 'primary.main' : 'inherit' },
              })}
            >
              <Icon />
              {!narrow && label}
              {value === 'security' && pendingRotation && (
                <Box
                  component="span"
                  sx={{ position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main' }}
                />
              )}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

const chipSx = { height: 22, fontSize: 11.5, '& .MuiChip-label': { px: 0.9 }, '& .MuiChip-icon': { fontSize: 14, ml: 0.6 } };

function GnmiChips({ info }: { info: GnmiSessionInfo }) {
  const { store } = useWorkbench();
  const tls = info.tls;
  const tlsLabel =
    tls.mode === 'plaintext' ? 'Plain text' : tls.verified ? 'TLS' : tls.mode === 'skip-verify' ? 'TLS, unverified' : 'TLS, pinned';
  const tlsTip =
    tls.mode === 'plaintext' ? (
      'No encryption: requests and passwords cross the network readable.'
    ) : (
      <Box sx={{ fontSize: 12 }}>
        <div>
          {tls.verified
            ? 'Certificate verified.'
            : tls.mode === 'skip-verify'
              ? 'Certificate not checked (skip-verify).'
              : 'Certificate trusted on first use and pinned.'}
        </div>
        {tls.subject && <div>Issued to: {tls.subject}</div>}
        {tls.issuer && <div>Issued by: {tls.issuer}</div>}
        {tls.validTo && <div>Valid until: {tls.validTo}</div>}
        {tls.protocol && <div>{tls.protocol}</div>}
        {tls.fingerprint && <Box sx={{ fontFamily: MONO_FONT, fontSize: 10.5, mt: 0.5, wordBreak: 'break-all' }}>{tls.fingerprint}</Box>}
      </Box>
    );
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexShrink: 0 }}>
      <Chip size="small" variant="outlined" label={`gNMI ${info.version || '?'}`} sx={chipSx} />
      <Tooltip title={`Supported: ${info.encodings.map((encoding) => encoding.toUpperCase()).join(', ') || 'not listed'}`}>
        <Chip
          size="small"
          variant="outlined"
          label={`${info.encodings.length} encodings`}
          sx={chipSx}
        />
      </Tooltip>
      <Chip
        size="small"
        variant="outlined"
        label={`${info.models.length} models`}
        onClick={() => store.getState().setNavigator('device')}
        sx={chipSx}
      />
      <Tooltip title={tlsTip}>
        <Chip
          size="small"
          variant="outlined"
          color={tls.mode === 'plaintext' ? 'warning' : tls.verified || tls.pinned ? 'success' : 'default'}
          icon={tls.mode === 'plaintext' ? <NoEncryptionGmailerrorredOutlinedIcon /> : <HttpsOutlinedIcon />}
          label={tlsLabel}
          sx={chipSx}
        />
      </Tooltip>
    </Stack>
  );
}

const FEATURED_CAPABILITIES: Array<{ fragment: string; label: string }> = [
  { fragment: ':candidate', label: 'candidate' },
  { fragment: ':confirmed-commit', label: 'confirmed-commit' },
  { fragment: ':validate', label: 'validate' },
  { fragment: ':writable-running', label: 'writable-running' },
  { fragment: ':xpath', label: 'xpath' },
  { fragment: ':notification', label: 'notifications' },
];

function NetconfChips({ info }: { info: NetconfSessionInfo }) {
  const { controller, store } = useWorkbench();
  const modules = info.capabilities.filter((capability) => capability.includes('module=')).length;
  const featured = FEATURED_CAPABILITIES.filter((capability) => controller.hasCapability(capability.fragment));
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexShrink: 0 }}>
      <Tooltip title={info.base === '1.1' ? 'Chunked framing (base:1.1)' : 'End-of-message framing (base:1.0)'}>
        <Chip size="small" variant="outlined" label={`base:${info.base}`} sx={chipSx} />
      </Tooltip>
      {info.sessionId && <Chip size="small" variant="outlined" label={`session ${info.sessionId}`} sx={chipSx} />}
      <Tooltip title={featured.map((capability) => capability.label).join(' · ') || 'No optional capabilities'}>
        <Chip
          size="small"
          variant="outlined"
          label={`${modules} modules`}
          onClick={() => store.getState().setNavigator('device')}
          sx={chipSx}
        />
      </Tooltip>
    </Stack>
  );
}

function ConnectionBanner({
  phase,
  statusText,
  endMessage,
  redial,
  onReconnect,
  onCancel,
}: {
  phase: SessionPhase;
  statusText?: string;
  endMessage?: string;
  redial: { delayMs: number; attempt: number } | null;
  onReconnect: () => void;
  onCancel: () => void;
}) {
  const connecting = phase === 'connecting';
  const [remaining, setRemaining] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!redial) {
      setRemaining(undefined);
      return;
    }
    const deadline = Date.now() + redial.delayMs;
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [redial]);
  const message = connecting
    ? (statusText?.split('\n')[0] ?? 'Reconnecting …')
    : redial
      ? `${endMessage ?? 'Disconnected.'} Reconnecting in ${remaining ?? Math.round(redial.delayMs / 1000)} s (attempt ${redial.attempt} of ${AUTO_RECONNECT_DELAYS_MS.length}).`
      : `${endMessage ?? 'Disconnected.'} Your requests, results and history are kept.`;
  return (
    <Stack
      component="output"
      direction="row"
      spacing={1}
      sx={(theme) => ({
        alignItems: 'center',
        px: 1.5,
        py: 0.5,
        minHeight: 36,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: alpha(connecting ? theme.palette.info.main : theme.palette.warning.main, 0.12),
      })}
    >
      {connecting ? <CircularProgress size={14} /> : <LinkOffOutlinedIcon sx={{ fontSize: 17, color: 'warning.main' }} />}
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap title={message}>
        {message}
      </Typography>
      {connecting ? (
        <Button size="small" color="inherit" onClick={onCancel}>
          Cancel
        </Button>
      ) : (
        <Button size="small" variant="contained" startIcon={<RefreshIcon />} onClick={onReconnect}>
          {redial ? 'Reconnect now' : 'Reconnect'}
        </Button>
      )}
    </Stack>
  );
}

export function useRunShortcut(run: () => void, enabled: boolean): (event: React.KeyboardEvent) => void {
  return useCallback(
    (event: React.KeyboardEvent) => {
      if (!enabled) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        run();
      }
    },
    [run, enabled],
  );
}
