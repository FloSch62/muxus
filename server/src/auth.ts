import { terminalWebSocketProtocols } from '@muxus/shared/ws-protocol';

/** Authenticate a WebSocket upgrade without putting the bearer token in its URL. */
export function websocketHeaderHasToken(header: unknown, token: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : '';
  const expected = terminalWebSocketProtocols(token)[1]!;
  return raw
    .split(',')
    .map((protocol) => protocol.trim())
    .includes(expected);
}

export interface ServerUrls {
  /** Safe to display and log. */
  publicUrl: string;
  /** Fragment bootstrap for a standalone browser; fragments never reach HTTP servers. */
  browserUrl: string;
}

export function serverUrls(host: string, port: number, token: string): ServerUrls {
  const publicUrl = `http://${host}:${port}/`;
  return {
    publicUrl,
    browserUrl: `${publicUrl}#token=${encodeURIComponent(token)}`,
  };
}
