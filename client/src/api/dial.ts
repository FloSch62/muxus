import type { SshProfile, TerminalServerMessage, TunnelSshOptions } from '@muxus/shared';
import type {
  AuthPromptRequest,
  AuthPromptResult,
} from '../components/AuthPromptDialog.js';
import type { HostKeyRequest } from '../components/HostKeyDialog.js';
import { sshKeepalivePrefField } from '../state/prefs.js';
import { closeTerminalWebSocket, wsProtocols, wsUrl } from './http.js';

/** Interactive hooks a shell-less dial needs from the UI. */
export interface DialHandlers {
  onStatus?(message: string): void;
  /** Resolve with answers and prompt options, or null to cancel the connection attempt. */
  onAuthPrompt(request: AuthPromptRequest): Promise<AuthPromptResult | null>;
  onHostKey(request: HostKeyRequest): Promise<boolean>;
  /**
   * The transport went away after the dial succeeded, with the server's
   * reason when it gave one. Not called after {@link DialedConnection.close}.
   */
  onClosed?(reason?: string): void;
}

export interface DialedConnection {
  connId: string;
  /**
   * Release the dial lease. Call after follow-up consumers (forwards) hold
   * their own leases — or on failure, so the transport tears down.
   */
  close(): void;
}

/**
 * Establish an SSH transport with no terminal attached (the tunnel-start
 * path). Runs the same interactive auth/host-key round-trips as a terminal
 * connection over a dedicated /ws/terminal socket in `dial` mode.
 */
export function dialConnection(
  target: string,
  handlers: DialHandlers,
  sshOptions?: TunnelSshOptions,
): Promise<DialedConnection> {
  return dialProfile(
    {
      kind: 'ssh',
      target,
      ...(sshOptions === undefined ? {} : { useConfig: false, ...sshOptions }),
    },
    handlers,
  );
}

/**
 * {@link dialConnection} for a whole profile, such as a saved host's
 * `{ target, profileId }`. Aborting `signal` gives up on a dial still in
 * progress, prompts included.
 */
export function dialProfile(
  profile: SshProfile,
  handlers: DialHandlers,
  signal?: AbortSignal,
): Promise<DialedConnection> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const ws = new WebSocket(wsUrl('/ws/terminal'), wsProtocols());
    let settled = false;
    let ready = false;
    let released = false;
    let lastStatus = '';
    let exitMessage: string | undefined;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(message));
      closeTerminalWebSocket(ws);
    };
    const onAbort = () => fail('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          op: 'dial',
          profile: { ...profile, ...sshKeepalivePrefField() },
        }),
      );
    };
    ws.onerror = () => fail('could not reach the Muxus backend');
    ws.onclose = () => {
      if (ready) {
        if (!released) handlers.onClosed?.(exitMessage);
        return;
      }
      fail(lastStatus || 'connection closed before it was ready');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: TerminalServerMessage;
      try {
        msg = JSON.parse(ev.data) as TerminalServerMessage;
      } catch {
        return;
      }
      switch (msg.op) {
        case 'status':
          lastStatus = msg.message;
          handlers.onStatus?.(msg.message);
          break;
        case 'auth-prompt':
          void handlers
            .onAuthPrompt({
              name: msg.name,
              instructions: msg.instructions,
              host: msg.host,
              prompts: msg.prompts,
              purpose: msg.purpose,
              rememberPassword: msg.rememberPassword,
              skipLabel: msg.skipLabel,
            })
            .then((response) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              if (response === null) closeTerminalWebSocket(ws);
              else ws.send(JSON.stringify({ op: 'auth-response', ...response }));
            });
          break;
        case 'host-key':
          void handlers.onHostKey(msg).then((accept) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'host-key-response', accept }));
          });
          break;
        case 'ready':
          settled = true;
          ready = true;
          signal?.removeEventListener('abort', onAbort);
          resolve({
            connId: msg.connId,
            close: () => {
              released = true;
              closeTerminalWebSocket(ws);
            },
          });
          break;
        case 'exit':
          exitMessage = msg.message || undefined;
          fail(msg.message || lastStatus || 'connection failed');
          break;
      }
    };
  });
}
