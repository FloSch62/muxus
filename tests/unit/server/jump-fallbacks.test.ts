import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { savedHostHop } from '@muxus/shared';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import {
  isRouteFailure,
  SshConnectionManager,
  type ChainHop,
  type ConnectIo,
} from '../../../server/src/ssh/connection-manager.js';
import { connectGateway, gatewayCandidates } from '../../../server/src/ssh/gateways.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-jump-fallback-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'secret';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

interface FakeServer {
  server: Server;
  port: number;
  stats: { connections: number; auths: number; forwards: number };
}

/** sshd stand-in: password auth, shells, and direct-tcpip to local ports. */
function startServer(opts: { refuseForwards?: boolean; rejectLogins?: boolean } = {}): Promise<FakeServer> {
  const stats = { connections: 0, auths: 0, forwards: 0 };
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    stats.connections += 1;
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (!opts.rejectLogins && ctx.method === 'password' && ctx.password === PASSWORD) {
        stats.auths += 1;
        ctx.accept();
      } else {
        ctx.reject(['password']);
      }
    });
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('env', (acceptEnv) => acceptEnv?.());
        session.on('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.exit(0);
          stream.end();
        });
        session.on('sftp', (_acceptSftp, rejectSftp) => rejectSftp?.());
        session.on('shell', (acceptShell) => acceptShell().write('ready\n'));
      });
      conn.on('tcpip', (accept, reject, info) => {
        if (opts.refuseForwards) {
          reject();
          return;
        }
        const socket = net.connect(info.destPort, info.destIP, () => {
          stats.forwards += 1;
          const channel = accept();
          channel.pipe(socket).pipe(channel);
        });
        socket.on('error', () => reject());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, stats });
    });
  });
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let counter = 0;

/** Two bastions and an app host whose ssh_config ProxyJump is `primary`. */
function writeConfig(ports: { primary: number; secondary: number; app: number }, appJump = 'primary'): string {
  const file = path.join(tmp, `ssh_config-${counter++}`);
  const host = (alias: string, port: number, extra: string[] = []) => [
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    '  User tester',
    '  ConnectTimeout 3',
    ...extra,
    '',
  ];
  writeFileSync(
    file,
    [
      'Host *',
      '  IdentityAgent none',
      '',
      ...host('primary', ports.primary),
      ...host('secondary', ports.secondary),
      ...host('app', ports.app, [`  ProxyJump ${appJump}`]),
    ].join('\n'),
  );
  return file;
}

function makeManager(configFile: string, fallbacks: Record<string, string[][]> = {}): SshConnectionManager {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${counter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
    jumpFallbacksForHost: (alias) => fallbacks[alias] ?? [],
    jumpHopIdleMs: 50,
  });
}

function makeIo(): { io: ConnectIo; statuses: string[]; promptedHosts: string[] } {
  const statuses: string[] = [];
  const promptedHosts: string[] = [];
  return {
    statuses,
    promptedHosts,
    io: {
      status: (message) => statuses.push(message),
      prompt: (info) => {
        promptedHosts.push(info.host ?? '');
        return Promise.resolve({ answers: info.prompts.map(() => PASSWORD) });
      },
      hostKey: () => Promise.resolve(true),
    },
  };
}

const ssh = (target: string, extra: Partial<SshProfile> = {}): SshProfile => ({ kind: 'ssh', target, ...extra });

