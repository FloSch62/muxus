import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-jump-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'secret';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

interface ServerStats {
  connections: number;
  /** Connections still open. */
  live: number;
  auths: number;
  forwards: number;
  /** Forwards served, by connection in arrival order. */
  forwardsByConnection: number[];
  shells: number;
}

interface FakeServer {
  server: Server;
  port: number;
  stats: ServerStats;
  /** Drop every client connection, the way a rebooted host would. */
  dropAll(): void;
}

/**
 * Minimal sshd stand-in with password auth, plain shells, and (for jump
 * hosts) direct-tcpip forwarding to local ports.
 */
function startServer(opts: {
  /** Refuse shells past this many on one connection (MaxSessions, Cisco IOS). */
  maxShellsPerConnection?: number;
  /** End the whole connection on exec, like console servers given a probe. */
  disconnectOnExec?: boolean;
  /** End the connection instead of serving its second forward. */
  dropOnSecondForward?: boolean;
} = {}): Promise<FakeServer> {
  const stats: ServerStats = {
    connections: 0,
    live: 0,
    auths: 0,
    forwards: 0,
    forwardsByConnection: [],
    shells: 0,
  };
  const clients = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    const index = stats.connections;
    stats.connections += 1;
    stats.live += 1;
    stats.forwardsByConnection[index] = 0;
    clients.add(conn);
    conn.on('close', () => {
      stats.live -= 1;
      clients.delete(conn);
    });
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PASSWORD) {
        stats.auths += 1;
        ctx.accept();
      } else {
        ctx.reject(['password']);
      }
    });
    conn.on('ready', () => {
      let shells = 0;
      let forwards = 0;
      conn.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('env', (acceptEnv) => acceptEnv?.());
        session.on('exec', (acceptExec) => {
          if (opts.disconnectOnExec) {
            conn.end();
            return;
          }
          // Empty probe output: no integrated shell, open a plain one.
          const stream = acceptExec();
          stream.exit(0);
          stream.end();
        });
        session.on('sftp', (_acceptSftp, rejectSftp) => rejectSftp?.());
        session.on('shell', (acceptShell, rejectShell) => {
          if (shells >= (opts.maxShellsPerConnection ?? Number.POSITIVE_INFINITY)) {
            rejectShell?.();
            return;
          }
          shells += 1;
          stats.shells += 1;
          acceptShell().write('ready\n');
        });
      });
      conn.on('tcpip', (accept, reject, info) => {
        forwards += 1;
        if (opts.dropOnSecondForward && forwards > 1) {
          conn.end();
          return;
        }
        const socket = net.connect(info.destPort, info.destIP, () => {
          stats.forwards += 1;
          stats.forwardsByConnection[index] = (stats.forwardsByConnection[index] ?? 0) + 1;
          const channel = accept();
          channel.pipe(socket).pipe(channel);
        });
        socket.on('error', () => reject());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as net.AddressInfo).port,
        stats,
        dropAll: () => {
          for (const client of clients) client.end();
        },
      });
    });
  });
}

/** A local port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** ssh_config with a bastion and targets reached through it. */
function writeConfig(jumpPort: number, targets: Record<string, number>): string {
  const file = path.join(tmp, `ssh_config-${configCounter++}`);
  writeFileSync(
    file,
    [
      'Host *',
      '  IdentityAgent none',
      '',
      'Host bastion',
      '  HostName 127.0.0.1',
      `  Port ${jumpPort}`,
      '  User jumper',
      '',
      ...Object.entries(targets).flatMap(([alias, port]) => [
        `Host ${alias}`,
        '  HostName 127.0.0.1',
        `  Port ${port}`,
        '  User tester',
        '  ProxyJump bastion',
        '',
      ]),
    ].join('\n'),
  );
  return file;
}

let configCounter = 0;

function makeManager(configFile: string): SshConnectionManager {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${configCounter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
    jumpHopIdleMs: 50,
  });
}

/** Answers every prompt and records which hop asked. */
function makeIo(): { io: ConnectIo; promptedHosts: string[] } {
  const promptedHosts: string[] = [];
  return {
    promptedHosts,
    io: {
      status: () => undefined,
      prompt: (info) => {
        promptedHosts.push(info.host ?? '');
        return Promise.resolve({ answers: info.prompts.map(() => PASSWORD) });
      },
      hostKey: () => Promise.resolve(true),
    },
  };
}

function ssh(target: string): SshProfile {
  return { kind: 'ssh', target };
}

