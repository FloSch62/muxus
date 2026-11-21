import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, type AcceptConnection, type RejectConnection, type ServerChannel } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ForwardRequest, TunnelRecord } from '@muxus/shared';
import { ForwardManager } from '../../../server/src/forwards/forward-manager.js';
import {
  SshConnectionManager,
  type ConnectIo,
  type ManagedConnection,
} from '../../../server/src/ssh/connection-manager.js';
import { SshError } from '../../../server/src/ssh/engine.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

/**
 * An engine stand-in whose forwards bind at once: on the port asked for, or
 * on one of its own for port 0. `listeners` keeps each local one it handed
 * out, so a test can see which of them were closed.
 */
function fakeTransport() {
  let nextPort = 40_000;
  const listeners: Array<{ port: number; close: ReturnType<typeof vi.fn> }> = [];
  const listen = (_bindHost: string, bindPort: number) => {
    const listener = { port: bindPort || nextPort++, close: vi.fn() };
    listeners.push(listener);
    return Promise.resolve(listener);
  };
  return {
    listeners,
    forwardLocal: vi.fn(listen),
    forwardDynamic: vi.fn(listen),
    forwardRemote: vi.fn((_bindHost: string, bindPort: number) =>
      Promise.resolve({ port: bindPort, close: vi.fn(() => Promise.resolve()) }),
    ),
    onForwardError: vi.fn(() => () => undefined),
  };
}

/** A connection stand-in whose close the test triggers with drop(). */
function fakeConnection(id: string, transport: object = fakeTransport()) {
  const listeners = new Set<(reason?: string) => void>();
  const connection = {
    id,
    transport,
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

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
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

// What only the engine can show (a listener that really listens, what happens
// to each client) runs over a real connection to an sshd stand-in.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-forward-manager-'));
const emptyConfig = path.join(tmp, 'ssh_config');
writeFileSync(emptyConfig, '');

const savedEnv = { HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
beforeAll(() => {
  // No real agent and no real ~/.ssh keys take part in the dial.
  process.env.HOME = tmp;
  delete process.env.SSH_AUTH_SOCK;
});
afterAll(() => {
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.SSH_AUTH_SOCK !== undefined) process.env.SSH_AUTH_SOCK = savedEnv.SSH_AUTH_SOCK;
  rmSync(tmp, { recursive: true, force: true });
});

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

/** What the sshd stand-in does with a client's direct-tcpip request. */
type TcpipHandler = (accept: AcceptConnection<ServerChannel>, reject: RejectConnection) => void;

/** sshd stand-in that lets everyone in and leaves each direct-tcpip request to the test. */
function startSshd(onTcpip: TcpipHandler) {
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => ctx.accept());
    conn.on('ready', () => conn.on('tcpip', onTcpip));
  });
  return new Promise<{ server: Server; port: number }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

/** Round-trip a line through the forwarded local port. */
function echoThrough(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (data) => {
      resolve(data.toString('utf8'));
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

let knownHostsCounter = 0;

const trustingIo: ConnectIo = {
  status: () => undefined,
  prompt: () => Promise.reject(new Error('the sshd stand-in asks for nothing')),
  hostKey: () => Promise.resolve(true),
};

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/**
 * A running forward on a real connection, started the way the forwarding
 * panel starts one. Without a handler the sshd refuses every channel.
 */
async function startOverSsh(
  request: Omit<ForwardRequest, 'connId'>,
  onTcpip: TcpipHandler = (_accept, reject) => reject(),
) {
  const sshd = await startSshd(onTcpip);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const connections = new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(path.join(tmp, `known_hosts-${knownHostsCounter++}`), path.join(tmp, 'no-global')),
    loadConfig: () => loadConfigDocument(emptyConfig),
  });
  // A logger of its own, so `warn` holds only what the forwards said.
  const warn = vi.fn();
  const forwards = new ForwardManager(connections, { info: vi.fn(), warn } as never);
  closers.push(
    () => new Promise<void>((resolve) => sshd.server.close(() => resolve())),
    () => connections.closeAll(),
    () => forwards.stopAll(),
  );

  const dial = await connections.connect(
    { kind: 'ssh', target: '127.0.0.1', useConfig: false, user: 'tester', port: sshd.port },
    trustingIo,
    'dial',
  );
  const started = await forwards.start({ ...request, connId: dial.connection.id });
  dial.release();
  return { forwards, started, warn };
}

