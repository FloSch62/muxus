import { describe, expect, it, vi } from 'vitest';
import type { ConnectionInfo, HostMonitorServerMessage, SshProfile } from '@muxus/shared';
import {
  HostMonitorSession,
  MONITOR_RETRY_DELAYS_MS,
  monitorRoster,
  type HostMonitorSources,
  type MonitorClock,
} from '../../../server/src/stats/host-monitor.js';
import type { HostStatsOutcome, HostStatsReader } from '../../../server/src/stats/host-stats-reader.js';
import { HttpProblem } from '../../../server/src/util/errors.js';

function connection(id: string, target: string, overrides: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return { id, target, host: `${target}.example.net`, port: 22, user: 'deploy', sftpAvailable: true, ...overrides };
}

function sourcesOf(
  connections: ConnectionInfo[],
  systemSessions: Array<{ id: string; profile: SshProfile }> = [],
): HostMonitorSources {
  return { connections: () => connections, systemSessions: () => systemSessions };
}

describe('the monitor roster', () => {
  it('lists this computer first and one row per host, whatever the number of connections', () => {
    const hosts = monitorRoster(
      sourcesOf([
        connection('c1', 'web-01'),
        connection('c2', 'db-01', { profileId: 'p-db', useConfig: false }),
        // A second transport to the same place, such as a forced reconnect's replacement.
        connection('c3', 'web-01'),
      ]),
    );
    expect(hosts.map((host) => [host.id, host.connIds])).toEqual([
      ['local', []],
      ['ssh::deploy@web-01.example.net:22', ['c1', 'c3']],
      ['ssh:p-db:deploy@db-01.example.net:22', ['c2']],
    ]);
    expect(hosts[2]).toMatchObject({ kind: 'ssh', target: 'db-01', profileId: 'p-db', useConfig: false });
  });

  it('keeps two users of one machine apart', () => {
    const hosts = monitorRoster(
      sourcesOf([connection('c1', 'web-01'), connection('c2', 'root@web-01', { host: 'web-01.example.net', user: 'root' })]),
    );
    expect(hosts.filter((host) => host.kind === 'ssh')).toHaveLength(2);
  });

  it('gives the tabs of one system OpenSSH host a single row', () => {
    const profile: SshProfile = { kind: 'ssh', target: 'legacy' };
    const hosts = monitorRoster(
      sourcesOf(
        [],
        [
          { id: 'system-ssh-1', profile },
          { id: 'system-ssh-2', profile },
        ],
      ),
    );
    expect(hosts[1]).toMatchObject({ target: 'legacy', systemOpenSsh: true, connIds: ['system-ssh-1', 'system-ssh-2'] });
  });
});

/** A clock the test moves by hand; the session's ticker runs when it is told to. */
function manualClock() {
  let now = 1_000_000;
  let tick: (() => void) | undefined;
  const clock: MonitorClock = {
    now: () => now,
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = undefined;
    },
  };
  return {
    clock,
    /** Move time on and let the ticker and every reading it started finish. */
    advance: async (ms: number) => {
      now += ms;
      tick?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    running: () => tick !== undefined,
  };
}

type SshReader = (connId: string, request: { force?: boolean; gpu?: boolean; diskIo?: boolean }) => Promise<HostStatsOutcome>;

function sessionFor(ssh: SshReader, sources: HostMonitorSources) {
  const sent: HostMonitorServerMessage[] = [];
  const time = manualClock();
  const reader = {
    local: vi.fn(async () => ({ status: 'ok', sample: { hostname: 'laptop' } }) as HostStatsOutcome),
    ssh: vi.fn(ssh),
    retry: vi.fn(),
  };
  const session = new HostMonitorSession(reader as unknown as HostStatsReader, sources, (message) => sent.push(message), time.clock);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const of = <T extends HostMonitorServerMessage['op']>(op: T) =>
    sent.filter((message): message is Extract<HostMonitorServerMessage, { op: T }> => message.op === op);
  return { session, reader, sent, time, settle, of };
}

const OK: HostStatsOutcome = { status: 'ok', sample: { hostname: 'web-01' }, latencyMs: 12 };
const WEB = 'ssh::deploy@web-01.example.net:22';

