import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthPromptInfo, ExternalPasswordRef } from '@muxus/shared';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { PasswordManagers } from '../../../server/src/password-managers/password-managers.js';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { folderAuthResolver } from '../../../server/src/ssh/folder-auth.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

/** Written by KeePassXC; "Servers/web1" holds the password the test server accepts. */
const DATABASE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'keepassxc-kdbx3.kdbx');
const DATABASE_PASSWORD = 'master-pw-1';
const PASSWORD = 'hunter2-säcret';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-password-manager-login-'));
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

/** Password-only sshd stand-in that records what it was offered. */
function startServer(): Promise<{ server: Server; port: number; offered: string[] }> {
  const offered: string[] = [];
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        offered.push(ctx.password);
        if (ctx.password === PASSWORD) return ctx.accept();
      }
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
      resolve({ server, port: (server.address() as net.AddressInfo).port, offered });
    });
  });
}

let counter = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(): Promise<{
  manager: SshConnectionManager;
  managers: PasswordManagers;
  database: MuxusDatabase;
  ref: ExternalPasswordRef;
  sourceId: string;
  offered: string[];
}> {
  const { server, port, offered } = await startServer();
  const configFile = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    configFile,
    ['Host lab', '  HostName 127.0.0.1', '  User tester', `  Port ${port}`, '  StrictHostKeyChecking no', ''].join('\n'),
  );
  const database = new MuxusDatabase(':memory:');
  const managers = new PasswordManagers(database);
  const source = await managers.create({ kind: 'keepass', config: { path: DATABASE } });
  await managers.unlock(source.id, DATABASE_PASSWORD);
  const entry = (await managers.entries(source.id)).find((candidate) => candidate.title === 'web1')!;
  await managers.lock(source.id);
  database.updateOpenSshMetadata('lab', { group: 'Lab' });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${counter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
    passwordManagers: managers,
    passwordRefs: { forHost: (alias) => database.passwordRefForAlias(alias) },
    folderAuth: folderAuthResolver(database),
  });
  cleanups.push(() => {
    manager.closeAll();
    managers.dispose();
    database.close();
    server.close();
  });
  return {
    manager,
    managers,
    database,
    ref: { sourceId: source.id, entryId: entry.id, title: entry.title, username: entry.username },
    sourceId: source.id,
    offered,
  };
}

interface TestIo extends ConnectIo {
  prompts: AuthPromptInfo[];
  statuses: string[];
}

/** Answers each prompt by its purpose; `unlock` lists the database passwords to try, in order. */
function makeIo(unlock: Array<string | null> = []): TestIo {
  const io = {
    prompts: [] as AuthPromptInfo[],
    statuses: [] as string[],
    status: (message: string) => void io.statuses.push(message),
    prompt: (info: AuthPromptInfo) => {
      io.prompts.push(info);
      if (info.purpose === 'vault-unlock') {
        const answer = unlock.shift();
        return Promise.resolve(answer === null || answer === undefined ? { answers: [], skipped: true } : { answers: [answer] });
      }
      return Promise.resolve({ answers: info.prompts.map(() => PASSWORD) });
    },
    hostKey: () => Promise.resolve(true),
  };
  return io as unknown as TestIo;
}

const profile: SshProfile = { kind: 'ssh', target: 'lab' };
const purposes = (io: TestIo) => io.prompts.map((prompt) => prompt.purpose);

