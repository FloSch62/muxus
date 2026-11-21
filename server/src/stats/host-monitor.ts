import {
  DEFAULT_HOST_MONITOR_INTERVAL_MS,
  LOCAL_MONITOR_HOST_ID,
  type ConnectionInfo,
  type HostMonitorServerMessage,
  type MonitoredHost,
  type SshProfile,
} from '@muxus/shared';
import { HttpProblem } from '../util/errors.js';
import type { HostStatsOutcome, HostStatsReader } from './host-stats-reader.js';

/** The fastest and the slowest a client may ask hosts to be read. */
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 300_000;
/** How often the loop looks for hosts that are due, and for new connections. */
const TICK_MS = 1_000;
/** A host's second reading comes sooner, so its rates appear right away. */
const FIRST_RATE_MS = 1_000;
/** Waits after one, two, three… failed readings in a row; the last one repeats. */
export const MONITOR_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000];
/** Hosts read at the same moment by one monitor; the rest wait for the next tick. */
const MAX_CONCURRENT_READINGS = 8;

export interface HostMonitorSources {
  /** Live transports of the built-in client. */
  connections(): ConnectionInfo[];
  /** Running sessions of the computer's `ssh` program. */
  systemSessions(): Array<{ id: string; profile: SshProfile }>;
}

/**
 * Every host Muxus is connected to, one row each: tabs, split panes and
 * transports to the same place are one host. This computer comes first.
 */
export function monitorRoster(sources: HostMonitorSources): MonitoredHost[] {
  const hosts = new Map<string, MonitoredHost>();
  hosts.set(LOCAL_MONITOR_HOST_ID, { id: LOCAL_MONITOR_HOST_ID, kind: 'local', connIds: [] });
  for (const conn of sources.connections()) {
    const id = `ssh:${conn.profileId ?? ''}:${conn.user}@${conn.host}:${conn.port}`;
    const known = hosts.get(id);
    if (known) {
      known.connIds.push(conn.id);
      continue;
    }
    hosts.set(id, {
      id,
      kind: 'ssh',
      connIds: [conn.id],
      target: conn.target,
      ...(conn.profileId ? { profileId: conn.profileId } : {}),
      ...(conn.useConfig === false ? { useConfig: false } : {}),
      host: conn.host,
      port: conn.port,
      user: conn.user,
    });
  }
  for (const session of sources.systemSessions()) {
    const { profile } = session;
    // `ssh` resolves the address itself, so the dialed name is all there is.
    const id = `system-ssh:${profile.profileId ?? ''}:${profile.user ?? ''}@${profile.target}:${profile.port ?? ''}`;
    const known = hosts.get(id);
    if (known) {
      known.connIds.push(session.id);
      continue;
    }
    hosts.set(id, {
      id,
      kind: 'ssh',
      connIds: [session.id],
      target: profile.target,
      ...(profile.profileId ? { profileId: profile.profileId } : {}),
      ...(profile.useConfig === false ? { useConfig: false } : {}),
      ...(profile.user ? { user: profile.user } : {}),
      ...(profile.port ? { port: profile.port } : {}),
      systemOpenSsh: true,
    });
  }
  return [...hosts.values()];
}

interface HostProgress {
  /** Not read before this time. */
  dueAt: number;
  /** Readings that succeeded since the row appeared. */
  readings: number;
  /** Failed readings in a row. */
  failures: number;
  busy: boolean;
  /** The set of connections that was given up on; a new one is asked again. */
  gaveUpOn?: string;
}

export interface HostMonitorOptions {
  intervalMs: number;
  gpu: boolean;
  force: ReadonlySet<string>;
}

export interface MonitorClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}

const SYSTEM_CLOCK: MonitorClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => {
    const timer = setInterval(callback, ms);
    timer.unref();
    return timer;
  },
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

function clampInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return DEFAULT_HOST_MONITOR_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)));
}

/** Which of two outcomes of one host says more, when none of them is a reading. */
const OUTCOME_WEIGHT: Record<HostStatsOutcome['status'], number> = {
  ok: 3,
  timeout: 2,
  idle: 1,
  unsupported: 0,
};

/**
 * One monitor window's loop. While it runs it reads every connected host on
 * its interval over the connection that is already there, and sends each
 * reading as it arrives, so a slow host holds nobody else up. It opens no
 * connection of its own and stops asking a host that cannot answer.
 */
export class HostMonitorSession {
  private options: HostMonitorOptions | undefined;
  private timer: unknown;
  private closed = false;
  private inFlight = 0;
  private roster = '';
  private readonly progress = new Map<string, HostProgress>();

  constructor(
    private readonly reader: HostStatsReader,
    private readonly sources: HostMonitorSources,
    private readonly send: (message: HostMonitorServerMessage) => void,
    private readonly clock: MonitorClock = SYSTEM_CLOCK,
  ) {}