describe('jump host reuse', () => {
  let manager: SshConnectionManager | undefined;
  const servers: FakeServer[] = [];

  afterEach(async () => {
    manager?.closeAll();
    manager = undefined;
    await Promise.all(
      servers.splice(0).map(
        ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  async function start(opts: Parameters<typeof startServer>[0] = {}): Promise<FakeServer> {
    const started = await startServer(opts);
    servers.push(started);
    return started;
  }

  it('duplicates a session on a host that refuses a second channel without a second jump login', async () => {
    const jump = await start();
    const target = await start({ maxShellsPerConnection: 1 });
    manager = makeManager(writeConfig(jump.port, { app: target.port }));

    const first = makeIo();
    const a = await manager.connectShell(ssh('app'), first.io, 80, 24, 'xterm-256color');
    const second = makeIo();
    const b = await manager.connectShell(ssh('app'), second.io, 80, 24, 'xterm-256color');

    expect(a.transport).toBe('new');
    expect(b.transport).toBe('overflow');
    expect(b.lease.connection.id).not.toBe(a.lease.connection.id);
    expect(target.stats).toMatchObject({ connections: 2, shells: 2 });
    // The dedicated connection is another channel over the first jump login.
    expect(jump.stats).toMatchObject({ connections: 1, auths: 1, forwards: 2 });
    expect(second.promptedHosts).toEqual(['app']);
  }, 15_000);

  it('redials a console server in plain-console mode over the same jump login', async () => {
    const jump = await start();
    const target = await start({ disconnectOnExec: true });
    manager = makeManager(writeConfig(jump.port, { console: target.port }));

    const shell = await manager.connectShell(ssh('console'), makeIo().io, 80, 24, 'xterm-256color');

    expect(shell.transport).toBe('new');
    expect(target.stats.connections).toBe(2);
    expect(jump.stats).toMatchObject({ connections: 1, auths: 1 });
  }, 15_000);

  it('reaches another host behind the same jump host over its open connection', async () => {
    const jump = await start();
    const app = await start();
    const db = await start();
    manager = makeManager(writeConfig(jump.port, { app: app.port, db: db.port }));

    await manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color');
    const second = makeIo();
    await manager.connectShell(ssh('db'), second.io, 80, 24, 'xterm-256color');

    expect(jump.stats).toMatchObject({ connections: 1, auths: 1, forwards: 2 });
    expect(second.promptedHosts).toEqual(['db']);
  }, 15_000);

  it('reports a target the jump host cannot reach without logging in to the jump host again', async () => {
    const jump = await start();
    const app = await start();
    manager = makeManager(
      writeConfig(jump.port, { app: app.port, gone: await closedPort() }),
    );

    await manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color');
    const second = makeIo();
    await expect(
      manager.connectShell(ssh('gone'), second.io, 80, 24, 'xterm-256color'),
    ).rejects.toThrow(/jump host could not reach/);

    expect(jump.stats.connections).toBe(1);
    expect(second.promptedHosts).toEqual([]);
  }, 15_000);

  it('dials the jump host again when its open connection cannot carry another chain', async () => {
    const jump = await start({ dropOnSecondForward: true });
    const app = await start();
    const db = await start();
    manager = makeManager(writeConfig(jump.port, { app: app.port, db: db.port }));

    await manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color');
    const second = makeIo();
    const shell = await manager.connectShell(ssh('db'), second.io, 80, 24, 'xterm-256color');

    expect(shell.transport).toBe('new');
    expect(jump.stats.connections).toBe(2);
    expect(second.promptedHosts).toEqual(['bastion', 'db']);
  }, 15_000);

  it('gives a force reconnect its own jump connection, shared within the gesture', async () => {
    const jump = await start();
    const app = await start();
    const db = await start();
    const cache = await start();
    manager = makeManager(
      writeConfig(jump.port, { app: app.port, db: db.port, cache: cache.port }),
    );

    await manager.connect(ssh('app'), makeIo().io);
    await manager.connect(ssh('app'), makeIo().io, 'terminal', { freshTransport: 'wave' });
    expect(jump.stats.connections).toBe(2);

    await manager.connect(ssh('db'), makeIo().io, 'terminal', { freshTransport: 'wave' });
    expect(jump.stats.connections).toBe(2);
    // Later connections ride the replacement, not the route it replaced.
    await manager.connect(ssh('cache'), makeIo().io);
    expect(jump.stats.connections).toBe(2);
    expect(jump.stats.forwardsByConnection).toEqual([1, 3]);
  }, 15_000);

  it('names the jump hosts in the session summary', async () => {
    const jump = await start();
    const app = await start();
    manager = makeManager(writeConfig(jump.port, { app: app.port }));

    const shell = await manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color');
    expect(shell.summary).toMatchObject({
      user: 'tester',
      port: app.port,
      jumpHosts: ['bastion'],
      proxyCommand: false,
    });
    shell.stream.close();
    shell.lease.release();
  }, 15_000);

  it('closes the jump connection only after the last chain through it', async () => {
    const jump = await start();
    const app = await start();
    const db = await start();
    manager = makeManager(writeConfig(jump.port, { app: app.port, db: db.port }));

    const a = await manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color');
    const b = await manager.connectShell(ssh('db'), makeIo().io, 80, 24, 'xterm-256color');

    a.stream.close();
    a.lease.release();
    await vi.waitFor(() => expect(app.stats.live).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(jump.stats.live).toBe(1);

    b.stream.close();
    b.lease.release();
    await vi.waitFor(() => expect(jump.stats.live).toBe(0));
  }, 15_000);

  it('ends every chain through a jump host that disconnects', async () => {
    const jump = await start();
    const app = await start();
    const db = await start();
    manager = makeManager(writeConfig(jump.port, { app: app.port, db: db.port }));

    const a = await manager.connect(ssh('app'), makeIo().io);
    const b = await manager.connect(ssh('db'), makeIo().io);
    const reasons = Promise.all(
      [a, b].map(
        (lease) => new Promise<string | undefined>((resolve) => lease.connection.onClose(resolve)),
      ),
    );
    jump.dropAll();

    expect(await reasons).toEqual([
      'SSH jump host bastion disconnected.',
      'SSH jump host bastion disconnected.',
    ]);
    expect(manager.list()).toHaveLength(0);
  }, 15_000);
});
