import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, utils, type ParsedKey } from 'ssh2';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import {
  buildChain,
  muxKey,
  SshConnectionManager,
  type ConnectIo,
} from '../../../server/src/ssh/connection-manager.js';
import {
  fingerprintMd5,
  fingerprintSha256,
  hostKeyMatchesFingerprint,
  KnownHostsStore,
} from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-host-key-pin-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'secret';
const ED25519 = utils.generateKeyPairSync('ed25519').private;
const RSA = utils.generateKeyPairSync('rsa', { bits: 2048 }).private;

function publicBlob(privateKey: string): Buffer {
  return (utils.parseKey(privateKey) as ParsedKey).getPublicSSH();
}

const ED25519_SHA256 = fingerprintSha256(publicBlob(ED25519));
const RSA_MD5 = fingerprintMd5(publicBlob(RSA)).slice(4);
const OTHER_SHA256 = fingerprintSha256(publicBlob(utils.generateKeyPairSync('ed25519').private));

function startServer(hostKeys: string[]): Promise<{ server: Server; port: number }> {
  const server = new Server({ hostKeys }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject(['password']);
    });
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        accept().on('shell', (acceptShell) => acceptShell().write('shell ok\n'));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

let counter = 0;

function setup(port: number, lines: string[] = []) {
  const knownHostsFile = path.join(tmp, `known_hosts-${counter}`);
  const configFile = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    configFile,
    ['Host lab', '  HostName 127.0.0.1', '  User tester', `  Port ${port}`, '  PubkeyAuthentication no', ...lines, ''].join('\n'),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(knownHostsFile, path.join(tmp, 'no-global-known-hosts')),
    loadConfig: () => loadConfigDocument(configFile),
  });
  return { manager, knownHostsFile };
}

function makeIo(hostKey: ConnectIo['hostKey'] = () => Promise.resolve(true)) {
  const statuses: string[] = [];
  const hostKeyPrompts: unknown[] = [];
  const io: ConnectIo = {
    status: (text: string) => {
      statuses.push(text);
    },
    prompt: (info: { prompts: Array<{ prompt: string }> }) =>
      Promise.resolve({ answers: info.prompts.map(() => PASSWORD) }),
    hostKey: (challenge) => {
      hostKeyPrompts.push(challenge);
      return hostKey(challenge);
    },
  } as ConnectIo;
  return { io, statuses, hostKeyPrompts };
}

function pinned(fingerprint: string): SshProfile {
  return { kind: 'ssh', target: 'lab', hostKeyFingerprint: fingerprint };
}

