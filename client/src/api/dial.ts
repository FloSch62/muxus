import type { TerminalServerMessage } from '@muxus/shared';
import type { AuthPromptRequest } from '../components/AuthPromptDialog.js';
import type { HostKeyRequest } from '../components/HostKeyDialog.js';
import { wsProtocols, wsUrl } from './http.js';

/** Interactive hooks a shell-less dial needs from the UI. */
export interface DialHandlers {
  onStatus?(message: string): void;
  /** Resolve with answers, or null to cancel the connection attempt. */
  onAuthPrompt(request: AuthPromptRequest): Promise<string[] | null>;
  onHostKey(request: HostKeyRequest): Promise<boolean>;
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
export function dialConnection(target: string, handlers: DialHandlers): Promise<DialedConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl('/ws/terminal'), wsProtocols());
    let settled = false;
    let lastStatus = '';

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
      ws.close();
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'dial', profile: { kind: 'ssh', target } }));
    };
    ws.onerror = () => fail('could not reach the Muxus backend');
    ws.onclose = () => fail(lastStatus || 'connection closed before it was ready');
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
            .onAuthPrompt({ name: msg.name, instructions: msg.instructions, host: msg.host, prompts: msg.prompts })
            .then((answers) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              if (answers === null) ws.close();
              else ws.send(JSON.stringify({ op: 'auth-response', answers }));
            });
          break;
        case 'host-key':
          void handlers.onHostKey(msg).then((accept) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'host-key-response', accept }));
          });
          break;
        case 'ready':
          settled = true;
          resolve({ connId: msg.connId, close: () => ws.close() });
          break;
        case 'exit':
          fail(msg.message || lastStatus || 'connection failed');
          break;
      }
    };
  });
}
