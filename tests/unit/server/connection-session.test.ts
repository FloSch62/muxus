import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import {
  PasswordVault,
  sshPasswordAccount,
} from '../../../server/src/security/password-vault.js';
import {
  MemoryVaultKeyStore,
  VaultKeyStoreUnavailableError,
} from '../../../server/src/security/vault-key-store.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-session-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'secret';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

interface SessionCapture {
  env: Record<string, string>;
  exec?: string;
  ptyRequested: boolean;
  shellRequested: boolean;
  authMethods: string[];
}

/** sshd stand-in that records what the client requested on its session. */
function startCapturingServer(): Promise<{ server: Server; port: number; capture: SessionCapture }> {
  const capture: SessionCapture = { env: {}, ptyRequested: false, shellRequested: false, authMethods: [] };
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (authCtx) => {
      if (authCtx.method !== 'none') capture.authMethods.push(authCtx.method);
      if (authCtx.method === 'password' && authCtx.password === PASSWORD) authCtx.accept();
      else authCtx.reject(['password']);
    });
    conn.on('ready', () => {
      conn.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('env', (accept, _reject, info) => {
          capture.env[info.key] = info.val;
          accept?.();
        });
        session.on('pty', (acceptPty) => {
          capture.ptyRequested = true;
          acceptPty?.();
        });
        session.on('exec', (acceptExec, _rejectExec, info) => {
          capture.exec = info.command;
          const stream = acceptExec();
          stream.write('exec ok\n');
        });
        session.on('sftp', (_acceptSftp, rejectSftp) => rejectSftp?.());
        session.on('shell', (acceptShell) => {
          capture.shellRequested = true;
          acceptShell().write('shell ok\n');
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, capture });
    });
  });
}

let counter = 0;
function makeManager(
  configFile: string,
  vault?: PasswordVault,
): SshConnectionManager {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${counter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
    vault,
  });
}

function makeIo(overrides: Partial<ConnectIo> = {}): ConnectIo & { passwordPrompts: number } {
  const io = {
    passwordPrompts: 0,
    status: () => undefined,
    prompt: (info: { prompts: Array<{ prompt: string }> }) => {
      io.passwordPrompts += info.prompts.length;
      return Promise.resolve({
        answers: info.prompts.map(() => PASSWORD),
      });
    },
    hostKey: () => Promise.resolve(true),
    ...overrides,
  };
  return io;
}

function writeConfig(port: number, lines: string[]): string {
  const file = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    file,
    ['Host lab', '  HostName 127.0.0.1', '  User tester', `  Port ${port}`, '  PubkeyAuthentication no', ...lines, ''].join('\n'),
  );
  return file;
}

const profile: SshProfile = { kind: 'ssh', target: 'lab' };

async function firstData(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => stream.once('data', (chunk: Buffer) => resolve(chunk.toString())));
}

