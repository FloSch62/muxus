import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-mux-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'secret';

// One host key for every fake server in the suite; generating RSA keys is the
// slow part of setup.
const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const emptyConfig = path.join(tmp, 'ssh_config');
writeFileSync(emptyConfig, '');

interface ServerStats {
  connections: number;
  auths: number;
  envRequests: number;
  execs: number;
  ptyRequests: number;
  sftpRequests: number;
  shells: number;
}

/**
 * Minimal sshd stand-in: password auth, PTY + shell sessions with an optional
 * per-connection shell cap (the MaxSessions failure mode), and rejected
 * exec/sftp probes so the manager falls back to plain shells.
 */
function startServer(opts: {
  maxShellsPerConnection?: number;
  disconnectOnExec?: boolean;
  rejectPty?: boolean;
  /** Console servers that only serve interactive terminals reject shells with no pty. */
  requirePty?: boolean;
} = {}): Promise<{
  server: Server;
  port: number;
  stats: ServerStats;
}> {
  const stats: ServerStats = {
    connections: 0,
    auths: 0,
    envRequests: 0,
    execs: 0,
    ptyRequests: 0,
    sftpRequests: 0,
    shells: 0,
  };
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    stats.connections += 1;
    let shells = 0;
    conn.on('error', () => undefined);
    conn.on('authentication', (authCtx) => {
      if (authCtx.method === 'password' && authCtx.password === PASSWORD) {
        stats.auths += 1;
        authCtx.accept();
      } else {
        authCtx.reject(['password']);
      }
    });
    conn.on('ready', () => {
      conn.on('session', (acceptSession) => {
        const session = acceptSession();
        let hasPty = false;
        session.on('pty', (acceptPty, rejectPty) => {
          stats.ptyRequests += 1;
          if (opts.rejectPty) {
            rejectPty?.();
            return;
          }
          hasPty = true;
          acceptPty?.();
        });
        session.on('env', (acceptEnv) => {
          stats.envRequests += 1;
          acceptEnv?.();
        });
        // Empty probe output means "no integrated shell" — the manager then
        // opens a plain shell, which is what these tests exercise.
        session.on('exec', (acceptExec) => {
          stats.execs += 1;
          if (opts.disconnectOnExec) {
            conn.end();
            return;
          }
          const stream = acceptExec();
          stream.exit(0);
          stream.end();
        });
        session.on('sftp', (_acceptSftp, rejectSftp) => {
          stats.sftpRequests += 1;
          rejectSftp?.();
        });
        session.on('shell', (acceptShell, rejectShell) => {
          if (shells >= (opts.maxShellsPerConnection ?? Number.POSITIVE_INFINITY)) {
            rejectShell?.();
            return;
          }
          if (opts.requirePty && !hasPty) {
            rejectShell?.();
            return;
          }
          shells += 1;
          stats.shells += 1;
          acceptShell().write('ready\n');
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, stats });
    });
  });
}

let knownHostsCounter = 0;
function makeManager(
  configFile = emptyConfig,
  options: {
    disableSftpForHost?: (alias: string) => boolean;
    consoleCompatibilityForHost?: (alias: string) => boolean;
  } = {},
): SshConnectionManager {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${knownHostsCounter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
    ...options,
  });
}

function makeIo(): { io: ConnectIo; prompts: string[]; hostKeyAsks: number[] } {
  const prompts: string[] = [];
  const hostKeyAsks: number[] = [];
  const io: ConnectIo = {
    status: () => undefined,
    prompt: (info) => {
      prompts.push(...info.prompts.map((p) => p.prompt));
      return Promise.resolve({
        answers: info.prompts.map(() => PASSWORD),
      });
    },
    hostKey: (challenge) => {
      hostKeyAsks.push(challenge.port);
      return Promise.resolve(true);
    },
  };
  return { io, prompts, hostKeyAsks };
}

function profile(port: number): SshProfile {
  return { kind: 'ssh', target: '127.0.0.1', user: 'tester', port, passwordOnly: true, useConfig: false };
}

