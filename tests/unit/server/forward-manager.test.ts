import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TunnelRecord } from '@muxus/shared';
import type { ConnectIo, ManagedConnection } from '../../../server/src/ssh/connection-manager.js';
import { ForwardManager } from '../../../server/src/forwards/forward-manager.js';

/** A transport stand-in whose close the test triggers with drop(). */
function fakeConnection(id: string, client: object = {}) {
  const listeners = new Set<(reason?: string) => void>();
  const connection = {
    id,
    client,
    profile: { kind: 'ssh', target: 'db', keepaliveIntervalSeconds: 25 },
    onClose: (listener: (reason?: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ManagedConnection;
  return {
    connection,
    drop(reason?: string) {
      for (const listener of listeners) listener(reason);
    },
  };
}

function savedTunnel(patch: Partial<TunnelRecord> = {}): TunnelRecord {
  return {
    id: 'tunnel-1',
    target: 'db',
    type: 'dynamic',
    bindPort: 0,
    autoStart: false,
    autoReconnect: true,
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    ...patch,
  };
}

describe('ForwardManager lifecycle', () => {
  let manager: ForwardManager | undefined;

  afterEach(() => manager?.stopAll());

  it('stops terminal-owned forwards but preserves explicit tunnels', async () => {
    const release = vi.fn();
    const { connection } = fakeConnection('connection-1');
    const connections = {
      acquire: () => ({ connection, owner: 'forward' as const, release }),
    };
    manager = new ForwardManager(connections as never, { warn: vi.fn() } as never);

    const session = await manager.start({ connId: connection.id, type: 'dynamic', bindPort: 0 });
    const tunnel = await manager.start({
      connId: connection.id,
      type: 'dynamic',
      bindPort: 0,
      tunnelId: 'tunnel-1',
    });

    expect(session.lifecycle).toBe('session');
    expect(tunnel.lifecycle).toBe('independent');

    manager.stopSessionForConnection(connection.id);

    expect(manager.list()).toEqual([tunnel]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('promotes a running session forward when it is saved as a tunnel', async () => {
    const release = vi.fn();
    const { connection } = fakeConnection('connection-1');
    const connections = {
      acquire: () => ({ connection, owner: 'forward' as const, release }),
    };
    manager = new ForwardManager(connections as never, { warn: vi.fn() } as never);
    const session = await manager.start({ connId: connection.id, type: 'dynamic', bindPort: 0 });

    manager.assignTunnel(session.id, 'tunnel-1');
    manager.stopSessionForConnection(connection.id);

    expect(manager.list()).toEqual([
      expect.objectContaining({ id: session.id, tunnelId: 'tunnel-1', lifecycle: 'independent' }),
    ]);
    expect(release).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent config forwards on a multiplexed connection', async () => {
    const release = vi.fn();
    const { connection } = fakeConnection('connection-1');
    const acquire = vi.fn(() => ({ connection, owner: 'forward' as const, release }));
    manager = new ForwardManager({ acquire } as never, { warn: vi.fn() } as never);
    const request = { connId: connection.id, type: 'dynamic' as const, bindPort: 0 };

    const [first, second] = await Promise.all([
      manager.startConfig(request),
      manager.startConfig(request),
    ]);

    expect(new Set([first.started, second.started])).toEqual(new Set([false, true]));
    expect(first.info.id).toBe(second.info.id);
    expect(manager.list()).toEqual([first.info]);
    expect(acquire).toHaveBeenCalledTimes(1);

    manager.stop(first.info.id);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('ForwardManager tunnel reconnect', () => {
  let manager: ForwardManager | undefined;

  afterEach(() => {
    manager?.stopAll();
    vi.useRealTimers();
  });

  function setup(tunnel: TunnelRecord | undefined, delays: readonly number[] = [0]) {
    const first = fakeConnection('connection-1');
    const releaseFirst = vi.fn();
    const connections = {
      acquire: vi.fn(() => ({ connection: first.connection, owner: 'forward' as const, release: releaseFirst })),
      connect: vi.fn(),
    };
    let current = tunnel;
    manager = new ForwardManager(connections as never, { info: vi.fn(), warn: vi.fn() } as never, {
      tunnel: (id) => (current?.id === id ? current : undefined),
      reconnectDelaysMs: delays,
    });
    return {
      first,
      releaseFirst,
      connections,
      manager,
      setTunnel: (next: TunnelRecord | undefined) => {
        current = next;
      },
    };
  }

  it('redials a dropped tunnel and restarts it under the same id', async () => {
    const { first, releaseFirst, connections, manager } = setup(savedTunnel());
    const second = fakeConnection('connection-2');
    const releaseSecond = vi.fn();
    connections.connect.mockResolvedValue({ connection: second.connection, owner: 'forward', release: releaseSecond });

    const started = await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    first.drop('Connection reset by peer');

    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(manager.list()).toEqual([
      expect.objectContaining({ id: started.id, status: 'reconnecting', error: 'Connection reset by peer' }),
    ]);

    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('active'));
    expect(manager.list()).toEqual([
      expect.objectContaining({ id: started.id, connId: 'connection-2', status: 'active', tunnelId: 'tunnel-1' }),
    ]);
    expect(manager.list()[0]?.error).toBeUndefined();
    expect(connections.connect).toHaveBeenCalledWith(
      { kind: 'ssh', target: 'db', keepaliveIntervalSeconds: 25 },
      expect.anything(),
      'forward',
    );

    manager.stop(started.id);
    expect(releaseSecond).toHaveBeenCalledTimes(1);
  });

  it('redials with the saved tunnel-owned SSH profile', async () => {
    const tunnel = savedTunnel({ target: 'db.internal', sshOptions: { user: 'deploy', proxyJump: ['bastion'] } });
    const { first, connections, manager } = setup(tunnel);
    connections.connect.mockResolvedValue({
      connection: fakeConnection('connection-2').connection,
      owner: 'forward',
      release: vi.fn(),
    });

    await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: tunnel.id });
    first.drop();

    await vi.waitFor(() => expect(connections.connect).toHaveBeenCalled());
    expect(connections.connect.mock.calls[0]?.[0]).toEqual({
      kind: 'ssh',
      target: 'db.internal',
      useConfig: false,
      user: 'deploy',
      proxyJump: ['bastion'],
      keepaliveIntervalSeconds: 25,
    });
  });

  it('stops a dropped tunnel that does not reconnect, as before', async () => {
    const { first, connections, manager } = setup(savedTunnel({ autoReconnect: false }));

    await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    const session = await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0 });
    expect(session.lifecycle).toBe('session');
    first.drop();

    expect(manager.list()).toEqual([]);
    expect(connections.connect).not.toHaveBeenCalled();
  });

  it('keeps retrying while the host is unreachable', async () => {
    const { first, connections, manager } = setup(savedTunnel());
    connections.connect
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
      .mockResolvedValue({ connection: fakeConnection('connection-2').connection, owner: 'forward', release: vi.fn() });

    await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    first.drop();

    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('active'));
    expect(connections.connect).toHaveBeenCalledTimes(3);
  });

  it('gives up without answering when the dial needs the user', async () => {
    const { first, connections, manager } = setup(savedTunnel());
    connections.connect.mockImplementation(async (_profile: unknown, io: ConnectIo) => {
      await io.prompt({ prompts: [{ prompt: 'Password:', echo: false }] }).catch(() => undefined);
      throw new Error('authentication cancelled');
    });

    await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    first.drop();

    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('error'));
    expect(manager.list()[0]?.error).toMatch(/Sign-in needed/);
    expect(connections.connect).toHaveBeenCalledTimes(1);
  });

  it('refuses unknown host keys while redialing', async () => {
    const { first, connections, manager } = setup(savedTunnel());
    let accepted: boolean | undefined;
    connections.connect.mockImplementation(async (_profile: unknown, io: ConnectIo) => {
      accepted = await io.hostKey({ host: 'db', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:x', state: 'mismatch' });
      throw new Error('host key rejected');
    });

    await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    first.drop();

    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('error'));
    expect(accepted).toBe(false);
  });

  it('backs off between attempts and cancels a waiting redial on stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { first, connections, manager } = setup(savedTunnel(), [1_000, 5_000]);
    connections.connect.mockRejectedValue(new Error('connect ENETUNREACH'));

    const started = await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    first.drop();

    await vi.advanceTimersByTimeAsync(999);
    expect(connections.connect).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(connections.connect).toHaveBeenCalledTimes(1);
    expect(manager.list()[0]).toMatchObject({ status: 'reconnecting', error: 'connect ENETUNREACH' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connections.connect).toHaveBeenCalledTimes(2);
    // The last wait repeats.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connections.connect).toHaveBeenCalledTimes(3);

    manager.stop(started.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections.connect).toHaveBeenCalledTimes(3);
    expect(manager.list()).toEqual([]);
  });

  it('drops a waiting redial once auto-reconnect is switched off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { first, connections, manager, setTunnel } = setup(savedTunnel(), [60_000]);

    await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    first.drop();
    expect(manager.list()).toHaveLength(1);

    setTunnel(savedTunnel({ autoReconnect: false }));
    manager.tunnelChanged('tunnel-1');

    expect(manager.list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections.connect).not.toHaveBeenCalled();
  });

  it('lets a manual start take over from a waiting redial', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { first, connections, manager } = setup(savedTunnel(), [60_000]);

    const dropped = await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });
    first.drop();
    const restarted = await manager.start({ connId: 'connection-1', type: 'dynamic', bindPort: 0, tunnelId: 'tunnel-1' });

    expect(manager.list()).toEqual([expect.objectContaining({ id: restarted.id, status: 'active' })]);
    expect(restarted.id).not.toBe(dropped.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections.connect).not.toHaveBeenCalled();
  });

  it('releases a remote forward whose connection is already gone', async () => {
    const client = {
      on: vi.fn(),
      forwardIn: vi.fn((_addr: string, _port: number, cb: (err?: Error) => void) => cb()),
      unforwardIn: vi.fn(() => {
        throw new Error('Not connected');
      }),
    };
    const first = fakeConnection('connection-1', client);
    const release = vi.fn();
    manager = new ForwardManager(
      { acquire: () => ({ connection: first.connection, owner: 'forward', release }) } as never,
      { info: vi.fn(), warn: vi.fn() } as never,
    );

    await manager.start({ connId: 'connection-1', type: 'remote', bindPort: 8080, targetHost: 'localhost', targetPort: 3000 });
    expect(() => first.drop()).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
    expect(manager.list()).toEqual([]);
  });
});

