import type { ApiErrorBody } from '@muxus/shared';
import {
  TERMINAL_SESSION_CLOSE_REASON,
  terminalWebSocketProtocols,
} from '@muxus/shared/ws-protocol';
import { reportAuthInvalid, reportBackendDown, reportBackendUp } from '../state/backend.js';

let token = '';

/** Capture a standalone-browser bootstrap token once, then strip it. */
export function initAuthToken(): void {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  // Query support only migrates old launch URLs. New browser launches use a
  // fragment (never sent to the server); Electron supplies the token over IPC.
  const fromUrl = fragment.get('token') ?? url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem('muxus-token', fromUrl);
    fragment.delete('token');
    url.searchParams.delete('token');
    const nextFragment = fragment.toString();
    url.hash = nextFragment ? `#${nextFragment}` : '';
    window.history.replaceState({}, '', url.toString());
  }
  token = window.muxusDesktop?.authToken ?? sessionStorage.getItem('muxus-token') ?? (import.meta.env.DEV ? 'dev' : '');
}

export function authToken(): string {
  return token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: ApiErrorBody,
  ) {
    super(message);
  }
}

function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

/**
 * Fetch that feeds the global backend-status store: connection failures and
 * 401s are cross-cutting states (server gone / token stale), not per-call
 * errors, so every call site reports them here instead of handling them.
 */
async function statusFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: authHeaders(init?.headers),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    reportBackendDown();
    throw new ApiError(0, 'Cannot reach the Muxus backend');
  }
  reportBackendUp();
  if (res.status === 401) reportAuthInvalid();
  return res;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await statusFetch(path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const err = body as ApiErrorBody | undefined;
    throw new ApiError(res.status, err?.message ?? `${res.status} ${res.statusText}`, body as ApiError['body']);
  }
  return body as T;
}

/** Authenticated fetch returning the raw Response (for blob/stream downloads). */
export async function apiFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const res = await statusFetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, body);
  }
  return res;
}

export function wsUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${proto}//${window.location.host}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Handshake protocols authenticate a WebSocket without leaking into its URL. */
export function wsProtocols(): string[] {
  return terminalWebSocketProtocols(token);
}

/** End a terminal or dial lifecycle instead of leaving it available for reattachment. */
export function closeTerminalWebSocket(socket: WebSocket): void {
  socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
}