describe('a monitor session', () => {
  it('reads nothing until the window says how often', async () => {
    const { reader, sent, time } = sessionFor(async () => OK, sourcesOf([connection('c1', 'web-01')]));
    await time.advance(5_000);
    expect(sent).toEqual([]);
    expect(reader.ssh).not.toHaveBeenCalled();
    expect(time.running()).toBe(false);
  });

  it('sends the roster, then each host as it answers, with disk counters asked for', async () => {
    const { session, reader, settle, of } = sessionFor(async () => OK, sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 5_000 });
    await settle();
    expect(of('hosts')[0]!.hosts.map((host) => host.id)).toEqual(['local', WEB]);
    expect(of('sample').map((message) => message.id).sort()).toEqual([WEB, 'local'].sort());
    expect(of('sample').find((message) => message.id === WEB)).toMatchObject({ latencyMs: 12, sample: { hostname: 'web-01' } });
    expect(reader.ssh).toHaveBeenCalledWith('c1', { diskIo: true, gpu: false, force: false });
    expect(reader.local).toHaveBeenCalledWith({ diskIo: true, gpu: false });
  });

  it('reads a host again a second after its first reading, then on the interval', async () => {
    const { session, reader, time, settle } = sessionFor(async () => OK, sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 10_000 });
    await settle();
    expect(reader.ssh).toHaveBeenCalledTimes(1);
    await time.advance(1_000);
    expect(reader.ssh).toHaveBeenCalledTimes(2);
    await time.advance(5_000);
    expect(reader.ssh).toHaveBeenCalledTimes(2);
    await time.advance(5_000);
    expect(reader.ssh).toHaveBeenCalledTimes(3);
  });

  it('does not start a second reading of a host that has not answered yet', async () => {
    let answer!: (outcome: HostStatsOutcome) => void;
    const slow = new Promise<HostStatsOutcome>((resolve) => (answer = resolve));
    const { session, reader, time, settle } = sessionFor(() => slow, sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 2_000 });
    await settle();
    await time.advance(2_000);
    await time.advance(2_000);
    expect(reader.ssh).toHaveBeenCalledTimes(1);
    answer(OK);
    await settle();
  });

  it('reports a host that was not asked, and looks again without opening anything', async () => {
    const { session, reader, time, settle, of } = sessionFor(async () => ({ status: 'idle' }), sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 5_000 });
    await settle();
    expect(of('state')).toEqual([{ op: 'state', id: WEB, state: 'idle' }]);
    await time.advance(5_000);
    expect(reader.ssh).toHaveBeenCalledTimes(2);
  });

  it('reads a host the window asks for by name, at once', async () => {
    const { session, reader, settle, of } = sessionFor(
      async (_connId, request) => (request.force ? OK : { status: 'idle' }),
      sourcesOf([connection('c1', 'web-01')]),
    );
    session.watch({ intervalMs: 60_000 });
    await settle();
    expect(of('sample').some((message) => message.id === WEB)).toBe(false);
    session.watch({ intervalMs: 60_000, force: ['c1'] });
    await settle();
    expect(reader.ssh).toHaveBeenLastCalledWith('c1', { diskIo: true, gpu: false, force: true });
    expect(of('sample').some((message) => message.id === WEB)).toBe(true);
  });

  it('gives up on a host that cannot answer until it has another connection', async () => {
    const connections = [connection('c1', 'web-01')];
    const { session, reader, time, settle, of } = sessionFor(async () => ({ status: 'unsupported' }), sourcesOf(connections));
    session.watch({ intervalMs: 2_000 });
    await settle();
    expect(of('state')).toEqual([{ op: 'state', id: WEB, state: 'unsupported' }]);
    await time.advance(2_000);
    await time.advance(60_000);
    expect(reader.ssh).toHaveBeenCalledTimes(1);
    // A reconnect gives the host another connection: that one is asked.
    connections[0] = connection('c9', 'web-01');
    await time.advance(2_000);
    expect(reader.ssh).toHaveBeenLastCalledWith('c9', expect.anything());
  });

  it('asks a host again that was given up on when the user says so', async () => {
    const { session, reader, settle } = sessionFor(async () => ({ status: 'unsupported' }), sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 2_000 });
    await settle();
    session.retry(WEB);
    await settle();
    expect(reader.retry).toHaveBeenCalledWith('c1');
    expect(reader.ssh).toHaveBeenCalledTimes(2);
  });

  it('waits longer after each failed reading and says why', async () => {
    const { session, reader, time, settle, of } = sessionFor(
      async () => {
        throw new Error('Channel open failure');
      },
      sourcesOf([connection('c1', 'web-01')]),
    );
    session.watch({ intervalMs: 2_000 });
    await settle();
    expect(of('state')).toEqual([{ op: 'state', id: WEB, state: 'error', message: 'Channel open failure' }]);
    await time.advance(MONITOR_RETRY_DELAYS_MS[0]! - 1_000);
    expect(reader.ssh).toHaveBeenCalledTimes(1);
    await time.advance(1_000);
    expect(reader.ssh).toHaveBeenCalledTimes(2);
    await time.advance(MONITOR_RETRY_DELAYS_MS[0]!);
    expect(reader.ssh).toHaveBeenCalledTimes(2);
    await time.advance(MONITOR_RETRY_DELAYS_MS[1]! - MONITOR_RETRY_DELAYS_MS[0]!);
    expect(reader.ssh).toHaveBeenCalledTimes(3);
  });

  it('treats a host that answered too late as a failed reading, not as unable', async () => {
    const { session, settle, of } = sessionFor(async () => ({ status: 'timeout' }), sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 2_000 });
    await settle();
    expect(of('state')).toEqual([{ op: 'state', id: WEB, state: 'error', message: 'The host did not answer in time.' }]);
  });

  it('tries the next connection of a host when one cannot be read', async () => {
    const { session, reader, settle, of } = sessionFor(
      async (connId) => (connId === 'c1' ? { status: 'idle' } : OK),
      sourcesOf([connection('c1', 'web-01'), connection('c2', 'web-01')]),
    );
    session.watch({ intervalMs: 5_000 });
    await settle();
    expect(reader.ssh.mock.calls.map((call) => call[0])).toEqual(['c1', 'c2']);
    expect(of('sample').some((message) => message.id === WEB)).toBe(true);
    expect(of('state')).toEqual([]);
  });

  it('says nothing about a connection that closed between the roster and the reading', async () => {
    const { session, settle, of } = sessionFor(
      async () => {
        throw new HttpProblem(404, 'connection not found');
      },
      sourcesOf([connection('c1', 'web-01')]),
    );
    session.watch({ intervalMs: 5_000 });
    await settle();
    expect(of('state')).toEqual([{ op: 'state', id: WEB, state: 'idle' }]);
  });

  it('sends the roster again only when it changed', async () => {
    const connections = [connection('c1', 'web-01')];
    const { session, time, settle, of } = sessionFor(async () => OK, sourcesOf(connections));
    session.watch({ intervalMs: 5_000 });
    await settle();
    await time.advance(1_000);
    expect(of('hosts')).toHaveLength(1);
    connections.push(connection('c2', 'db-01'));
    await time.advance(1_000);
    expect(of('hosts')).toHaveLength(2);
    expect(of('hosts')[1]!.hosts).toHaveLength(3);
  });

  it('asks for GPUs only when the window shows them', async () => {
    const { session, reader, settle } = sessionFor(async () => OK, sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 60_000, gpu: true });
    await settle();
    expect(reader.ssh).toHaveBeenLastCalledWith('c1', { diskIo: true, gpu: true, force: false });
  });

  it('stops reading when it closes', async () => {
    const { session, reader, sent, time, settle } = sessionFor(async () => OK, sourcesOf([connection('c1', 'web-01')]));
    session.watch({ intervalMs: 2_000 });
    await settle();
    const before = sent.length;
    session.close();
    expect(time.running()).toBe(false);
    await time.advance(10_000);
    expect(sent).toHaveLength(before);
    expect(reader.ssh).toHaveBeenCalledTimes(1);
  });
});
