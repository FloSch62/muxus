import { useEffect, useState } from 'react';
import type { HostStatsResponse } from '@muxus/shared';
import { hostStatsView, timedSample, type HostStatsView, type TimedSample } from '../host-stats.js';
import { apiFetch } from './http.js';

/** Where a tab's statistics come from. */
export type HostStatsSource = { kind: 'local' } | { kind: 'ssh'; connId: string };

export type HostStatsState =
  | { status: 'loading' }
  /** `stale`: the last reading failed and these values are older. */
  | { status: 'ok'; view: HostStatsView; stale: boolean }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

/** How often the bar refreshes while the window is visible. */
const POLL_MS = 3_000;
/** The second reading comes sooner, so CPU and traffic appear right away. */
const FIRST_RATE_MS = 1_000;
const RETRY_MS = 15_000;
/** Rates over a longer gap (a hidden window, a tab shown again) are not current. */
const MAX_RATE_GAP_SECONDS = 30;

interface CacheEntry {
  state: HostStatsState;
  latest?: TimedSample;
}

/**
 * Readings outlive the bar's attention, so switching back to a tab shows its
 * last values at once. A connection id names one transport, so an entry can
 * never describe a different host.
 */
const cache = new Map<string, CacheEntry>();

function sourceKey(source: HostStatsSource): string {
  return source.kind === 'local' ? 'local' : `ssh:${source.connId}`;
}

function sourcePath(source: HostStatsSource): string {
  return source.kind === 'local'
    ? '/api/host-stats/local'
    : `/api/host-stats/ssh/${encodeURIComponent(source.connId)}`;
}

/** Poll one source while the window is visible; `undefined` stops polling. */
export function useHostStats(source: HostStatsSource | undefined): HostStatsState | undefined {
  const key = source ? sourceKey(source) : undefined;
  const path = source ? sourcePath(source) : undefined;
  const [state, setState] = useState<HostStatsState | undefined>(undefined);

  useEffect(() => {
    if (!key || !path) {
      setState(undefined);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const store = (entry: CacheEntry) => {
      cache.set(key, entry);
      if (!cancelled) setState(entry.state);
    };
    const schedule = (ms: number) => {
      timer = window.setTimeout(tick, ms);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      void tick();
    };

    async function tick() {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') {
        document.addEventListener('visibilitychange', onVisible);
        return;
      }
      const before = cache.get(key!);
      try {
        const response = await apiFetch<HostStatsResponse>(path!);
        if (cancelled) return;
        if (response.status === 'unsupported') {
          store({ state: { status: 'unsupported' } });
          return;
        }
        const current = timedSample(response.sample, response.sampledAt);
        const previous =
          before?.latest && current.at - before.latest.at <= MAX_RATE_GAP_SECONDS
            ? before.latest
            : undefined;
        store({
          state: { status: 'ok', view: hostStatsView(current, previous), stale: false },
          latest: current,
        });
        schedule(previous ? POLL_MS : FIRST_RATE_MS);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        store(
          before?.state.status === 'ok'
            ? { ...before, state: { ...before.state, stale: true } }
            : { state: { status: 'error', message } },
        );
        schedule(RETRY_MS);
      }
    }

    const cached = cache.get(key);
    setState(cached?.state ?? { status: 'loading' });
    // A host that cannot run the probe is not asked again on this connection.
    if (cached?.state.status !== 'unsupported') void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, path]);

  return state;
}