  /** Start watching, or change how. Hosts are read at once after a change. */
  watch(request: { intervalMs: number; gpu?: boolean; force?: readonly string[] }): void {
    if (this.closed) return;
    const previous = this.options;
    const next: HostMonitorOptions = {
      intervalMs: clampInterval(request.intervalMs),
      gpu: request.gpu === true,
      force: new Set(request.force ?? []),
    };
    this.options = next;
    const now = this.clock.now();
    const forceChanged =
      !previous ||
      previous.force.size !== next.force.size ||
      [...next.force].some((connId) => !previous.force.has(connId));
    for (const state of this.progress.values()) {
      // A shorter interval, a newly asked-for host or another column applies now.
      if (forceChanged || previous?.gpu !== next.gpu) state.dueAt = Math.min(state.dueAt, now);
      else state.dueAt = Math.min(state.dueAt, now + next.intervalMs);
    }
    this.timer ??= this.clock.setInterval(() => this.tick(), TICK_MS);
    // The roster goes out again in full: the client may have just (re)connected.
    this.roster = '';
    this.tick();
  }

  /** Ask a host again that was given up on, because the user said so. */
  retry(id: string): void {
    const host = monitorRoster(this.sources).find((candidate) => candidate.id === id);
    if (!host) return;
    for (const connId of host.connIds) this.reader.retry(connId);
    const state = this.progress.get(id);
    if (state) {
      state.gaveUpOn = undefined;
      state.failures = 0;
      state.dueAt = 0;
    }
    this.tick();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) this.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.progress.clear();
  }

  private tick(): void {
    if (this.closed || !this.options) return;
    const hosts = monitorRoster(this.sources);
    const roster = JSON.stringify(hosts);
    if (roster !== this.roster) {
      this.roster = roster;
      this.send({ op: 'hosts', hosts });
      const present = new Set(hosts.map((host) => host.id));
      for (const id of this.progress.keys()) {
        if (!present.has(id)) this.progress.delete(id);
      }
    }
    const now = this.clock.now();
    for (const host of hosts) {
      if (this.inFlight >= MAX_CONCURRENT_READINGS) break;
      let state = this.progress.get(host.id);
      if (!state) {
        state = { dueAt: 0, readings: 0, failures: 0, busy: false };
        this.progress.set(host.id, state);
      }
      if (state.busy || now < state.dueAt) continue;
      if (state.gaveUpOn !== undefined && state.gaveUpOn === host.connIds.join(',')) continue;
      void this.read(host, state, this.options);
    }
  }

  private async read(host: MonitoredHost, state: HostProgress, options: HostMonitorOptions): Promise<void> {
    state.busy = true;
    this.inFlight += 1;
    let outcome: HostStatsOutcome | undefined;
    let failure: unknown;
    try {
      outcome = await this.readHost(host, options);
    } catch (error) {
      failure = error;
    } finally {
      state.busy = false;
      this.inFlight -= 1;
    }
    // The window closed, or the host left the roster, while it was being read.
    if (this.closed || this.progress.get(host.id) !== state) return;
    const now = this.clock.now();
    const interval = this.options?.intervalMs ?? options.intervalMs;
    if (outcome?.status === 'ok') {
      state.readings += 1;
      state.failures = 0;
      state.gaveUpOn = undefined;
      state.dueAt = now + (state.readings === 1 ? Math.min(FIRST_RATE_MS, interval) : interval);
      this.send({
        op: 'sample',
        id: host.id,
        sampledAt: now,
        sample: outcome.sample,
        ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
      });
      return;
    }
    if (outcome?.status === 'idle') {
      // Nothing was asked, so looking again costs nothing: a shell opened
      // meanwhile makes the host readable.
      state.dueAt = now + interval;
      this.send({ op: 'state', id: host.id, state: 'idle' });
      return;
    }
    if (outcome?.status === 'unsupported') {
      state.gaveUpOn = host.connIds.join(',');
      this.send({ op: 'state', id: host.id, state: 'unsupported' });
      return;
    }
    state.failures += 1;
    const delay = MONITOR_RETRY_DELAYS_MS[Math.min(state.failures, MONITOR_RETRY_DELAYS_MS.length) - 1]!;
    state.dueAt = now + Math.max(delay, interval);
    this.send({
      op: 'state',
      id: host.id,
      state: 'error',
      message:
        outcome?.status === 'timeout'
          ? 'The host did not answer in time.'
          : failure instanceof Error
            ? failure.message
            : String(failure),
    });
  }

  /** Ask the host over each of its connections until one answers. */
  private async readHost(host: MonitoredHost, options: HostMonitorOptions): Promise<HostStatsOutcome> {
    const detail = { diskIo: true, gpu: options.gpu };
    if (host.kind === 'local') return this.reader.local(detail);
    let best: HostStatsOutcome | undefined;
    let failure: unknown;
    for (const connId of host.connIds) {
      try {
        const outcome = await this.reader.ssh(connId, { ...detail, force: options.force.has(connId) });
        if (outcome.status === 'ok') return outcome;
        if (!best || OUTCOME_WEIGHT[outcome.status] > OUTCOME_WEIGHT[best.status]) best = outcome;
      } catch (error) {
        // A connection that closed a moment ago is simply gone from the next roster.
        if (error instanceof HttpProblem && error.status === 404) continue;
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return best ?? { status: 'idle' };
  }
}