describe('ForwardManager tunnel autostart', () => {
  let manager: ForwardManager | undefined;

  afterEach(() => {
    manager?.stopAll();
    vi.useRealTimers();
  });

  function setup(tunnels: TunnelRecord[], delays: readonly number[] = [0]) {
    let saved = tunnels;
    const connections = { acquire: vi.fn(), connect: vi.fn() };
    manager = new ForwardManager(connections as never, { info: vi.fn(), warn: vi.fn() } as never, {
      tunnel: (id) => saved.find((tunnel) => tunnel.id === id),
      reconnectDelaysMs: delays,
    });
    return {
      connections,
      manager,
      setTunnels: (next: TunnelRecord[]) => {
        saved = next;
      },
    };
  }

  const connected = (id: string) => ({ connection: fakeConnection(id).connection, owner: 'forward', release: vi.fn() });

  it('starts only the tunnels marked to start with Muxus', async () => {
    const tunnels = [
      savedTunnel({ id: 'db', target: 'db', autoStart: true, autoReconnect: false }),
      savedTunnel({ id: 'manual', target: 'web', autoStart: false }),
    ];
    const { connections, manager } = setup(tunnels);
    connections.connect.mockResolvedValue(connected('connection-1'));

    manager.autostart(tunnels);

    expect(manager.list()).toEqual([
      expect.objectContaining({ tunnelId: 'db', status: 'starting', connId: '', lifecycle: 'independent' }),
    ]);
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('active'));
    expect(manager.list()).toEqual([expect.objectContaining({ tunnelId: 'db', connId: 'connection-1' })]);
    // No window has told the server its keepalive preference yet.
    expect(connections.connect).toHaveBeenCalledExactlyOnceWith(
      { kind: 'ssh', target: 'db', keepaliveIntervalSeconds: 30 },
      expect.anything(),
      'forward',
    );

    // A second pass never doubles a tunnel that is already up.
    manager.autostart(tunnels);
    expect(manager.list()).toHaveLength(1);
  });

  it('shows why a start failed when the tunnel does not reconnect', async () => {
    const tunnels = [savedTunnel({ autoStart: true, autoReconnect: false })];
    const { connections, manager } = setup(tunnels);
    connections.connect.mockRejectedValue(new Error('connect ENETUNREACH'));

    manager.autostart(tunnels);

    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('error'));
    expect(manager.list()[0]?.error).toBe('connect ENETUNREACH');
    expect(connections.connect).toHaveBeenCalledTimes(1);
  });

  it('keeps trying a failed start when the tunnel reconnects', async () => {
    const tunnels = [savedTunnel({ autoStart: true, autoReconnect: true })];
    const { connections, manager } = setup(tunnels);
    connections.connect
      .mockRejectedValueOnce(new Error('connect ENETUNREACH'))
      .mockResolvedValue(connected('connection-1'));

    manager.autostart(tunnels);

    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('active'));
    expect(connections.connect).toHaveBeenCalledTimes(2);
  });

  it('waits for the user when the start needs a prompt', async () => {
    const tunnels = [savedTunnel({ autoStart: true, autoReconnect: true })];
    const { connections, manager } = setup(tunnels);
    connections.connect.mockImplementation(async (_profile: unknown, io: ConnectIo) => {
      await io.prompt({ prompts: [{ prompt: 'Verification code:', echo: false }] }).catch(() => undefined);
      throw new Error('authentication cancelled');
    });

    manager.autostart(tunnels);

    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('error'));
    expect(manager.list()[0]?.error).toMatch(/Sign-in needed/);
    expect(connections.connect).toHaveBeenCalledTimes(1);
  });

  it('lets saving or deleting the tunnel drop a start it no longer wants', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const tunnel = savedTunnel({ autoStart: true, autoReconnect: true });
    const { connections, manager, setTunnels } = setup([tunnel], [60_000]);
    connections.connect.mockRejectedValue(new Error('connect ETIMEDOUT'));

    manager.autostart([tunnel]);
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('reconnecting'));

    // Switching autostart off leaves a redial the tunnel still wants.
    setTunnels([{ ...tunnel, autoStart: false }]);
    manager.tunnelChanged(tunnel.id);
    expect(manager.list()).toHaveLength(1);

    setTunnels([]);
    manager.tunnelChanged(tunnel.id);
    expect(manager.list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connections.connect).toHaveBeenCalledTimes(1);
  });
});