describe('logging in with a password-manager entry', () => {
  it('uses the host entry from an unlocked database without any prompt', async () => {
    const { manager, managers, database, ref, sourceId, offered } = await setup();
    database.updateOpenSshMetadata('lab', { passwordRef: ref });
    await managers.unlock(sourceId, DATABASE_PASSWORD);

    const io = makeIo();
    (await manager.connect(profile, io)).release();

    expect(io.prompts).toEqual([]);
    expect(offered).toEqual([PASSWORD]);
    expect(io.statuses.some((status) => status.includes('“web1”'))).toBe(true);
  });

  it('asks for the database password when the database is locked, retrying a wrong one', async () => {
    const { manager, database, ref, offered } = await setup();
    database.updateOpenSshMetadata('lab', { passwordRef: ref });

    const io = makeIo(['not-it', DATABASE_PASSWORD]);
    (await manager.connect(profile, io)).release();

    expect(purposes(io)).toEqual(['vault-unlock', 'vault-unlock']);
    expect(io.prompts[0]!.prompts).toEqual([{ prompt: 'Database password', echo: false }]);
    expect(io.prompts[1]!.instructions).toContain('The database password is wrong.');
    expect(offered).toEqual([PASSWORD]);

    // The database stays unlocked for the next connection.
    manager.closeAll();
    const again = makeIo();
    (await manager.connect(profile, again)).release();
    expect(again.prompts).toEqual([]);
  });

  it('falls back to asking for the password when unlocking is skipped', async () => {
    const { manager, database, ref, offered } = await setup();
    database.updateOpenSshMetadata('lab', { passwordRef: ref });

    const io = makeIo([null]);
    (await manager.connect(profile, io)).release();

    expect(purposes(io)).toEqual(['vault-unlock', 'ssh-password']);
    expect(offered).toEqual([PASSWORD]);
  });

  it('uses the folder entry for a host without one of its own', async () => {
    const { manager, managers, database, ref, sourceId, offered } = await setup();
    database.upsertFolderSettings('Lab', { passwordRef: ref });
    await managers.unlock(sourceId, DATABASE_PASSWORD);

    const io = makeIo();
    (await manager.connect(profile, io)).release();

    expect(io.prompts).toEqual([]);
    expect(offered).toEqual([PASSWORD]);
  });

  it('prefers the host entry over the folder entry', async () => {
    const { manager, managers, database, ref, sourceId, offered } = await setup();
    const router = (await (async () => {
      await managers.unlock(sourceId, DATABASE_PASSWORD);
      return managers.entries(sourceId);
    })()).find((entry) => entry.title === 'Core router')!;
    database.upsertFolderSettings('Lab', {
      passwordRef: { sourceId, entryId: router.id, title: router.title },
    });
    database.updateOpenSshMetadata('lab', { passwordRef: ref });

    const io = makeIo();
    (await manager.connect(profile, io)).release();

    expect(offered).toEqual([PASSWORD]);
  });

  it('reports an entry or a password manager that is gone and asks instead', async () => {
    const { manager, managers, database, ref, sourceId, offered } = await setup();
    await managers.unlock(sourceId, DATABASE_PASSWORD);
    database.updateOpenSshMetadata('lab', {
      passwordRef: { ...ref, entryId: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    });
    const missingEntry = makeIo();
    (await manager.connect(profile, missingEntry)).release();
    expect(purposes(missingEntry)).toEqual(['ssh-password']);
    expect(missingEntry.statuses.join('\n')).toContain('no longer in the KeePass database');

    manager.closeAll();
    database.updateOpenSshMetadata('lab', { passwordRef: ref });
    managers.remove(sourceId);
    const missingSource = makeIo();
    (await manager.connect(profile, missingSource)).release();
    expect(purposes(missingSource)).toEqual(['ssh-password']);
    expect(missingSource.statuses.join('\n')).toContain('no longer connected');
    expect(offered).toEqual([PASSWORD, PASSWORD]);
  });

  it('asks for the password when the entry holds one the server rejects', async () => {
    const { manager, managers, database, sourceId, offered } = await setup();
    await managers.unlock(sourceId, DATABASE_PASSWORD);
    const router = (await managers.entries(sourceId)).find((entry) => entry.title === 'Core router')!;
    database.updateOpenSshMetadata('lab', {
      passwordRef: { sourceId, entryId: router.id, title: router.title },
    });

    const io = makeIo();
    (await manager.connect(profile, io)).release();

    expect(purposes(io)).toEqual(['ssh-password']);
    expect(offered).toEqual(['router-pw', PASSWORD]);
  });

  it('unlinks an entry with a null patch', async () => {
    const { database, ref } = await setup();
    database.updateOpenSshMetadata('lab', { passwordRef: ref });
    expect(database.passwordRefForAlias('lab')).toEqual(ref);
    // Other edits leave the link alone.
    database.updateOpenSshMetadata('lab', { color: '#112233' });
    expect(database.passwordRefForAlias('lab')).toEqual(ref);
    database.updateOpenSshMetadata('lab', { passwordRef: null });
    expect(database.passwordRefForAlias('lab')).toBeUndefined();
  });
});
