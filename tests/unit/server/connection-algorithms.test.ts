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

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-algo-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'secret';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

/**
 * An sshd stand-in for an old console server: ssh-rsa host key only, and a
 * handshake restricted to the legacy algorithms modern clients disable by
 * default (aes128-cbc, diffie-hellman-group14-sha1).
 */
function startLegacyServer(): Promise<{ server: Server; port: number }> {
  const server = new Server(
    {
      hostKeys: [HOST_KEY],
      algorithms: {
        kex: ['diffie-hellman-group14-sha1'],
        cipher: ['aes128-cbc'],
        serverHostKey: ['ssh-rsa'],
      },
    },
    (conn) => {
      conn.on('error', () => undefined);
      conn.on('authentication', (authCtx) => {
        if (authCtx.method === 'password' && authCtx.password === PASSWORD) authCtx.accept();
        else authCtx.reject(['password']);
      });
      conn.on('ready', () => {
        conn.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty?.());
          session.on('exec', (acceptExec) => {
            const stream = acceptExec();
            stream.exit(0);
            stream.end();
          });
          session.on('sftp', (_acceptSftp, rejectSftp) => rejectSftp?.());
          session.on('shell', (acceptShell) => {
            acceptShell().write('console ready\n');
          });
        });
      });
    },
  );
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

let counter = 0;
function makeManager(configFile: string): SshConnectionManager {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${counter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
  });
}

function makeIo(): ConnectIo {
  return {
    status: () => undefined,
    prompt: (info) => Promise.resolve(info.prompts.map(() => PASSWORD)),
    hostKey: () => Promise.resolve(true),
  };
}

function writeConfig(port: number, algorithmLines: string[]): string {
  const file = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    file,
    [
      'Host console',
      '  HostName 127.0.0.1',
      '  User tester',
      `  Port ${port}`,
      '  PubkeyAuthentication no',
      ...algorithmLines,
      '',
    ].join('\n'),
  );
  return file;
}

const profile: SshProfile = { kind: 'ssh', target: 'console' };

describe('legacy algorithm negotiation', () => {
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

  it('fails against a legacy-only server when the config sets no algorithms', async () => {
    const started = await startLegacyServer();
    server = started.server;
    manager = makeManager(writeConfig(started.port, []));

    await expect(manager.connect(profile, makeIo())).rejects.toThrow(
      /no matching key exchange algorithm.*KexAlgorithms/s,
    );
  }, 15_000);

  it('connects once the config lists the legacy algorithms', async () => {
    const started = await startLegacyServer();
    server = started.server;
    manager = makeManager(
      writeConfig(started.port, [
        '  Ciphers aes128-cbc',
        '  KexAlgorithms +diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1',
        '  HostKeyAlgorithms +ssh-rsa',
      ]),
    );

    const shell = await manager.connectShell(profile, makeIo(), 80, 24, 'xterm-256color');
    const banner = await new Promise<string>((resolve) => {
      shell.stream.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    });
    expect(banner).toContain('console ready');
    shell.stream.close();
    shell.lease.release();
  }, 15_000);
});
