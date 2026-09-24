import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DesktopAccessDisabledOutlinedIcon from '@mui/icons-material/DesktopAccessDisabledOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import WindowOutlinedIcon from '@mui/icons-material/WindowOutlined';
import type {
  AuthPromptInfo,
  DesktopCertificateChallenge,
  DesktopClientMessage,
  DesktopCredentials,
  DesktopProfile,
  DesktopServerMessage,
} from '@muxus/shared';
import {
  DESKTOP_RDP_WS_PATH,
  DESKTOP_TICKET_PROTOCOL_PREFIX,
  DESKTOP_VNC_WS_PATH,
} from '@muxus/shared/ws-protocol';
import { wsProtocols, wsUrl } from '../api/http.js';
import { copyToClipboard, readFromClipboard } from '../clipboard.js';
import {
  AUTO_RECONNECT_DELAYS_MS,
  AUTO_RECONNECT_STABLE_MS,
  autoReconnectDelayMs,
} from '../connection-recovery.js';
import { RdpConnection, RdpFailure, describeRdpError } from '../remote-desktop/rdp-client.js';
import { VncConnection } from '../remote-desktop/vnc-client.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore, type SessionTab } from '../state/tabs.js';
import { showToast } from '../state/toast.js';
import { AuthPromptDialog, type AuthPromptResult } from './AuthPromptDialog.js';
import { DesktopCertificateDialog } from './DesktopCertificateDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';

type Phase = 'idle' | 'connecting' | 'connected' | 'ended';
type EndReason = 'completed' | 'failed' | 'disconnected';

/** Canvas box that fits the remote desktop into the pane without distorting it. */
function fitRect(
  viewport: { width: number; height: number },
  desktop: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (desktop.width <= 0 || desktop.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { left: 0, top: 0, width: viewport.width, height: viewport.height };
  }
  const scale = Math.min(viewport.width / desktop.width, viewport.height / desktop.height);
  const width = Math.round(desktop.width * scale);
  const height = Math.round(desktop.height * scale);
  return {
    left: Math.floor((viewport.width - width) / 2),
    top: Math.floor((viewport.height - height) / 2),
    width,
    height,
  };
}

const RESIZE_SETTLE_MS = 300;

/**
 * An RDP or VNC tab. A control socket to the backend handles the SSH gateway,
 * credentials and certificate trust; the picture arrives on a second socket
 * the backend authorizes with a single-use ticket. IronRDP (WebAssembly)
 * draws RDP into our canvas; noVNC brings its own canvas for VNC.
 */