describe('session settings from ssh config', () => {
  let manager: SshConnectionManager | undefined;
  let server: Server | undefined;
  let database: MuxusDatabase | undefined;
  let vault: PasswordVault | undefined;

  afterEach(async () => {
    manager?.closeAll();
    manager = undefined;
    vault?.lock();
    database?.close();
    vault = undefined;
    database = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('sends SetEnv/SendEnv variables and runs RemoteCommand without a tty by default', async () => {
    const started = await startCapturingServer();
    server = started.server;
    manager = makeManager(
      writeConfig(started.port, ['  SetEnv MUXUS_TEST=from-config', '  RemoteCommand tmux new -A -s main']),
    );

    const shell = await manager.connectShell(profile, makeIo(), 80, 24, 'xterm-256color');
    expect(await firstData(shell.stream)).toContain('exec ok');
    expect(started.capture.exec).toBe('tmux new -A -s main');
    expect(started.capture.ptyRequested).toBe(false); // RequestTTY auto + command ⇒ no tty, like ssh(1)
    expect(started.capture.shellRequested).toBe(false);
    expect(started.capture.env).toMatchObject({ MUXUS_TEST: 'from-config' });
    shell.stream.close();
    shell.lease.release();
  }, 15_000);

  it('RequestTTY yes allocates a tty for a RemoteCommand', async () => {
    const started = await startCapturingServer();
    server = started.server;
    manager = makeManager(writeConfig(started.port, ['  RemoteCommand tmux attach', '  RequestTTY yes']));

    const shell = await manager.connectShell(profile, makeIo(), 80, 24, 'xterm-256color');
    expect(await firstData(shell.stream)).toContain('exec ok');
    expect(started.capture.ptyRequested).toBe(true);
    shell.stream.close();
    shell.lease.release();
  }, 15_000);

  it('StrictHostKeyChecking accept-new records into UserKnownHostsFile without prompting', async () => {
    const started = await startCapturingServer();
    server = started.server;
    const hostsFile = path.join(tmp, `custom_known_hosts-${counter++}`);
    manager = makeManager(
      writeConfig(started.port, ['  StrictHostKeyChecking accept-new', `  UserKnownHostsFile ${hostsFile}`]),
    );

    const io = makeIo({ hostKey: () => Promise.reject(new Error('must not prompt')) });
    const shell = await manager.connectShell(profile, io, 80, 24, 'xterm-256color');
    expect(await firstData(shell.stream)).toContain('shell ok');
    expect(existsSync(hostsFile)).toBe(true);
    expect(readFileSync(hostsFile, 'utf8')).toContain(`[127.0.0.1]:${started.port}`);
    shell.stream.close();
    shell.lease.release();
  }, 15_000);

  it('connects without persisting when UserKnownHostsFile is the null device', async () => {
    const started = await startCapturingServer();
    server = started.server;
    manager = makeManager(
      writeConfig(started.port, [
        '  StrictHostKeyChecking no',
        `  UserKnownHostsFile ${os.devNull}`,
      ]),
    );

    const io = makeIo({
      hostKey: () => Promise.reject(new Error('must not prompt')),
    });
    const shell = await manager.connectShell(profile, io, 80, 24, 'xterm-256color');
    expect(await firstData(shell.stream)).toContain('shell ok');
    shell.stream.close();
    shell.lease.release();
  }, 15_000);

  it('fails promptly when the host-key interaction rejects', async () => {
    const started = await startCapturingServer();
    server = started.server;
    manager = makeManager(writeConfig(started.port, ['  ConnectTimeout 5']));
    const io = makeIo({
      hostKey: () => Promise.reject(new Error('host-key dialog closed')),
    });

    await expect(manager.connect(profile, io)).rejects.toThrow(/host/i);
  }, 2_000);

  it('PasswordAuthentication no never prompts for or offers a password', async () => {
    const started = await startCapturingServer();
    server = started.server;
    manager = makeManager(writeConfig(started.port, ['  PasswordAuthentication no']));

    const io = makeIo();
    await expect(manager.connect(profile, io)).rejects.toThrow(/authentication/);
    expect(io.passwordPrompts).toBe(0);
    expect(started.capture.authMethods).not.toContain('password');
  }, 15_000);

  it('remembers a successful password in the OS keyring and reuses it after restart', async () => {
    const started = await startCapturingServer();
    server = started.server;
    const config = writeConfig(started.port, []);
    database = new MuxusDatabase(':memory:');
    const keyStore = new MemoryVaultKeyStore();
    vault = new PasswordVault(database, {
      kdf: { cost: 1024, blockSize: 8, parallelism: 1 },
      keyStore,
    });
    manager = makeManager(config, vault);
    const master = 'correct horse battery staple';

    const firstIo = makeIo({
      prompt: (info) => {
        if (info.purpose === 'ssh-password') {
          return Promise.resolve({
            answers: [PASSWORD],
            rememberPassword: true,
          });
        }
        if (info.purpose === 'vault-create') {
          return Promise.resolve({ answers: [master, master] });
        }
        throw new Error(`unexpected prompt: ${info.purpose}`);
      },
    });
    const first = await manager.connect(profile, firstIo);
    await vi.waitFor(() => {
      expect(vault!.status()).toMatchObject({
        configured: true,
        unlockPolicy: 'never',
        locked: false,
        credentialCount: 1,
      });
    });
    first.release();
    manager.closeAll();

    vault.dispose();
    vault = new PasswordVault(database, {
      kdf: { cost: 1024, blockSize: 8, parallelism: 1 },
      keyStore,
    });
    await vault.initialize();
    manager = makeManager(config, vault);
    const secondIo = makeIo({
      prompt: (info) => {
        throw new Error(
          `authentication prompt was not expected: ${info.purpose}`,
        );
      },
    });
    const second = await manager.connect(profile, secondIo);
    expect(vault.status().locked).toBe(false);
    expect(secondIo.passwordPrompts).toBe(0);
    second.release();
  }, 15_000);

  it('replaces a rejected saved password only after the new password succeeds', async () => {
    const started = await startCapturingServer();
    server = started.server;
    const config = writeConfig(started.port, []);
    database = new MuxusDatabase(':memory:');
    vault = new PasswordVault(database, {
      kdf: { cost: 1024, blockSize: 8, parallelism: 1 },
    });
    await vault.create('correct horse battery staple');
    const account = sshPasswordAccount({
      user: 'tester',
      host: '127.0.0.1',
      port: started.port,
    });
    await vault.rememberSshPassword(
      account,
      `tester@127.0.0.1:${started.port}`,
      'stale-password',
    );
    manager = makeManager(config, vault);

    const io = makeIo({
      prompt: (info) => {
        if (info.purpose !== 'ssh-password') {
          throw new Error(`unexpected prompt: ${info.purpose}`);
        }
        return Promise.resolve({
          answers: [PASSWORD],
          rememberPassword: true,
        });
      },
    });
    const lease = await manager.connect(profile, io);
    await vi.waitFor(async () => {
      await expect(vault!.sshPassword(account)).resolves.toBe(PASSWORD);
    });
    lease.release();
  }, 15_000);

  it('falls back to a manual password when vault access reports an unavailable keyring', async () => {
    const started = await startCapturingServer();
    server = started.server;
    const config = writeConfig(started.port, []);
    database = new MuxusDatabase(':memory:');
    vault = new PasswordVault(database, {
      kdf: { cost: 1024, blockSize: 8, parallelism: 1 },
    });
    await vault.create('correct horse battery staple');
    const account = sshPasswordAccount({
      user: 'tester',
      host: '127.0.0.1',
      port: started.port,
    });
    await vault.rememberSshPassword(
      account,
      `tester@127.0.0.1:${started.port}`,
      PASSWORD,
    );
    vi.spyOn(vault, 'sshPassword').mockRejectedValueOnce(
      new VaultKeyStoreUnavailableError(),
    );
    manager = makeManager(config, vault);
    const statuses: string[] = [];
    const io = makeIo({
      status: (message) => statuses.push(message),
    });

    const lease = await manager.connect(profile, io);
    expect(io.passwordPrompts).toBe(1);
    expect(statuses).toContain(
      `The OS credential store is unavailable. Enter the current password for tester@127.0.0.1:${started.port}.`,
    );
    lease.release();
  }, 15_000);

  it('pauses ConnectTimeout while the user unlocks a saved password', async () => {
    const started = await startCapturingServer();
    server = started.server;
    const config = writeConfig(started.port, ['  ConnectTimeout 1']);
    database = new MuxusDatabase(':memory:');
    vault = new PasswordVault(database, {
      kdf: { cost: 1024, blockSize: 8, parallelism: 1 },
    });
    await vault.create('correct horse battery staple', 'startup');
    await vault.rememberSshPassword(
      sshPasswordAccount({
        user: 'tester',
        host: '127.0.0.1',
        port: started.port,
      }),
      `tester@127.0.0.1:${started.port}`,
      PASSWORD,
    );
    vault.lock();
    manager = makeManager(config, vault);
    const io = makeIo({
      prompt: async (info) => {
        if (info.purpose !== 'vault-unlock') {
          throw new Error(`unexpected prompt: ${info.purpose}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        return { answers: ['correct horse battery staple'] };
      },
    });

    const lease = await manager.connect(profile, io);
    expect(vault.status().locked).toBe(false);
    lease.release();
  }, 15_000);

  it('does not hold connection readiness on the remember-password dialog', async () => {
    const started = await startCapturingServer();
    server = started.server;
    const config = writeConfig(started.port, []);
    database = new MuxusDatabase(':memory:');
    vault = new PasswordVault(database, {
      kdf: { cost: 1024, blockSize: 8, parallelism: 1 },
    });
    manager = makeManager(config, vault);
    const master = 'correct horse battery staple';
    let createPromptSeen = false;
    let finishCreate:
      | ((response: { answers: string[] }) => void)
      | undefined;
    const createResponse = new Promise<{ answers: string[] }>((resolve) => {
      finishCreate = resolve;
    });
    const io = makeIo({
      prompt: (info) => {
        if (info.purpose === 'ssh-password') {
          return Promise.resolve({
            answers: [PASSWORD],
            rememberPassword: true,
          });
        }
        if (info.purpose === 'vault-create') {
          createPromptSeen = true;
          return createResponse;
        }
        throw new Error(`unexpected prompt: ${info.purpose}`);
      },
    });

    const lease = await manager.connect(profile, io);
    await vi.waitFor(() => expect(createPromptSeen).toBe(true));
    expect(vault.status().configured).toBe(false);
    let postAuthSettled = false;
    void lease.connection.waitForPostAuth().then(() => {
      postAuthSettled = true;
    });
    await Promise.resolve();
    expect(postAuthSettled).toBe(false);

    finishCreate!({ answers: [master, master] });
    await lease.connection.waitForPostAuth();
    expect(postAuthSettled).toBe(true);
    await vi.waitFor(() => {
      expect(vault!.status()).toMatchObject({
        configured: true,
        credentialCount: 1,
      });
    });
    lease.release();
  }, 15_000);
});
