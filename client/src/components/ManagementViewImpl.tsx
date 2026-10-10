import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import type {
  AuthPromptInfo,
  DesktopCertificateChallenge,
  ManagementProfile,
  ManagementSessionInfo,
} from '@muxus/shared';
import {
  AUTO_RECONNECT_DELAYS_MS,
  AUTO_RECONNECT_STABLE_MS,
  autoReconnectDelayMs,
} from '../connection-recovery.js';
import { WorkbenchController } from '../management/controller.js';
import { ManagementConnection } from '../management/session-client.js';
import { createWorkbenchStore } from '../management/workbench-store.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore, type SessionTab } from '../state/tabs.js';
import { AuthPromptDialog, type AuthPromptResult } from './AuthPromptDialog.js';
import { DesktopCertificateDialog } from './DesktopCertificateDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';
import { Workbench } from './management/Workbench.js';

export type SessionPhase = 'idle' | 'connecting' | 'connected' | 'ended';

/**
 * A NETCONF or gNMI tab. The connection lives on /ws/management; the
 * workbench (drafts, results, history, explorer) belongs to the tab and
 * outlives reconnects, so a dropped session costs nothing but a click.
 */
export function ManagementViewImpl({
  tab,
  profile,
  active,
}: {
  tab: SessionTab;
  profile: ManagementProfile;
  active: boolean;
}) {
  const updateTab = useTabsStore((s) => s.update);
  const reconnectRequest = useTabsStore(
    (s) => s.tabs.find((candidate) => candidate.id === tab.id)?.reconnectRequest ?? 0,
  );
  const lastReconnectRequestRef = useRef(reconnectRequest);
  const [generation, setGeneration] = useState(tab.connectOnMount ? 1 : 0);
  const [phase, setPhase] = useState<SessionPhase>(tab.connectOnMount ? 'connecting' : 'idle');
  const [statusText, setStatusText] = useState<string>();
  const [endMessage, setEndMessage] = useState<string>();
  const [authPrompt, setAuthPrompt] = useState<AuthPromptInfo | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyRequest | null>(null);
  const [certificate, setCertificate] = useState<DesktopCertificateChallenge | null>(null);
  const [session, setSession] = useState<{
    connection: ManagementConnection;
    info: ManagementSessionInfo;
    profile: ManagementProfile;
  } | null>(null);
  /** What the last session advertised, kept across drops so the workbench stays usable. */
  const [lastInfo, setLastInfo] = useState<{ info: ManagementSessionInfo; profile: ManagementProfile } | null>(null);
  const [redial, setRedial] = useState<{ delayMs: number; attempt: number } | null>(null);
  const redialAttemptsRef = useRef(0);
  const userDisconnectRef = useRef(false);
  const connectionRef = useRef<ManagementConnection | null>(null);
  const [store] = useState(() => createWorkbenchStore(profile.kind));

  useEffect(() => {
    if (reconnectRequest === lastReconnectRequestRef.current) return;
    lastReconnectRequestRef.current = reconnectRequest;
    setGeneration((current) => current + 1);
  }, [reconnectRequest]);

  useEffect(() => {
    if (generation === 0) return;
    let disposed = false;
    let connectedAt = 0;
    let sawAuthPrompt = false;
    userDisconnectRef.current = false;
    setPhase('connecting');
    setStatusText(undefined);
    setEndMessage(undefined);
    setRedial(null);
    updateTab(tab.id, { status: 'connecting', failureReason: undefined, disconnectReason: undefined });

    const connection = new ManagementConnection(profile, {
      status: (message) => {
        if (disposed) return;
        // A login banner (SSH servers send several lines) is kept for the
        // Device tab instead of standing in for the connection status.
        if (message.split('\n').length > 2) {
          store.setState({ banner: message });
          return;
        }
        setStatusText(message);
      },
      authPrompt: (info) => {
        sawAuthPrompt = true;
        setAuthPrompt(info);
      },
      hostKey: (request) => setHostKey(request),
      certificate: (challenge) => setCertificate(challenge),
      ready: (info, dialed) => {
        if (disposed) return;
        connectedAt = Date.now();
        setSession({ connection, info, profile: dialed });
        setLastInfo({ info, profile: dialed });
        setPhase('connected');
        setStatusText(undefined);
        updateTab(tab.id, { status: 'connected', failureReason: undefined, disconnectReason: undefined });
      },
      netconfNotification: (xml, eventTime, receivedAt) => {
        const state = store.getState();
        store.setState({ notifications: [{ xml, eventTime, receivedAt }, ...state.notifications].slice(0, 500) });
      },
      closed: (exit, socketFailed) => {
        if (connectionRef.current === connection) connectionRef.current = null;
        if (disposed) return;
        setAuthPrompt(null);
        setHostKey(null);
        setCertificate(null);
        setSession(null);
        const everConnected = connectedAt !== 0;
        const reason = exit?.reason ?? (everConnected ? 'disconnected' : 'failed');
        const message =
          exit?.message ??
          (socketFailed && !everConnected ? 'Could not reach the Muxus backend.' : 'The connection closed.');
        setPhase('ended');
        setEndMessage(message);
        if (connectedAt !== 0 && Date.now() - connectedAt >= AUTO_RECONNECT_STABLE_MS) redialAttemptsRef.current = 0;
        const delayMs = autoReconnectDelayMs({
          enabled: usePrefsStore.getState().autoReconnectRemote && !userDisconnectRef.current,
          profileKind: profile.kind,
          reason,
          attempts: redialAttemptsRef.current,
          sawAuthPrompt,
        });
        if (delayMs !== undefined) {
          redialAttemptsRef.current += 1;
          setRedial({ delayMs, attempt: redialAttemptsRef.current });
        }
        updateTab(tab.id, {
          status: 'closed',
          failureReason: reason === 'completed' ? undefined : message,
          disconnectReason: reason,
        });
      },
    });
    connectionRef.current = connection;
    return () => {
      disposed = true;
      if (connectionRef.current === connection) connectionRef.current = null;
      connection.close();
    };
    // The connection is keyed on the generation alone: profile edits apply on the next connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  useEffect(() => {
    if (!redial) return;
    const timer = setTimeout(() => {
      setRedial(null);
      if (usePrefsStore.getState().autoReconnectRemote) setGeneration((current) => current + 1);
    }, redial.delayMs);
    return () => clearTimeout(timer);
  }, [redial]);

  const reconnect = useCallback(() => {
    redialAttemptsRef.current = 0;
    setGeneration((current) => current + 1);
  }, []);
  const disconnect = useCallback(() => {
    userDisconnectRef.current = true;
    setRedial(null);
    connectionRef.current?.close();
  }, []);

  const dialedProfile = session?.profile ?? lastInfo?.profile ?? profile;
  const controller = useMemo(
    () => new WorkbenchController(store, session?.connection ?? null, dialedProfile, session?.info ?? lastInfo?.info),
    [store, session, dialedProfile, lastInfo],
  );
  useEffect(() => () => controller.detach(), [controller]);

  const answerAuth = (response: AuthPromptResult | null) => {
    setAuthPrompt(null);
    if (response === null) connectionRef.current?.close();
    else connectionRef.current?.send({ op: 'auth-response', ...response });
  };
  const answerHostKey = (accept: boolean) => {
    setHostKey(null);
    connectionRef.current?.send({ op: 'host-key-response', accept });
  };
  const answerCertificate = (accept: boolean) => {
    setCertificate(null);
    if (!accept) userDisconnectRef.current = true;
    connectionRef.current?.send({ op: 'certificate-response', accept });
  };

  const address = `${profile.host}:${profile.port}`;
  const ProtocolIcon = profile.kind === 'gnmi' ? SensorsOutlinedIcon : AccountTreeOutlinedIcon;

  return (
    <Box
      data-management-kind={profile.kind}
      sx={{ position: 'relative', height: '100%', overflow: 'hidden', bgcolor: 'background.default' }}
    >
      {lastInfo ? (
        <Workbench
          controller={controller}
          store={store}
          profile={dialedProfile}
          title={tab.title}
          phase={phase}
          statusText={statusText}
          endMessage={endMessage}
          redial={redial}
          active={active}
          onReconnect={reconnect}
          onDisconnect={disconnect}
        />
      ) : (
        <Stack
          spacing={2}
          sx={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', textAlign: 'center', px: 3 }}
        >
          {phase === 'connecting' ? (
            <>
              <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                <CircularProgress size={56} thickness={2.5} />
                <ProtocolIcon
                  color="primary"
                  sx={{ position: 'absolute', inset: 0, m: 'auto', fontSize: 24 }}
                />
              </Box>
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle1">
                  {profile.kind === 'gnmi' ? 'gNMI' : 'NETCONF'} · {tab.title}
                </Typography>
                <Typography variant="body2" color="textSecondary" sx={{ maxWidth: 520, whiteSpace: 'pre-line' }}>
                  {statusText?.split('\n')[0] ?? `Connecting to ${address} …`}
                </Typography>
              </Stack>
              <Button size="small" color="inherit" onClick={disconnect}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Box
                sx={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  bgcolor: 'action.hover',
                  color: phase === 'ended' ? 'error.main' : 'text.secondary',
                }}
              >
                {phase === 'ended' ? <LinkOffOutlinedIcon sx={{ fontSize: 30 }} /> : <ProtocolIcon sx={{ fontSize: 30 }} />}
              </Box>
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle1">
                  {profile.kind === 'gnmi' ? 'gNMI' : 'NETCONF'} · {tab.title}
                </Typography>
                <Typography variant="body2" color="textSecondary" sx={{ maxWidth: 560 }}>
                  {phase === 'idle' ? address : (endMessage ?? 'Disconnected.')}
                </Typography>
                {redial && (
                  <Typography variant="caption" color="textSecondary">
                    Reconnecting in {Math.round(redial.delayMs / 1000)} s (attempt {redial.attempt} of{' '}
                    {AUTO_RECONNECT_DELAYS_MS.length})
                  </Typography>
                )}
              </Stack>
              <Button variant="contained" startIcon={<RefreshIcon />} onClick={reconnect}>
                {phase === 'idle' ? 'Connect' : redial ? 'Reconnect now' : 'Reconnect'}
              </Button>
            </>
          )}
        </Stack>
      )}
      <AuthPromptDialog request={authPrompt} onSubmit={answerAuth} />
      <HostKeyDialog request={hostKey} onAnswer={answerHostKey} />
      <DesktopCertificateDialog request={certificate} onAnswer={answerCertificate} service="gnmi" />
    </Box>
  );
}
