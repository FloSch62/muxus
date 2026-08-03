import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Server } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import {
  PasswordVault,
  folderPasswordAccount,
  folderPasswordLabel,
  sshPasswordAccount,
  sshPasswordLabel,
} from '../../../server/src/security/password-vault.js';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { folderAuthResolver } from '../../../server/src/ssh/folder-auth.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-folder-password-'));
const PASSWORD = 'shared-folder-password';
const MASTER = 'master-pass-12';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const savedEnv = { HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
beforeAll(() => {
  // No real agent and no real ~/.ssh keys: the ladder must reach password auth.
  process.env.HOME = tmp;
  delete process.env.SSH_AUTH_SOCK;
});
afterAll(() => {
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.SSH_AUTH_SOCK !== undefined) process.env.SSH_AUTH_SOCK = savedEnv.SSH_AUTH_SOCK;
  rmSync(tmp, { recursive: true, force: true });
});

interface AuthEvent {
  method: string;
  accepted?: boolean;
}

/** Password-only sshd stand-in. */
function startServer(): Promise<{ server: Server; port: number; events: AuthEvent[] }> {
  const events: AuthEvent[] = [];
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        events.push({ method: 'password', accepted: ctx.password === PASSWORD });
        if (ctx.password === PASSWORD) return ctx.accept();
        return ctx.reject(['password']);
      }
      if (ctx.method !== 'none') events.push({ method: ctx.method });
      ctx.reject(['password']);
    });
    conn.on('ready', () => {
      conn.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('shell', (acceptShell) => acceptShell().write('shell ok\n'));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, events });
    });
  });
}

let counter = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function makeVaultedManager(port: number): Promise<{
  manager: SshConnectionManager;
  vault: PasswordVault;
  database: MuxusDatabase;
}> {
  const configFile = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    configFile,
    ['Host lab', '  HostName 127.0.0.1', '  User tester', `  Port ${port}`, '  StrictHostKeyChecking no', ''].join('\n'),
  );
  const database = new MuxusDatabase(':memory:');
  const vault = new PasswordVault(database);
  await vault.initialize();
  await vault.create(MASTER, 'never');
  database.updateOpenSshMetadata('lab', { group: 'Lab' });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${counter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
    vault,
    folderAuth: folderAuthResolver(database),
  });
  cleanups.push(() => {
    manager.closeAll();
    vault.dispose();
    database.close();
  });
  return { manager, vault, database };
}

function makeIo(): ConnectIo & { passwordPrompts: number } {
  const io = {
    passwordPrompts: 0,
    status: () => undefined,
    prompt: (info: { prompts: Array<{ prompt: string }> }) => {
      io.passwordPrompts += info.prompts.length;
      return Promise.resolve({ answers: info.prompts.map(() => PASSWORD) });
    },
    hostKey: () => Promise.resolve(true),
  };
  return io as unknown as ConnectIo & { passwordPrompts: number };
}

async function storeFolderPassword(
  vault: PasswordVault,
  database: MuxusDatabase,
  password: string,
): Promise<void> {
  const row = database.upsertFolderSettings('Lab', {});
  await vault.rememberSshPassword(
    folderPasswordAccount(row.id),
    folderPasswordLabel(row.path),
    password,
  );
}

const profile: SshProfile = { kind: 'ssh', target: 'lab' };

describe('folder password authentication', () => {
  it('logs in with the folder password without prompting', async () => {
    const { server, port, events } = await startServer();
    cleanups.push(() => server.close());
    const { manager, vault, database } = await makeVaultedManager(port);
    await storeFolderPassword(vault, database, PASSWORD);

    const io = makeIo();
    const lease = await manager.connect(profile, io);
    lease.release();

    expect(io.passwordPrompts).toBe(0);
    expect(events.filter((e) => e.method === 'password')).toEqual([
      { method: 'password', accepted: true },
    ]);
  });

  it('prefers the host-saved password over the folder password', async () => {
    const { server, port, events } = await startServer();
    cleanups.push(() => server.close());
    const { manager, vault, database } = await makeVaultedManager(port);
    await storeFolderPassword(vault, database, 'wrong-folder-password');
    const hostRef = { user: 'tester', host: '127.0.0.1', port };
    await vault.rememberSshPassword(
      sshPasswordAccount(hostRef),
      sshPasswordLabel(hostRef),
      PASSWORD,
    );

    const io = makeIo();
    const lease = await manager.connect(profile, io);
    lease.release();

    expect(io.passwordPrompts).toBe(0);
    // The wrong folder password was never offered.
    expect(events.filter((e) => e.method === 'password')).toEqual([
      { method: 'password', accepted: true },
    ]);
  });

  it('falls back to prompting when the folder password is rejected', async () => {
    const { server, port, events } = await startServer();
    cleanups.push(() => server.close());
    const { manager, vault, database } = await makeVaultedManager(port);
    await storeFolderPassword(vault, database, 'stale-folder-password');

    const io = makeIo();
    const lease = await manager.connect(profile, io);
    lease.release();

    expect(io.passwordPrompts).toBe(1);
    expect(events.filter((e) => e.method === 'password')).toEqual([
      { method: 'password', accepted: false },
      { method: 'password', accepted: true },
    ]);
  });
});
