import type { ConnectionsResponse, ForwardInfo, TunnelInput, TunnelRecord } from '@muxus/shared';
import { ApiError, apiFetch } from './http.js';
import { dialConnection, type DialHandlers } from './dial.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export function saveTunnel(input: TunnelInput): Promise<TunnelRecord> {
  return apiFetch<TunnelRecord>('/api/tunnels', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(input) });
}

export function deleteTunnel(id: string): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(`/api/tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function stopForward(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/forwards/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Adopt a running forward into a saved tunnel without restarting it. */
export function adoptForward(forwardId: string, tunnelId: string): Promise<ForwardInfo> {
  return apiFetch<ForwardInfo>(`/api/forwards/${encodeURIComponent(forwardId)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ tunnelId }),
  });
}

function startForward(connId: string, tunnel: TunnelRecord): Promise<ForwardInfo> {
  return apiFetch<ForwardInfo>('/api/forwards', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      connId,
      tunnelId: tunnel.id,
      type: tunnel.type,
      bindPort: tunnel.bindPort,
      targetHost: tunnel.targetHost,
      targetPort: tunnel.targetPort,
    }),
  });
}

/**
 * Start a saved tunnel: ride an existing live connection to its target when
 * one exists, otherwise dial a shell-less transport (interactive auth via
 * `handlers`). The forward's lease keeps the transport alive on its own —
 * closing terminals never tears a running tunnel down.
 */
export async function startTunnel(tunnel: TunnelRecord, handlers: DialHandlers): Promise<ForwardInfo> {
  const { connections } = await apiFetch<ConnectionsResponse>('/api/connections');
  // A tunnel-owned profile may deliberately use different keys/jumps than a
  // live terminal with the same hostname, so only config-backed tunnels reuse.
  const existing =
    tunnel.sshOptions === undefined
      ? connections.find((conn) => conn.target === tunnel.target)
      : undefined;
  if (existing) {
    try {
      return await startForward(existing.id, tunnel);
    } catch (err) {
      // The listed connection can die between poll and start — fall through
      // to a fresh dial only for that case.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }
  const dialed = await dialConnection(tunnel.target, handlers, tunnel.sshOptions);
  try {
    // The dial lease is released right after; the forward now holds its own.
    return await startForward(dialed.connId, tunnel);
  } finally {
    dialed.close();
  }
}
