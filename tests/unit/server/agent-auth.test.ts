import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import ssh2, { Server } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const { utils } = ssh2;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-agent-auth-'));
const PASSWORD = 'fallback-password';
const KEY_PASSPHRASE = 'k3y-pass';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

interface AuthEvent {
  method: string;
  accepted?: boolean;
}

let agentPid = '';
let agentSock = '';
let agentPub: ssh2.ParsedKey;
const savedEnv = { HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };

/** sshd stand-in accepting one public key (none when null) or the password. */
function startServer(
  allowed: ssh2.ParsedKey | null,
): Promise<{ server: Server; port: number; events: AuthEvent[] }> {
  const events: AuthEvent[] = [];
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') {
        const matches =
          !!allowed && ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH());
        const event: AuthEvent = { method: 'publickey' };
        events.push(event);
        if (matches) {
          if (!ctx.signature) return ctx.accept(); // pk-ok probe
          if (allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) {
            event.accepted = true;
            return ctx.accept();
          }
        }
        return ctx.reject(['publickey', 'password']);
      }
      if (ctx.method === 'password') {
        events.push({ method: 'password', accepted: ctx.password === PASSWORD });
        if (ctx.password === PASSWORD) return ctx.accept();
        return ctx.reject(['publickey', 'password']);
      }
      if (ctx.method !== 'none') events.push({ method: ctx.method });
      ctx.reject(['publickey', 'password']);
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
function makeManager(port: number): SshConnectionManager {
  const configFile = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    configFile,
    ['Host lab', '  HostName 127.0.0.1', '  User tester', `  Port ${port}`, '  StrictHostKeyChecking no', ''].join('\n'),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(
      path.join(tmp, `known_hosts-${counter++}`),
      path.join(tmp, 'no-global-known-hosts'),
    ),
    loadConfig: () => loadConfigDocument(configFile),
  });
}

function makeIo(): ConnectIo & {
  passwordPrompts: number;
  passphrasePrompts: number;
  statuses: string[];
} {
  const io = {
    passwordPrompts: 0,
    passphrasePrompts: 0,
    statuses: [] as string[],
    status: (message: string) => {
      io.statuses.push(message);
    },
    prompt: (info: { prompts: Array<{ prompt: string }> }) => {
      const answers = info.prompts.map((p) => {
        if (/passphrase/i.test(p.prompt)) {
          io.passphrasePrompts += 1;
          return KEY_PASSPHRASE;
        }
        io.passwordPrompts += 1;
        return PASSWORD;
      });
      return Promise.resolve({ answers });
    },
    hostKey: () => Promise.resolve(true),
  };
  return io as unknown as ConnectIo & {
    passwordPrompts: number;
    passphrasePrompts: number;
    statuses: string[];
  };
}

const profile: SshProfile = { kind: 'ssh', target: 'lab' };

async function connectOnce(port: number, io: ConnectIo): Promise<void> {
  const manager = makeManager(port);
  const lease = await manager.connect(profile, io);
  lease.release();
  manager.closeAll();
}

// Drives a real ssh-agent; the Windows agent is a service and cannot be
// spawned ad hoc, so this suite runs on POSIX only.
describe.skipIf(process.platform === 'win32')('ssh-agent authentication', () => {
  beforeAll(() => {
    const keyPath = path.join(tmp, 'agent-key');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'muxus-test'], {
      stdio: 'ignore',
    });
    const out = execFileSync('ssh-agent', ['-s']).toString();
    const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(out)?.[1];
    const pid = /SSH_AGENT_PID=(\d+);/.exec(out)?.[1];
    if (!sock || !pid) throw new Error(`unexpected ssh-agent output: ${out}`);
    agentSock = sock;
    agentPid = pid;
    execFileSync('ssh-add', [keyPath], {
      env: { ...process.env, SSH_AUTH_SOCK: agentSock },
      stdio: 'ignore',
    });
    const parsed = utils.parseKey(readFileSync(`${keyPath}.pub`));
    if (parsed instanceof Error) throw parsed;
    agentPub = parsed;

    // Isolate from the developer's ~/.ssh so no default identity files exist.
    process.env.HOME = tmp;
    process.env.SSH_AUTH_SOCK = agentSock;
  });

  afterAll(() => {
    if (agentPid) execFileSync('kill', [agentPid]);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('authenticates with a key held only by the agent, without any prompt', async () => {
    const { server, port, events } = await startServer(agentPub);
    const io = makeIo();

    await connectOnce(port, io);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(events.some((e) => e.method === 'publickey' && e.accepted)).toBe(true);
    expect(events.some((e) => e.method === 'password')).toBe(false);
    expect(io.passwordPrompts).toBe(0);
    expect(io.passphrasePrompts).toBe(0);
  }, 15_000);

  it('falls back to the next method when the agent socket is unreachable', async () => {
    process.env.SSH_AUTH_SOCK = path.join(tmp, 'no-such-agent.sock');
    try {
      const { server, port, events } = await startServer(agentPub);
      const io = makeIo();

      await connectOnce(port, io);
      await new Promise<void>((resolve) => server.close(() => resolve()));

      expect(io.statuses.some((s) => s.includes('ssh-agent unavailable'))).toBe(true);
      expect(events.some((e) => e.method === 'password' && e.accepted)).toBe(true);
      expect(io.passwordPrompts).toBe(1);
    } finally {
      process.env.SSH_AUTH_SOCK = agentSock;
    }
  }, 15_000);

  it('prompts for the passphrase of a default key the agent does not hold', async () => {
    const sshDir = path.join(tmp, '.ssh');
    mkdirSync(sshDir, { recursive: true });
    try {
      const diskKey = path.join(sshDir, 'id_ed25519');
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', KEY_PASSPHRASE, '-f', diskKey], {
        stdio: 'ignore',
      });
      const diskPub = utils.parseKey(readFileSync(`${diskKey}.pub`));
      if (diskPub instanceof Error) throw diskPub;

      const { server, port, events } = await startServer(diskPub);
      const io = makeIo();

      await connectOnce(port, io);
      await new Promise<void>((resolve) => server.close(() => resolve()));

      expect(io.passphrasePrompts).toBe(1);
      expect(events.some((e) => e.method === 'publickey' && e.accepted)).toBe(true);
      expect(io.passwordPrompts).toBe(0);
    } finally {
      rmSync(sshDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('never asks for the passphrase of a default key the agent already holds', async () => {
    const sshDir = path.join(tmp, '.ssh');
    mkdirSync(sshDir, { recursive: true });
    try {
      // The agent key, re-encrypted on disk — the agent attempt covers it.
      const diskKey = path.join(sshDir, 'id_ed25519');
      copyFileSync(path.join(tmp, 'agent-key'), diskKey);
      copyFileSync(path.join(tmp, 'agent-key.pub'), `${diskKey}.pub`);
      execFileSync('ssh-keygen', ['-p', '-P', '', '-N', KEY_PASSPHRASE, '-f', diskKey], {
        stdio: 'ignore',
      });

      // The server rejects every public key, so the ladder walks past both
      // the agent and the identity files before landing on the password.
      const { server, port, events } = await startServer(null);
      const io = makeIo();

      await connectOnce(port, io);
      await new Promise<void>((resolve) => server.close(() => resolve()));

      expect(io.passphrasePrompts).toBe(0);
      expect(events.some((e) => e.method === 'password' && e.accepted)).toBe(true);
      expect(io.passwordPrompts).toBe(1);
    } finally {
      rmSync(sshDir, { recursive: true, force: true });
    }
  }, 15_000);
});