describe('fallback jump routes', () => {
  let manager: SshConnectionManager | undefined;
  const servers: FakeServer[] = [];

  afterEach(async () => {
    manager?.closeAll();
    manager = undefined;
    await Promise.all(
      servers.splice(0).map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(opts: Parameters<typeof startServer>[0] = {}): Promise<FakeServer> {
    const started = await startServer(opts);
    servers.push(started);
    return started;
  }

  it('goes through the fallback jump host when the first cannot be reached', async () => {
    const secondary = await start();
    const app = await start();
    manager = makeManager(
      writeConfig({ primary: await closedPort(), secondary: secondary.port, app: app.port }),
      { app: [['secondary']] },
    );
    const { io, statuses } = makeIo();

    const shell = await manager.connectShell(ssh('app'), io, 80, 24, 'xterm-256color');

    expect(shell.transport).toBe('new');
    expect(secondary.stats).toMatchObject({ auths: 1, forwards: 1 });
    expect(app.stats.auths).toBe(1);
    expect(statuses.some((line) => /Route via primary failed .* trying via secondary/.test(line))).toBe(true);
  }, 20_000);

  it('goes through the fallback when the first jump host cannot reach the target', async () => {
    const primary = await start({ refuseForwards: true });
    const secondary = await start();
    const app = await start();
    manager = makeManager(writeConfig({ primary: primary.port, secondary: secondary.port, app: app.port }), {
      app: [['secondary']],
    });

    await manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color');

    expect(primary.stats.auths).toBe(1);
    expect(secondary.stats.forwards).toBe(1);
    expect(app.stats.auths).toBe(1);
  }, 20_000);

  it('takes fallback routes from a profile as well', async () => {
    const secondary = await start();
    const app = await start();
    manager = makeManager(
      writeConfig({ primary: await closedPort(), secondary: secondary.port, app: app.port }),
    );

    await manager.connectShell(
      ssh('app', { proxyJumpFallbacks: [['secondary']] }),
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(secondary.stats.forwards).toBe(1);
  }, 20_000);

  it('does not try another route when the target refuses the login', async () => {
    const primary = await start();
    const secondary = await start();
    const app = await start({ rejectLogins: true });
    manager = makeManager(writeConfig({ primary: primary.port, secondary: secondary.port, app: app.port }), {
      app: [['secondary']],
    });

    await expect(
      manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color'),
    ).rejects.toThrow();

    expect(primary.stats.forwards).toBeGreaterThan(0);
    expect(secondary.stats.connections).toBe(0);
  }, 30_000);

  it('rides a live fallback route instead of dialing the dead first route again', async () => {
    const secondary = await start();
    const app = await start();
    manager = makeManager(
      writeConfig({ primary: await closedPort(), secondary: secondary.port, app: app.port }),
      { app: [['secondary']] },
    );

    const first = await manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color');
    const second = await manager.connect(ssh('app'), makeIo().io, 'forward');

    expect(second.connection.id).toBe(first.lease.connection.id);
    expect(app.stats.connections).toBe(1);
    second.release();
  }, 20_000);

  it('skips a route that cannot be planned and tries the next', async () => {
    const secondary = await start();
    const app = await start();
    manager = makeManager(
      writeConfig({ primary: await closedPort(), secondary: secondary.port, app: app.port }),
      // The middle route names a saved jump host that no longer exists.
      { app: [[savedHostHop('deleted-host')], ['secondary']] },
    );
    const { io, statuses } = makeIo();

    await manager.connectShell(ssh('app'), io, 80, 24, 'xterm-256color');

    expect(secondary.stats.forwards).toBe(1);
    expect(statuses.filter((line) => /failed .* trying via/.test(line))).toHaveLength(2);
  }, 20_000);

  it('stops instead of routing around a rejected jump host key', async () => {
    const primary = await start();
    const secondary = await start();
    const app = await start();
    manager = makeManager(writeConfig({ primary: primary.port, secondary: secondary.port, app: app.port }), {
      app: [['secondary']],
    });
    const { io } = makeIo();
    io.hostKey = () => Promise.resolve(false);

    await expect(manager.connectShell(ssh('app'), io, 80, 24, 'xterm-256color')).rejects.toThrow(/host denied|host key/i);
    expect(secondary.stats.connections).toBe(0);
  }, 20_000);

  it('keeps a route the caller chose instead of the alias fallbacks', async () => {
    const secondary = await start();
    const app = await start();
    manager = makeManager(
      writeConfig({ primary: await closedPort(), secondary: secondary.port, app: app.port }),
      { app: [['secondary']] },
    );

    await expect(
      manager.connect(ssh('app', { proxyJump: ['primary'] }), makeIo().io, 'management'),
    ).rejects.toThrow(/refused/);
    expect(secondary.stats.connections).toBe(0);
  }, 20_000);

  it('tries the route that worked last first next time', async () => {
    const secondary = await start();
    const app = await start();
    manager = makeManager(
      writeConfig({ primary: await closedPort(), secondary: secondary.port, app: app.port }),
      { app: [['secondary']] },
    );
    const first = await manager.connect(ssh('app'), makeIo().io, 'forward');
    first.release();
    manager.closeAll();

    const { io, statuses } = makeIo();
    const again = await manager.connect(ssh('app'), io, 'forward');

    expect(statuses.some((line) => /Route via primary failed/.test(line))).toBe(false);
    expect(secondary.stats.forwards).toBe(2);
    again.release();
  }, 20_000);

  it('reports the last failure when every route fails', async () => {
    const app = await start();
    manager = makeManager(
      writeConfig({ primary: await closedPort(), secondary: await closedPort(), app: app.port }),
      { app: [['secondary']] },
    );

    await expect(
      manager.connectShell(ssh('app'), makeIo().io, 80, 24, 'xterm-256color'),
    ).rejects.toThrow(/refused/);
    expect(app.stats.connections).toBe(0);
  }, 20_000);
});

describe('isRouteFailure', () => {
  const hop = { spec: { host: 'h' } } as unknown as ChainHop;
  const twoHops = [hop, hop];

  it('counts failures on a jump host or its channel', () => {
    expect(isRouteFailure(new Error('authentication to x failed'), twoHops, 0, false)).toBe(true);
    expect(isRouteFailure(new Error('jump host could not reach'), twoHops, 1, true)).toBe(true);
  });

  it('leaves the target login, a cancelled prompt and a host key problem alone', () => {
    expect(isRouteFailure(new Error('authentication to x failed'), twoHops, 1, false)).toBe(false);
    expect(isRouteFailure(new Error('authentication cancelled'), twoHops, 0, false)).toBe(false);
    expect(isRouteFailure(new Error('host key verification failed'), twoHops, 0, false)).toBe(false);
  });

  it('counts a direct connection that never got through', () => {
    expect(isRouteFailure(new Error('connection to x:22 timed out'), [hop], 0, false)).toBe(true);
    expect(isRouteFailure(new Error('authentication to x failed'), [hop], 0, false)).toBe(false);
  });
});

describe('SSH gateway fallbacks', () => {
  const io: ConnectIo = { status: vi.fn(), prompt: vi.fn(), hostKey: vi.fn() };

  it('lists the first gateway, then its fallbacks', () => {
    expect(gatewayCandidates({})).toEqual([]);
    expect(
      gatewayCandidates({ sshGateway: { target: 'a' }, sshGatewayFallbacks: [{ target: 'b' }] }),
    ).toEqual([{ target: 'a' }, { target: 'b' }]);
  });

  it('uses the first gateway that answers', async () => {
    const lease = { release: vi.fn() };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused by a:22'))
      .mockResolvedValueOnce(lease);

    const result = await connectGateway({ connect }, [{ target: 'a' }, { target: 'b', profileId: 'p1' }], io, 'desktop');

    expect(result.gateway.target).toBe('b');
    expect(connect).toHaveBeenLastCalledWith({ kind: 'ssh', target: 'b', profileId: 'p1' }, io, 'desktop');
  });

  it('stops at a cancelled sign-in', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('authentication cancelled'));
    await expect(connectGateway({ connect }, [{ target: 'a' }, { target: 'b' }], io, 'desktop')).rejects.toThrow(
      /cancelled/,
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('stops at a rejected host key', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('host key verification failed for a'));
    await expect(connectGateway({ connect }, [{ target: 'a' }, { target: 'b' }], io, 'desktop')).rejects.toThrow(
      /host key/,
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