describe('ForwardManager lifecycle', () => {
  let manager: ForwardManager | undefined;

  afterEach(() => manager?.stopAll());

  it('stops terminal-owned forwards but preserves explicit tunnels', async () => {
    const release = vi.fn();
    const transport = fakeTransport();
    const { connection } = fakeConnection('connection-1', transport);
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
    // Only the session's listener went down with it.
    expect(transport.listeners.map((listener) => listener.close.mock.calls.length)).toEqual([1, 0]);
  });

  it('reports the port a SOCKS5 forward on port 0 was given', async () => {
    const { started: forward } = await startOverSsh({ type: 'dynamic', bindPort: 0 });

    expect(forward.bindPort).toBeGreaterThan(0);
    // Something really listens there.
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(forward.bindPort, '127.0.0.1', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });
  });

  it('keeps an independent forward when the terminal sessions on its connection end', async () => {
    const { connection } = fakeConnection('connection-1');
    const connections = {
      acquire: () => ({ connection, owner: 'forward' as const, release: vi.fn() }),
    };
    manager = new ForwardManager(connections as never, { warn: vi.fn() } as never);

    const proxy = await manager.start({ connId: connection.id, type: 'dynamic', bindPort: 0, independent: true });
    const plain = await manager.start({ connId: connection.id, type: 'dynamic', bindPort: 0 });
    manager.stopSessionForConnection(connection.id);

    expect(manager.list().map((info) => info.id)).toEqual([proxy.id]);
    expect(plain.lifecycle).toBe('session');
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

describe('ForwardManager clients of a local forward', () => {
  /** A running -L forward to an sshd whose answer to each channel request the test supplies. */
  async function startLocal(onTcpip: TcpipHandler) {
    const port = await freePort();
    const { started, warn } = await startOverSsh(
      { type: 'local', bindPort: port, targetHost: 'db', targetPort: 5432 },
      onTcpip,
    );
    return { port, started, warn };
  }

  it('drops a local client whose channel the server refuses', async () => {
    const onTcpip = vi.fn<TcpipHandler>((_accept, reject) => reject());
    const { port, started, warn } = await startLocal(onTcpip);

    await new Promise<void>((resolve) => {
      net.connect(port, '127.0.0.1').once('close', () => resolve());
    });

    expect(onTcpip).toHaveBeenCalledTimes(1);
    // The engine's report travels on its own and can arrive after the client is gone.
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { err: 'Channel open failure: connect failed', forward: started.id },
        'forwardOut failed',
      ),
    );
  });

  it('survives a local client resetting while its channel opens', async () => {
    let opened: AcceptConnection<ServerChannel> | undefined;
    const { port } = await startLocal((accept) => {
      // The first request waits for the test; the ones after it are echoed.
      if (!opened) opened = accept;
      else {
        const stream = accept();
        stream.pipe(stream);
      }
    });

    const client = net.connect(port, '127.0.0.1');
    await vi.waitFor(() => expect(opened).toBeDefined());
    client.resetAndDestroy();
    // Let the reset reach the listener's side before the channel comes back.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The channel opens for nobody and must not linger.
    const closed = vi.fn();
    // Read it as an sshd would: ssh2 only reports the close of a channel it has read to its end.
    opened!().on('close', closed).resume();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));

    // The forward itself is unharmed.
    expect(await echoThrough(port, 'after')).toBe('after');
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
    // Cancelling the server's listener fails: nobody is left to hear it.
    const close = vi.fn(() => Promise.reject(new SshError('Not connected', 'DISCONNECTED')));
    const transport = {
      forwardRemote: vi.fn((_bindHost: string, bindPort: number) => Promise.resolve({ port: bindPort, close })),
    };
    const first = fakeConnection('connection-1', transport);
    const release = vi.fn();
    manager = new ForwardManager(
      { acquire: () => ({ connection: first.connection, owner: 'forward', release }) } as never,
      { info: vi.fn(), warn: vi.fn() } as never,
    );

    await manager.start({ connId: 'connection-1', type: 'remote', bindPort: 8080, targetHost: 'localhost', targetPort: 3000 });
    expect(() => first.drop()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
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