describe('host key fingerprints from ssh:// links', () => {
  let server: Server | undefined;
  let manager: SshConnectionManager | undefined;

  afterEach(async () => {
    manager?.closeAll();
    manager = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('refuses a server whose key does not match, before any known_hosts prompt', async () => {
    const started = await startServer([ED25519]);
    server = started.server;
    const { manager: created, knownHostsFile } = setup(started.port);
    manager = created;
    const { io, statuses, hostKeyPrompts } = makeIo();

    await expect(manager.connect(pinned(OTHER_SHA256), io)).rejects.toThrow();
    expect(hostKeyPrompts).toEqual([]);
    expect(statuses.join('\n')).toContain(`HOST KEY MISMATCH for 127.0.0.1: the link expects ${OTHER_SHA256}`);
    expect(statuses.join('\n')).toContain(ED25519_SHA256);
    expect(existsSync(knownHostsFile)).toBe(false);
  }, 15_000);

  it('refuses a mismatch even when known_hosts or StrictHostKeyChecking would let the key in', async () => {
    const started = await startServer([ED25519]);
    server = started.server;
    const { manager: trusting } = setup(started.port, ['  StrictHostKeyChecking no']);
    manager = trusting;
    await expect(manager.connect(pinned(OTHER_SHA256), makeIo().io)).rejects.toThrow();

    // The key is already trusted: a plain connect works, a mismatching link does not.
    manager.closeAll();
    const { manager: known } = setup(started.port);
    manager = known;
    const plain = await manager.connect({ kind: 'ssh', target: 'lab' }, makeIo().io);
    plain.release();
    manager.closeAll();
    await expect(manager.connect(pinned(OTHER_SHA256), makeIo().io)).rejects.toThrow();
  }, 15_000);

  it('still asks before trusting a new host whose key matches, and says it matches', async () => {
    const started = await startServer([ED25519]);
    server = started.server;
    const { manager: created, knownHostsFile } = setup(started.port);
    manager = created;
    const { io, statuses, hostKeyPrompts } = makeIo();

    const lease = await manager.connect(pinned(ED25519_SHA256), io);
    expect(hostKeyPrompts).toHaveLength(1);
    expect(statuses).toContain('The ssh-ed25519 host key of 127.0.0.1 matches the fingerprint in the link.');
    expect(readFileSync(knownHostsFile, 'utf8')).toContain(`[127.0.0.1]:${started.port}`);
    lease.release();

    // Declining the prompt still blocks: the link never trusts a key by itself.
    manager.closeAll();
    const { manager: declining } = setup(started.port);
    manager = declining;
    await expect(
      manager.connect(pinned(ED25519_SHA256), makeIo(() => Promise.resolve(false)).io),
    ).rejects.toThrow();
  }, 15_000);

  it('connects without a prompt when the key matches and is already known', async () => {
    const started = await startServer([ED25519]);
    server = started.server;
    const { manager: created } = setup(started.port);
    manager = created;
    (await manager.connect({ kind: 'ssh', target: 'lab' }, makeIo().io)).release();
    manager.closeAll();

    const { io, hostKeyPrompts } = makeIo(() => Promise.reject(new Error('must not prompt')));
    const lease = await manager.connect(pinned(ED25519_SHA256), io);
    expect(hostKeyPrompts).toEqual([]);
    lease.release();
  }, 15_000);

  it('never shares an open transport whose key the link has not checked', async () => {
    const started = await startServer([ED25519]);
    server = started.server;
    const { manager: created } = setup(started.port);
    manager = created;
    const plain = await manager.connect({ kind: 'ssh', target: 'lab' }, makeIo().io);

    await expect(manager.connect(pinned(OTHER_SHA256), makeIo().io)).rejects.toThrow();
    const matching = await manager.connect(pinned(ED25519_SHA256), makeIo().io);
    expect(matching.reused).toBe(false);
    expect(matching.connection.id).not.toBe(plain.connection.id);
    // Two sessions from the same link may share their own transport.
    const again = await manager.connect(pinned(ED25519_SHA256), makeIo().io);
    expect(again.reused).toBe(true);
    for (const lease of [plain, matching, again]) lease.release();
  }, 15_000);

  it('asks a server with several keys for the key type a draft fingerprint names', async () => {
    const started = await startServer([ED25519, RSA]);
    server = started.server;
    const { manager: created } = setup(started.port);
    manager = created;
    const { io, statuses } = makeIo();

    const lease = await manager.connect(pinned(`ssh-rsa MD5:${RSA_MD5}`), io);
    expect(statuses).toContain('The ssh-rsa host key of 127.0.0.1 matches the fingerprint in the link.');
    lease.release();
    manager.closeAll();

    // The right digest under the wrong key type is a mismatch.
    await expect(
      manager.connect(pinned(`ssh-ed25519 MD5:${RSA_MD5}`), makeIo().io),
    ).rejects.toThrow();
  }, 15_000);
});

describe('host key fingerprint plumbing', () => {
  it('compares SHA256, MD5 and key-typed fingerprints', () => {
    const key = publicBlob(ED25519);
    const md5 = fingerprintMd5(key);
    expect(md5).toMatch(/^MD5:([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
    expect(hostKeyMatchesFingerprint(key, ED25519_SHA256)).toBe(true);
    expect(hostKeyMatchesFingerprint(key, OTHER_SHA256)).toBe(false);
    expect(hostKeyMatchesFingerprint(key, md5)).toBe(true);
    expect(hostKeyMatchesFingerprint(key, `ssh-ed25519 ${md5}`)).toBe(true);
    expect(hostKeyMatchesFingerprint(key, `ssh-rsa ${md5}`)).toBe(false);
  });

  it('pins only the target hop and keeps pinned transports apart', () => {
    const configFile = path.join(tmp, `chain-config-${counter++}`);
    writeFileSync(
      configFile,
      ['Host jump', '  HostName 10.0.0.1', 'Host target', '  HostName 10.0.0.2', '  ProxyJump jump', ''].join('\n'),
    );
    const doc = loadConfigDocument(configFile);
    const chain = buildChain(doc, { target: 'target', hostKeyFingerprint: ED25519_SHA256 });
    expect(chain.map((hop) => hop.hostKeyFingerprint)).toEqual([undefined, ED25519_SHA256]);
    expect(muxKey(chain)).not.toBe(muxKey(buildChain(doc, { target: 'target' })));
    expect(muxKey(chain.slice(0, 1))).toBe(muxKey(buildChain(doc, { target: 'target' }).slice(0, 1)));
  });

  it('keeps a link fingerprint when a saved host supplies the connection fields', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const manager = new SshConnectionManager(log as never, {
      knownHosts: new KnownHostsStore(path.join(tmp, 'unused'), path.join(tmp, 'unused-global')),
      loadConfig: () => loadConfigDocument(path.join(tmp, 'missing-config')),
      savedSshProfile: (id) =>
        id === 'saved-1'
          ? { kind: 'ssh', profileId: 'saved-1', target: '192.0.2.1', useConfig: false }
          : undefined,
    });
    expect(
      manager.resolveProfile({
        kind: 'ssh',
        profileId: 'saved-1',
        target: 'ignored',
        hostKeyFingerprint: ED25519_SHA256,
      }),
    ).toMatchObject({ target: '192.0.2.1', hostKeyFingerprint: ED25519_SHA256 });
  });
});
