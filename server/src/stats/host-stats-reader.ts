import type { HostStatsSample } from '@muxus/shared';
import type { ConnectionLease } from '../ssh/connection-manager.js';
import type { SystemOpenSshLease } from '../ssh/system-openssh.js';
import { HttpProblem } from '../util/errors.js';
import {
  hostStatsScript,
  readHostStatsWith,
  readLocalHostStats,
  readRemoteHostStats,
  type HostStatsDetail,
  type HostStatsReading,
} from './host-stats.js';

/** What asking a host for its statistics came to. */
export type HostStatsOutcome =
  | { status: 'ok'; sample: HostStatsSample; latencyMs?: number }
  /**
   * Not asked: the server on this connection never ran a command for Muxus.
   * Some network devices drop the whole connection when a second channel
   * asks to run one, so only an explicit request reaches such a host.
   */
  | { status: 'idle' }
  /** Asked, and no POSIX shell answered. It is not asked again on this connection. */
  | { status: 'unsupported' }
  /** A host that runs commands said nothing in time: busy, not unable. */
  | { status: 'timeout' };

export interface HostStatsRequest extends HostStatsDetail {
  /**
   * The user asked for this host by name, so it is read even though no
   * command ran on the connection yet. A connection whose shell already
   * showed that the host runs none is still left alone.
   */
  force?: boolean;
}

export interface HostStatsReaderSources {
  acquire(connId: string): ConnectionLease | undefined;
  acquireSystem(connId: string): SystemOpenSshLease | undefined;
}

/** Who and where a connection goes, the same for the next connection to that host. */
function hostIdentity(connection: ConnectionLease['connection']): string {
  return `${connection.profile.profileId ?? ''}\n${connection.user}@${connection.host}:${connection.port}`;
}

interface Pending {
  rank: number;
  reading: Promise<HostStatsOutcome>;
}

/** A richer reading answers a plainer request too, never the other way round. */
function detailRank(detail: HostStatsDetail): number {
  return (detail.diskIo ? 1 : 0) + (detail.gpu ? 2 : 0);
}

function covers(have: number, want: number): boolean {
  return (have & want) === want;
}

/**
 * Reads host statistics for everything that shows them: the status bar and
 * the monitor. Readers asking about the same host at the same moment share
 * one script run, and so one exec channel, instead of opening one each.
 */
export class HostStatsReader {
  private readonly inFlight = new Map<string, Pending[]>();
  /** Connections that answered without the script's markers. */
  private readonly unsupported = new Set<string>();
  /**
   * Hosts that closed the connection when asked by name, by who and where
   * they are. A connection dialed again for the same host is not asked again.
   */
  private readonly refused = new Set<string>();

  constructor(
    private readonly sources: HostStatsReaderSources,
    private readonly readLocal: (script: string) => Promise<HostStatsSample> = readLocalHostStats,
  ) {}

  /** The computer running the Muxus backend. */
  local(detail: HostStatsDetail = {}): Promise<HostStatsOutcome> {
    return this.shared('local', detail, async () => ({
      status: 'ok',
      sample: await this.readLocal(hostStatsScript(detail)),
    }));
  }

  /**
   * The far end of a live connection. Rejects with a 404 problem when the
   * connection is gone, and with the channel's own error when the host
   * refuses to open one.
   */
  ssh(connId: string, request: HostStatsRequest = {}): Promise<HostStatsOutcome> {
    if (this.unsupported.has(connId)) return Promise.resolve({ status: 'unsupported' });
    // A forced reading is not shared with one that may have skipped the host.
    const key = `ssh:${connId}${request.force ? ':force' : ''}`;
    return this.shared(key, request, () => this.readSsh(connId, request));
  }

  /**
   * Forget that a host could not answer, because the user asked for it again.
   * The next reading on this connection asks the host once more.
   */
  retry(connId: string): void {
    this.unsupported.delete(connId);
    const lease = this.sources.acquire(connId);
    if (!lease) return;
    this.refused.delete(hostIdentity(lease.connection));
    lease.release();
  }

  private shared(
    key: string,
    detail: HostStatsDetail,
    read: () => Promise<HostStatsOutcome>,
  ): Promise<HostStatsOutcome> {
    const rank = detailRank(detail);
    const pending = this.inFlight.get(key) ?? [];
    const running = pending.find((entry) => covers(entry.rank, rank));
    if (running) return running.reading;
    const entry: Pending = {
      rank,
      reading: read().finally(() => {
        const left = (this.inFlight.get(key) ?? []).filter((candidate) => candidate !== entry);
        if (left.length > 0) this.inFlight.set(key, left);
        else this.inFlight.delete(key);
      }),
    };
    this.inFlight.set(key, [...pending, entry]);
    return entry.reading;
  }

  private async readSsh(connId: string, request: HostStatsRequest): Promise<HostStatsOutcome> {
    const script = hostStatsScript(request);
    const system = this.sources.acquireSystem(connId);
    if (system) {
      try {
        if (!(await system.connection.runsCommands())) return { status: 'idle' };
        const startedAt = performance.now();
        const reading = await readHostStatsWith(system.connection.runScript, script);
        // Only the whole run can be timed here: `ssh` starts and ends inside it.
        return this.outcome(system.connection, reading, performance.now() - startedAt);
      } finally {
        system.release();
      }
    }
    const lease = this.sources.acquire(connId);
    if (!lease) throw new HttpProblem(404, 'connection not found');
    try {
      const { connection } = lease;
      if (connection.ranCommand()) {
        const reading = await readRemoteHostStats(connection.transport, script);
        if (!reading.supported && reading.timedOut) return { status: 'timeout' };
        return this.outcome(connection, reading);
      }
      const identity = hostIdentity(connection);
      if (connection.commandsDeclined() || this.refused.has(identity)) return { status: 'unsupported' };
      if (!request.force) return { status: 'idle' };
      // Nothing is known about this host yet, and one reading tells. Whatever
      // goes wrong, it is not tried again: not on this connection, and not on
      // the next one to the same host.
      try {
        const reading = await readRemoteHostStats(connection.transport, script);
        if (!reading.supported) this.refused.add(identity);
        return this.outcome(connection, reading);
      } catch (error) {
        this.refused.add(identity);
        throw error;
      }
    } finally {
      lease.release();
    }
  }

  private outcome(
    connection: { id: string; onClose(listener: () => void): () => void },
    reading: HostStatsReading,
    latencyMs?: number,
  ): HostStatsOutcome {
    if (!reading.supported) {
      if (!this.unsupported.has(connection.id)) {
        this.unsupported.add(connection.id);
        connection.onClose(() => this.unsupported.delete(connection.id));
      }
      return { status: 'unsupported' };
    }
    const latency = reading.latencyMs ?? latencyMs;
    return {
      status: 'ok',
      sample: reading.sample,
      ...(latency !== undefined ? { latencyMs: Math.round(latency) } : {}),
    };
  }
}

/** The reader over an app's live connections, each reading under a lease of its own. */
export function hostStatsReaderFor(ctx: {
  connections: { acquire(connId: string, owner: 'stats'): ConnectionLease | undefined };
  systemOpenSsh: { acquire(connId: string): SystemOpenSshLease | undefined };
}): HostStatsReader {
  return new HostStatsReader({
    acquire: (connId) => ctx.connections.acquire(connId, 'stats'),
    acquireSystem: (connId) => ctx.systemOpenSsh.acquire(connId),
  });
}
