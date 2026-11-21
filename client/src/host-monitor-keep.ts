import { create } from 'zustand';
import { dialProfile, type DialedConnection, type DialHandlers } from './api/dial.js';
import type { EnvironmentHost } from './state/environments.js';

/**
 * Hosts the monitor keeps a connection to, so they have a row without a
 * session being open. Muxus connects to nothing for the monitor unless the
 * host is on this list, and only while a monitor is open in the window.
 *
 * Connecting never asks: a host that wants a password, a code or a host key
 * answer waits as "sign-in needed" until the user connects it by hand.
 */

export type KeptHostStatus =
  | 'connecting'
  | 'connected'
  /** The login needs the user: a password, a second factor, an unknown host key. */
  | 'sign-in'
  /** The dial failed or the connection dropped; it is tried again by itself. */
  | 'failed';

export interface KeptHostState {
  status: KeptHostStatus;
  /** The connection the monitor holds, once it is up. */
  connId?: string;
  message?: string;
}

interface KeptHostsStore {
  /** By host key. */
  hosts: Record<string, KeptHostState>;
}

export const useKeptHostsStore = create<KeptHostsStore>()(() => ({ hosts: {} }));

/** Waits before each redial; the last one repeats. */
export const KEPT_HOST_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000];

interface Kept {
  host: EnvironmentHost;
  dial?: DialedConnection;
  abort?: AbortController;
  retry?: number;
  /** Failed dials in a row. */
  attempts: number;
}

const kept = new Map<string, Kept>();

function setState(key: string, state: KeptHostState | undefined): void {
  useKeptHostsStore.setState((store) => {
    const { [key]: _removed, ...rest } = store.hosts;
    return { hosts: state ? { ...rest, [key]: state } : rest };
  });
}

function scheduleRetry(entry: Kept): void {
  const delay = KEPT_HOST_RETRY_DELAYS_MS[Math.min(entry.attempts, KEPT_HOST_RETRY_DELAYS_MS.length) - 1] ?? 0;
  window.clearTimeout(entry.retry);
  entry.retry = window.setTimeout(() => void connect(entry), delay);
}

/** Dial one host. Without `handlers` nobody is asked anything. */
async function connect(entry: Kept, handlers?: DialHandlers): Promise<void> {
  const { host } = entry;
  if (!host.profile) return;
  window.clearTimeout(entry.retry);
  entry.retry = undefined;
  entry.abort?.abort();
  entry.dial?.close();
  entry.dial = undefined;
  const abort = new AbortController();
  entry.abort = abort;
  const current = () => kept.get(host.key) === entry && entry.abort === abort;
  let needsUser = false;
  setState(host.key, { status: 'connecting' });
  try {
    const dial = await dialProfile(
      host.profile,
      {
        onStatus: (message) => handlers?.onStatus?.(message),
        onAuthPrompt: (request) => {
          if (handlers) return handlers.onAuthPrompt(request);
          needsUser = true;
          return Promise.resolve(null);
        },
        onHostKey: (request) => {
          if (handlers) return handlers.onHostKey(request);
          needsUser = true;
          return Promise.resolve(false);
        },
        onClosed: (reason) => {
          if (!current()) return;
          entry.dial = undefined;
          entry.attempts += 1;
          setState(host.key, { status: 'failed', message: reason ?? 'The connection was lost.' });
          scheduleRetry(entry);
        },
      },
      abort.signal,
    );
    if (!current()) {
      dial.close();
      return;
    }
    entry.dial = dial;
    entry.attempts = 0;
    setState(host.key, { status: 'connected', connId: dial.connId });
  } catch (error) {
    if (!current()) return;
    if (needsUser) {
      setState(host.key, { status: 'sign-in', message: 'Sign-in needed' });
      return;
    }
    entry.attempts += 1;
    setState(host.key, { status: 'failed', message: error instanceof Error ? error.message : String(error) });
    // A cancelled prompt is the user's answer, not a failure to try again.
    if (!handlers) scheduleRetry(entry);
  }
}

function release(entry: Kept): void {
  window.clearTimeout(entry.retry);
  entry.abort?.abort();
  entry.dial?.close();
  kept.delete(entry.host.key);
  setState(entry.host.key, undefined);
}

/**
 * Hold a connection to exactly these hosts: dial the new ones, let go of the
 * ones that left the list. A host already connected through a session shares
 * that connection, so nothing is dialed twice.
 */
export function syncKeptHosts(hosts: readonly EnvironmentHost[]): void {
  const wanted = new Map(hosts.filter((host) => host.profile && !host.systemOpenSsh).map((host) => [host.key, host]));
  for (const entry of kept.values()) {
    if (!wanted.has(entry.host.key)) release(entry);
  }
  for (const host of wanted.values()) {
    const known = kept.get(host.key);
    if (known) {
      // Its label or colour may have changed; the connection is the same.
      known.host = host;
      continue;
    }
    const entry: Kept = { host, attempts: 0 };
    kept.set(host.key, entry);
    void connect(entry);
  }
}

/** Let go of every connection the monitor holds: it closed. */
export function releaseKeptHosts(): void {
  for (const entry of kept.values()) release(entry);
}

/** Connect a host by hand, answering its prompts through `handlers`. */
export function connectKeptHost(key: string, handlers: DialHandlers): Promise<void> {
  const entry = kept.get(key);
  return entry ? connect(entry, handlers) : Promise.resolve();
}