export function RemoteDesktopViewImpl({
  tab,
  profile,
  active,
}: {
  tab: SessionTab;
  profile: DesktopProfile;
  active: boolean;
}) {
  const updateTab = useTabsStore((s) => s.update);
  const reconnectRequest = useTabsStore(
    (s) => s.tabs.find((candidate) => candidate.id === tab.id)?.reconnectRequest ?? 0,
  );
  const lastReconnectRequestRef = useRef(reconnectRequest);
  const [generation, setGeneration] = useState(tab.connectOnMount ? 1 : 0);
  const [phase, setPhase] = useState<Phase>(tab.connectOnMount ? 'connecting' : 'idle');
  const [statusText, setStatusText] = useState<string>();
  const [endMessage, setEndMessage] = useState<string>();
  const [authPrompt, setAuthPrompt] = useState<AuthPromptInfo | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyRequest | null>(null);
  const [certificate, setCertificate] = useState<DesktopCertificateChallenge | null>(null);
  const [cursor, setCursor] = useState('default');
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [desktopSize, setDesktopSize] = useState({ width: 0, height: 0 });
  const [toolbarVisible, setToolbarVisible] = useState(false);
  /** A dropped session waiting to redial, per the auto-reconnect preference. */
  const [redial, setRedial] = useState<{ delayMs: number; attempt: number } | null>(null);
  const redialAttemptsRef = useRef(0);
  const userDisconnectRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vncTargetRef = useRef<HTMLDivElement | null>(null);
  const controlRef = useRef<WebSocket | null>(null);
  const rdpRef = useRef<RdpConnection | null>(null);
  const vncRef = useRef<VncConnection | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  /**
   * What the backend dialed, from its last `ready`. A saved host connects with
   * its current settings, which may be newer than the tab's snapshot.
   */
  const [dialed, setDialed] = useState<{ from: DesktopProfile; profile: DesktopProfile } | null>(null);
  const current = dialed?.from === profile ? dialed.profile : profile;
  const shareClipboardRef = useRef(current.shareClipboard !== false);

  useEffect(() => {
    if (reconnectRequest === lastReconnectRequestRef.current) return;
    lastReconnectRequestRef.current = reconnectRequest;
    setGeneration((current) => current + 1);
  }, [reconnectRequest]);

  const sendControl = useCallback((message: DesktopClientMessage) => {
    const socket = controlRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  /** Offer the local clipboard to the remote side when the desktop takes focus. */
  const pushClipboard = useCallback(() => {
    if (!shareClipboardRef.current) return;
    void readFromClipboard().then((text) => {
      if (text === null || !shareClipboardRef.current) return;
      if (rdpRef.current) void rdpRef.current.sendClipboardText(text);
      vncRef.current?.sendClipboardText(text);
    });
  }, []);

  const focusDesktop = useCallback(() => {
    if (rdpRef.current) canvasRef.current?.focus({ preventScroll: true });
    vncRef.current?.focus();
  }, []);

  useEffect(() => {
    if (generation === 0) return;
    let disposed = false;
    let everConnected = false;
    let finished = false;
    let exit: Extract<DesktopServerMessage, { op: 'exit' }> | undefined;
    let credentialsWaiter: ((credentials: DesktopCredentials) => void) | undefined;
    /** noVNC holds an RSA-AES handshake until the backend has checked the key. */
    let serverKeyWaiter: ((accept: boolean) => void) | undefined;
    const answerServerKey = (accept: boolean) => {
      const waiter = serverKeyWaiter;
      serverKeyWaiter = undefined;
      waiter?.(accept);
    };
    let connectedAt = 0;
    let sawAuthPrompt = false;
    userDisconnectRef.current = false;
    const control = new WebSocket(wsUrl('/ws/desktop'), wsProtocols());
    controlRef.current = control;
    setPhase('connecting');
    setStatusText(undefined);
    setEndMessage(undefined);
    setRedial(null);
    updateTab(tab.id, { status: 'connecting', failureReason: undefined, disconnectReason: undefined });

    const send = (message: DesktopClientMessage) => {
      if (control.readyState === WebSocket.OPEN) control.send(JSON.stringify(message));
    };

    const teardownStreams = () => {
      answerServerKey(false);
      rdpRef.current?.shutdown();
      rdpRef.current = null;
      vncRef.current?.disconnect();
      vncRef.current = null;
    };

    const finish = (message: string | undefined, reason: EndReason) => {
      if (finished || disposed) return;
      finished = true;
      teardownStreams();
      setAuthPrompt(null);
      setHostKey(null);
      setCertificate(null);
      setPhase('ended');
      setEndMessage(message);
      // A drop after a stable stretch starts a fresh redial chain.
      if (connectedAt !== 0 && Date.now() - connectedAt >= AUTO_RECONNECT_STABLE_MS) {
        redialAttemptsRef.current = 0;
      }
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
      if (control.readyState === WebSocket.OPEN || control.readyState === WebSocket.CONNECTING) {
        control.close();
      }
    };

    const markConnected = () => {
      everConnected = true;
      connectedAt = Date.now();
      setPhase('connected');
      setStatusText(undefined);
      updateTab(tab.id, { status: 'connected', failureReason: undefined, disconnectReason: undefined });
      send({ op: 'connected' });
      if (activeRef.current) {
        focusDesktop();
        pushClipboard();
      }
    };

    const startRdp = async (
      target: Extract<DesktopProfile, { kind: 'rdp' }>,
      ticket: string,
      credentials: DesktopCredentials,
    ) => {
      const canvas = canvasRef.current;
      const box = viewportRef.current?.getBoundingClientRect();
      if (!canvas) return;
      setStatusText('Negotiating the Remote Desktop session …');
      try {
        const connection = await RdpConnection.connect({
          canvas,
          proxyAddress: wsUrl(DESKTOP_RDP_WS_PATH),
          ticket,
          destination: `${target.host}:${target.port}`,
          username: credentials.username ?? '',
          password: credentials.password ?? '',
          domain: credentials.domain,
          width: box && box.width >= 200 ? box.width : 1280,
          height: box && box.height >= 200 ? box.height : 800,
          shareClipboard: target.shareClipboard !== false,
          onCursor: setCursor,
          onRemoteClipboard: (text) => {
            void copyToClipboard(text);
          },
        });
        if (disposed || finished) {
          connection.shutdown();
          return;
        }
        rdpRef.current = connection;
        setDesktopSize({ width: canvas.width, height: canvas.height });
        markConnected();
        const reason = await connection.run();
        if (!disposed) finish(reason ? `The remote session ended: ${reason}` : 'The remote session ended.', 'completed');
      } catch (err) {
        if (disposed || finished) return;
        const failure = err instanceof RdpFailure ? err : describeRdpError(err);
        rdpRef.current = null;
        if (failure.kind === 'credentials' && !everConnected) {
          setStatusText(failure.message);
          send({ op: 'retry', rejected: true });
          return;
        }
        finish(failure.message, everConnected ? 'disconnected' : 'failed');
      }
    };

    const startVnc = async (vnc: Extract<DesktopProfile, { kind: 'vnc' }>, ticket: string) => {
      const target = vncTargetRef.current;
      if (!target) return;
      setStatusText('Opening the VNC session …');
      let connected = false;
      /** Only a server that asked for credentials can have rejected them. */
      let askedForCredentials = false;
      let connection: VncConnection | undefined;
      const opened = VncConnection.open({
        target,
        url: wsUrl(DESKTOP_VNC_WS_PATH),
        protocols: [...wsProtocols(), `${DESKTOP_TICKET_PROTOCOL_PREFIX}${ticket}`],
        viewOnly: vnc.viewOnly === true,
        resizeRemote: vnc.resizeRemote === true,
        shareClipboard: vnc.shareClipboard !== false,
        onConnect: () => {
          connected = true;
          if (!disposed) markConnected();
        },
        onServerKey: (key) =>
          new Promise<boolean>((resolve) => {
            answerServerKey(false);
            serverKeyWaiter = resolve;
            send({ op: 'server-key', ...key });
          }),
        onCredentialsRequired: (types) => {
          askedForCredentials = true;
          credentialsWaiter = (credentials) => connection?.sendCredentials(credentials);
          send({ op: 'credentials-request', types });
        },
        onDisconnect: ({ clean, securityFailure, failure }) => {
          if (vncRef.current === connection) vncRef.current = null;
          if (disposed || finished) return;
          if (securityFailure && !connected && askedForCredentials) {
            setStatusText(`The server rejected the login: ${securityFailure}`);
            send({ op: 'retry', rejected: true });
            return;
          }
          if (securityFailure && !connected) {
            // Refused before any sign-in (blacklisted, too many clients, ACL):
            // redialling would only be refused again.
            finish(`The VNC server refused the connection: ${securityFailure}`, 'failed');
            return;
          }
          if (connected) {
            finish(clean ? 'The VNC session ended.' : 'The connection to the VNC server was lost.', clean ? 'completed' : 'disconnected');
          } else {
            finish(failure ?? 'Could not open the VNC session.', 'failed');
          }
        },
        onRemoteClipboard: (text) => {
          void copyToClipboard(text);
        },
      });
      try {
        connection = await opened;
      } catch (err) {
        finish(`Could not load the VNC client: ${err instanceof Error ? err.message : String(err)}`, 'failed');
        return;
      }
      if (disposed || finished) connection.disconnect();
      else vncRef.current = connection;
    };

    control.onopen = () => send({ op: 'connect', profile });
    control.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: DesktopServerMessage;
      try {
        message = JSON.parse(event.data) as DesktopServerMessage;
      } catch {
        return;
      }
      switch (message.op) {
        case 'status':
          // Once the desktop is up the overlay is gone; lasting notes become toasts.
          if (everConnected && !finished && !message.transient) showToast('info', message.message);
          else setStatusText(message.message);
          break;
        case 'auth-prompt':
          sawAuthPrompt = true;
          setAuthPrompt({
            name: message.name,
            instructions: message.instructions,
            host: message.host,
            prompts: message.prompts,
            purpose: message.purpose,
            rememberPassword: message.rememberPassword,
            skipLabel: message.skipLabel,
          });
          break;
        case 'host-key':
          setHostKey(message);
          break;
        case 'certificate': {
          const { op: _op, ...challenge } = message;
          setCertificate(challenge);
          break;
        }
        case 'ready': {
          teardownStreams();
          const dialedProfile = message.profile;
          shareClipboardRef.current = dialedProfile.shareClipboard !== false;
          setDialed({ from: profile, profile: dialedProfile });
          if (dialedProfile.kind === 'rdp') void startRdp(dialedProfile, message.ticket, message.credentials ?? {});
          else void startVnc(dialedProfile, message.ticket);
          break;
        }
        case 'credentials':
          credentialsWaiter?.(message.credentials);
          credentialsWaiter = undefined;
          break;
        case 'server-key-verdict':
          answerServerKey(message.accept);
          break;
        case 'exit':
          exit = message;
          break;
      }
    };
    let socketFailed = false;
    control.onerror = () => {
      socketFailed = true;
    };
    control.onclose = () => {
      if (controlRef.current === control) controlRef.current = null;
      if (disposed || finished) return;
      setAuthPrompt(null);
      setHostKey(null);
      setCertificate(null);
      finish(
        exit?.message ??
          (socketFailed && !everConnected ? 'Could not reach the Muxus backend.' : 'The connection closed.'),
        exit?.reason ?? (everConnected ? 'disconnected' : 'failed'),
      );
    };

    return () => {
      disposed = true;
      teardownStreams();
      if (controlRef.current === control) controlRef.current = null;
      control.close();
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

  // Measure the pane; RDP follows it with display-control resizes.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (phase !== 'connected' || viewport.width < 200 || viewport.height < 200) return;
    const timer = setTimeout(() => rdpRef.current?.resize(viewport.width, viewport.height), RESIZE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [phase, viewport.width, viewport.height]);

  // IronRDP resizes the canvas itself when the server changes the desktop size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new MutationObserver(() => setDesktopSize({ width: canvas.width, height: canvas.height }));
    observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active) {
      rdpRef.current?.releaseAll();
      return;
    }
    if (phase !== 'connected') return;
    focusDesktop();
    pushClipboard();
    const onWindowFocus = () => pushClipboard();
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [active, phase, focusDesktop, pushClipboard]);

  // Wheel listeners must be non-passive to keep the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      if (!rdpRef.current) return;
      event.preventDefault();
      rdpRef.current.wheel(event);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the toolbar in view briefly after connecting so it can be found.
  useEffect(() => {
    if (phase !== 'connected') return;
    setToolbarVisible(true);
    const timer = setTimeout(() => setToolbarVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [phase]);

  const answerAuth = (response: AuthPromptResult | null) => {
    setAuthPrompt(null);
    if (response === null) controlRef.current?.close();
    else sendControl({ op: 'auth-response', ...response });
  };
  const answerHostKey = (accept: boolean) => {
    setHostKey(null);
    sendControl({ op: 'host-key-response', accept });
  };
  const answerCertificate = (accept: boolean) => {
    setCertificate(null);
    // Declining is the user's decision; redialling would only ask again.
    if (!accept) userDisconnectRef.current = true;
    sendControl({ op: 'certificate-response', accept });
  };
  const reconnect = () => {
    redialAttemptsRef.current = 0;
    setGeneration((current) => current + 1);
  };
  const disconnect = () => {
    userDisconnectRef.current = true;
    rdpRef.current?.shutdown();
    vncRef.current?.disconnect();
    controlRef.current?.close();
  };

  const rdp = profile.kind === 'rdp';
  const canvasBox = fitRect(viewport, desktopSize);
  const address = `${current.host}:${current.port}`;

  return (
    <Box
      ref={viewportRef}
      data-desktop-kind={profile.kind}
      onMouseLeave={() => setToolbarVisible(false)}
      sx={{ position: 'relative', height: '100%', overflow: 'hidden', bgcolor: '#101014' }}
    >
      {rdp ? (
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`Remote desktop ${address}`}
          onKeyDown={(event) => {
            if (rdpRef.current?.key(event.nativeEvent)) event.preventDefault();
          }}
          onKeyUp={(event) => {
            if (rdpRef.current?.key(event.nativeEvent)) event.preventDefault();
          }}
          onMouseMove={(event) => rdpRef.current?.pointerMove(event.nativeEvent)}
          onMouseDown={(event) => {
            canvasRef.current?.focus({ preventScroll: true });
            if (!rdpRef.current) return;
            event.preventDefault();
            rdpRef.current.pointerButton(event.nativeEvent, true);
          }}
          onMouseUp={(event) => rdpRef.current?.pointerButton(event.nativeEvent, false)}
          onContextMenu={(event) => event.preventDefault()}
          onFocus={pushClipboard}
          onBlur={() => rdpRef.current?.releaseAll()}
          style={{
            position: 'absolute',
            left: canvasBox.left,
            top: canvasBox.top,
            width: canvasBox.width,
            height: canvasBox.height,
            cursor,
            outline: 'none',
            visibility: phase === 'connected' ? 'visible' : 'hidden',
          }}
        />
      ) : (
        <Box
          ref={vncTargetRef}
          sx={{
            position: 'absolute',
            inset: 0,
            visibility: phase === 'connected' ? 'visible' : 'hidden',
            '& canvas': { outline: 'none' },
          }}
        />
      )}

      {phase === 'connected' && (
        <>
          <Box
            aria-hidden
            onMouseEnter={() => setToolbarVisible(true)}
            sx={{ position: 'absolute', top: 0, left: '30%', right: '30%', height: 6, zIndex: 2 }}
          />
          <Paper
            elevation={4}
            onMouseEnter={() => setToolbarVisible(true)}
            onMouseLeave={() => setToolbarVisible(false)}
            sx={{
              position: 'absolute',
              top: 6,
              left: '50%',
              transform: `translate(-50%, ${toolbarVisible ? '0' : 'calc(-100% - 8px)'})`,
              opacity: toolbarVisible ? 1 : 0,
              pointerEvents: toolbarVisible ? 'auto' : 'none',
              transition: 'transform 160ms ease, opacity 160ms ease',
              zIndex: 3,
              px: 0.5,
              py: 0.25,
              borderRadius: 999,
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ px: 1, whiteSpace: 'nowrap' }}>
              {profile.kind.toUpperCase()} · {address}
            </Typography>
            {!(current.kind === 'vnc' && current.viewOnly) && (
              <Tooltip title="Send Ctrl+Alt+Del">
                <IconButton
                  size="small"
                  aria-label="Send Ctrl+Alt+Del"
                  onClick={() => {
                    rdpRef.current?.sendCtrlAltDel();
                    vncRef.current?.sendCtrlAltDel();
                    focusDesktop();
                  }}
                >
                  <KeyboardOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            {rdp && (
              <Tooltip title="Send the Windows key">
                <IconButton
                  size="small"
                  aria-label="Send the Windows key"
                  onClick={() => {
                    rdpRef.current?.sendWindowsKey();
                    focusDesktop();
                  }}
                >
                  <WindowOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Reconnect">
              <IconButton size="small" aria-label="Reconnect" onClick={reconnect}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Disconnect">
              <IconButton size="small" aria-label="Disconnect" onClick={disconnect}>
                <LinkOffOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Paper>
        </>
      )}

      {phase !== 'connected' && (
        <Stack
          spacing={2}
          sx={{
            position: 'absolute',
            inset: 0,
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            px: 3,
            color: 'grey.300',
          }}
        >
          {phase === 'connecting' ? (
            <>
              <CircularProgress size={28} color="inherit" />
              <Typography variant="body2">{statusText ?? `Connecting to ${address} …`}</Typography>
              <Button size="small" color="inherit" onClick={disconnect}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <DesktopAccessDisabledOutlinedIcon sx={{ fontSize: 40, opacity: 0.6 }} />
              <Typography variant="body2" sx={{ maxWidth: 520 }}>
                {phase === 'idle' ? `${profile.kind.toUpperCase()} · ${address}` : (endMessage ?? 'Disconnected.')}
              </Typography>
              {redial && (
                <Typography variant="caption" sx={{ opacity: 0.75 }}>
                  Reconnecting in {Math.round(redial.delayMs / 1000)} s (attempt {redial.attempt} of{' '}
                  {AUTO_RECONNECT_DELAYS_MS.length})
                </Typography>
              )}
              <Button variant="contained" size="small" startIcon={<RefreshIcon />} onClick={reconnect}>
                {phase === 'idle' ? 'Connect' : redial ? 'Reconnect now' : 'Reconnect'}
              </Button>
            </>
          )}
        </Stack>
      )}

      <AuthPromptDialog request={authPrompt} onSubmit={answerAuth} />
      <HostKeyDialog request={hostKey} onAnswer={answerHostKey} />
      <DesktopCertificateDialog request={certificate} onAnswer={answerCertificate} />
    </Box>
  );
}