describe('SSH connection multiplexing', () => {
  let manager: SshConnectionManager | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    manager?.closeAll();
    manager = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('multiplexes a second terminal onto the existing transport', async () => {
    const started = await startServer();
    server = started.server;
    manager = makeManager();

    const first = makeIo();
    const a = await manager.connectShell(profile(started.port), first.io, 80, 24, 'xterm-256color');
    const second = makeIo();
    const b = await manager.connectShell(profile(started.port), second.io, 80, 24, 'xterm-256color');

    expect(a.transport).toBe('new');
    expect(b.transport).toBe('shared');
    expect(b.lease.connection.id).toBe(a.lease.connection.id);
    expect(started.stats).toMatchObject({ connections: 1, auths: 1, shells: 2 });
    // Attaching to an established transport needs no auth or host-key round-trips.
    expect(second.prompts).toHaveLength(0);
    expect(second.hostKeyAsks).toHaveLength(0);

    // The transport survives its first session and closes with its last one.
    b.stream.close();
    b.lease.release();
    expect(manager.list()).toHaveLength(1);
    a.stream.close();
    a.lease.release();
    await vi.waitFor(() => expect(manager!.list()).toHaveLength(0));
  }, 15_000);

  it('adds config forwards requested by another alias on a shared transport', async () => {
    const started = await startServer();
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-forwards-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host first',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  DynamicForward 1080',
        '',
        'Host second',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  DynamicForward 1081',
      ].join('\n'),
    );
    manager = makeManager(configFile);

    const a = await manager.connectShell(
      { kind: 'ssh', target: 'first', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );
    const b = await manager.connectShell(
      { kind: 'ssh', target: 'second', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(b.transport).toBe('shared');
    expect(b.lease.connection.id).toBe(a.lease.connection.id);
    expect(b.lease.connection.configForwards).toEqual([
      { type: 'dynamic', bindPort: 1080 },
      { type: 'dynamic', bindPort: 1081 },
    ]);
  }, 15_000);

  it('collapses concurrent dials into one connection and one auth round-trip', async () => {
    const started = await startServer();
    server = started.server;
    manager = makeManager();

    const first = makeIo();
    const second = makeIo();
    const [a, b] = await Promise.all([
      manager.connectShell(profile(started.port), first.io, 80, 24, 'xterm-256color'),
      manager.connectShell(profile(started.port), second.io, 80, 24, 'xterm-256color'),
    ]);

    expect(started.stats).toMatchObject({ connections: 1, auths: 1, shells: 2 });
    expect([a.transport, b.transport].sort()).toEqual(['new', 'shared']);
    expect(b.lease.connection.id).toBe(a.lease.connection.id);
    // Only the session that started the dial answered prompts.
    expect(first.prompts.length + second.prompts.length).toBe(1);
  }, 15_000);

  it('falls back to a dedicated transport when the shared one refuses another session', async () => {
    const started = await startServer({ maxShellsPerConnection: 1 });
    server = started.server;
    manager = makeManager();

    const first = makeIo();
    const a = await manager.connectShell(profile(started.port), first.io, 80, 24, 'xterm-256color');
    const second = makeIo();
    const b = await manager.connectShell(profile(started.port), second.io, 80, 24, 'xterm-256color');

    expect(a.transport).toBe('new');
    expect(b.transport).toBe('overflow');
    expect(b.lease.connection.id).not.toBe(a.lease.connection.id);
    expect(started.stats).toMatchObject({ connections: 2, shells: 2 });
    // A third pane multiplexes onto the overflow transport instead of dialing again.
    const third = makeIo();
    const c = await manager.connectShell(profile(started.port), third.io, 80, 24, 'xterm-256color');
    expect(c.transport).toBe('overflow');
    expect(started.stats.connections).toBe(3);
  }, 15_000);

  it('honors the freshTransport escape hatch', async () => {
    const started = await startServer();
    server = started.server;
    manager = makeManager();

    const first = makeIo();
    const a = await manager.connect(profile(started.port), first.io);
    const second = makeIo();
    const b = await manager.connect(profile(started.port), second.io, 'terminal', { freshTransport: true });

    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false);
    expect(b.connection.id).not.toBe(a.connection.id);
    expect(started.stats.connections).toBe(2);
  }, 15_000);

  it('opens a plain shell in console mode when the host rejects pty-req', async () => {
    // Some network consoles reject pty-req; the shell must still open, without
    // exec or SFTP probes.
    const started = await startServer({ rejectPty: true });
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-console-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host console',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
      ].join('\n'),
    );
    manager = makeManager(configFile, {
      consoleCompatibilityForHost: (alias) => alias === 'console',
    });

    const shell = await manager.connectShell(
      { kind: 'ssh', target: 'console', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(shell.lease.connection.sftpAvailable).toBe(false);
    // The rejected pty-req costs a channel, so the shell arrives on the retry.
    expect(started.stats).toMatchObject({
      execs: 0,
      ptyRequests: 1,
      sftpRequests: 0,
      shells: 1,
    });
    await expect(shell.lease.connection.sftp()).rejects.toThrow(
      'SFTP is disabled for this host.',
    );
    expect(started.stats.sftpRequests).toBe(0);
  }, 15_000);

  it('allocates a PTY in console mode for hosts that require one', async () => {
    // Serial console servers such as Lantronix answer a shell request with
    // CHANNEL_FAILURE unless the channel already has a pty.
    const started = await startServer({ requirePty: true });
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-console-needs-pty-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host console',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  SetEnv TERM=xterm-256color',
      ].join('\n'),
    );
    manager = makeManager(configFile, {
      consoleCompatibilityForHost: (alias) => alias === 'console',
    });

    const shell = await manager.connectShell(
      { kind: 'ssh', target: 'console', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(shell.lease.connection.sftpAvailable).toBe(false);
    // ssh2 can only send env requests ahead of pty-req, so console mode sends
    // none: appliances reject that order with a protocol-error disconnect.
    expect(started.stats).toMatchObject({
      envRequests: 0,
      execs: 0,
      ptyRequests: 1,
      sftpRequests: 0,
      shells: 1,
    });
  }, 15_000);

  it('still applies SetEnv for hosts outside console mode', async () => {
    const started = await startServer();
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-setenv-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host regular',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  SetEnv TERM=xterm-256color',
      ].join('\n'),
    );
    manager = makeManager(configFile);

    await manager.connectShell(
      { kind: 'ssh', target: 'regular', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(started.stats.envRequests).toBeGreaterThan(0);
    expect(started.stats.shells).toBe(1);
  }, 15_000);

  it('preserves env requests for existing disable-SFTP hosts', async () => {
    const started = await startServer();
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-disable-sftp-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host legacy',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  SetEnv MUXUS_TEST=from-config',
      ].join('\n'),
    );
    manager = makeManager(configFile, {
      disableSftpForHost: (alias) => alias === 'legacy',
    });

    const shell = await manager.connectShell(
      { kind: 'ssh', target: 'legacy', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(shell.lease.connection.sftpAvailable).toBe(false);
    expect(started.stats).toMatchObject({
      envRequests: 1,
      execs: 0,
      ptyRequests: 1,
      sftpRequests: 0,
      shells: 1,
    });
  }, 15_000);

  it('applies console compatibility to RemoteCommand sessions', async () => {
    const started = await startServer({ rejectPty: true });
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-console-command-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host console',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  SetEnv MUXUS_TEST=from-config',
        '  RemoteCommand show version',
        '  RequestTTY yes',
      ].join('\n'),
    );
    manager = makeManager(configFile, {
      consoleCompatibilityForHost: (alias) => alias === 'console',
    });

    const shell = await manager.connectShell(
      { kind: 'ssh', target: 'console', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(shell.lease.connection.sftpAvailable).toBe(false);
    expect(started.stats).toMatchObject({
      envRequests: 0,
      execs: 1,
      ptyRequests: 1,
      sftpRequests: 0,
      shells: 0,
    });
  }, 15_000);

  it('honors an explicit RequestTTY yes in console mode', async () => {
    const started = await startServer();
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-console-tty-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host console',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  RequestTTY yes',
      ].join('\n'),
    );
    manager = makeManager(configFile, {
      consoleCompatibilityForHost: (alias) => alias === 'console',
    });

    await manager.connectShell(
      { kind: 'ssh', target: 'console', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(started.stats).toMatchObject({
      execs: 0,
      ptyRequests: 1,
      sftpRequests: 0,
      shells: 1,
    });
  }, 15_000);

  it('automatically redials in plain-console mode when integration drops the transport', async () => {
    const started = await startServer({ disconnectOnExec: true });
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-auto-console-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host console',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
      ].join('\n'),
    );
    manager = makeManager(configFile);

    const first = await manager.connectShell(
      { kind: 'ssh', target: 'console', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(first.transport).toBe('new');
    expect(first.lease.connection.sftpAvailable).toBe(false);
    expect(started.stats).toMatchObject({ connections: 2, execs: 1, sftpRequests: 0, shells: 1 });

    // The inference is remembered for this manager lifetime, so subsequent
    // sessions reuse the compatible transport without probing again.
    const second = await manager.connectShell(
      { kind: 'ssh', target: 'console', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );
    expect(second.transport).toBe('shared');
    expect(second.lease.connection.id).toBe(first.lease.connection.id);
    expect(started.stats).toMatchObject({ connections: 2, execs: 1, sftpRequests: 0, shells: 2 });
    await expect(second.lease.connection.sftp()).rejects.toThrow(
      'SFTP is disabled for this host.',
    );
  }, 15_000);

  it('does not share transports between disable-SFTP and console modes', async () => {
    const started = await startServer();
    server = started.server;
    const configFile = path.join(tmp, `ssh_config-sftp-isolation-${knownHostsCounter}`);
    writeFileSync(
      configFile,
      [
        'Host legacy console',
        '  HostName 127.0.0.1',
        '  User tester',
        `  Port ${started.port}`,
        '  SetEnv MUXUS_TEST=from-config',
      ].join('\n'),
    );
    manager = makeManager(configFile, {
      disableSftpForHost: (alias) => alias === 'legacy',
      consoleCompatibilityForHost: (alias) => alias === 'console',
    });

    const legacy = await manager.connectShell(
      { kind: 'ssh', target: 'legacy', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );
    const consoleShell = await manager.connectShell(
      { kind: 'ssh', target: 'console', passwordOnly: true },
      makeIo().io,
      80,
      24,
      'xterm-256color',
    );

    expect(consoleShell.lease.connection.id).not.toBe(legacy.lease.connection.id);
    expect(started.stats.connections).toBe(2);
    expect(started.stats.envRequests).toBe(1);
  }, 15_000);
});
