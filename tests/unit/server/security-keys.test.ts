import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2, { Server, type ParsedKey } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { listSshKeys, probeAgentKeys } from '../../../server/src/ssh/key-scan.js';
import { ResponsiveAgent } from '../../../server/src/ssh/responsive-agent.js';
import { agentFailureReason, SecurityKeyFileAgent } from '../../../server/src/ssh/security-key-agent.js';
import {
  classifyAskpassPrompt,
  describeSecurityKeyError,
  readOpenSshKeyFile,
  SecurityKeyError,
  securityKeyFile,
  securityKeyLabel,
  securityKeyProvider,
} from '../../../server/src/ssh/security-keys.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const { utils } = ssh2;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-sk-test-'));
const PASSWORD = 'fallback-password';
const ED25519_SK = 'sk-ssh-ed25519@openssh.com';
const ECDSA_SK = 'sk-ecdsa-sha2-nistp256@openssh.com';
const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function mpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  return sshString(trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function readField(data: Buffer, offset: number): { value: Buffer; next: number } {
  const end = offset + 4 + data.readUInt32BE(offset);
  return { value: data.subarray(offset + 4, end), next: end };
}

/** A FIDO key the way an authenticator holds it: an Ed25519/P-256 key bound to an application. */
interface SoftKey {
  type: string;
  application: string;
  blob: Buffer;
  privateKey: KeyObject;
  line: string;
}

function ed25519SkKey(comment = 'test-ed25519-sk', application = 'ssh:'): SoftKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pk = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const blob = Buffer.concat([sshString(ED25519_SK), sshString(pk), sshString(application)]);
  return { type: ED25519_SK, application, blob, privateKey, line: `${ED25519_SK} ${blob.toString('base64')} ${comment}` };
}

function ecdsaSkKey(comment = 'test-ecdsa-sk', application = 'ssh:'): SoftKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const q = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const blob = Buffer.concat([sshString(ECDSA_SK), sshString('nistp256'), sshString(q), sshString(application)]);
  return { type: ECDSA_SK, application, blob, privateKey, line: `${ECDSA_SK} ${blob.toString('base64')} ${comment}` };
}

/** A user certificate for a security key; only its layout matters to the client. */
function certificateFor(key: SoftKey): Buffer {
  const certType = key.type.replace('@openssh.com', '-cert-v01@openssh.com');
  const keyFields = key.blob.subarray(readField(key.blob, 0).next);
  return Buffer.concat([
    sshString(certType),
    sshString(Buffer.alloc(32, 7)),
    keyFields,
    Buffer.alloc(8),
    uint32(1),
    sshString('cert-id'),
    sshString(sshString('tester')),
    Buffer.alloc(8),
    Buffer.alloc(8, 0xff),
    sshString(''),
    sshString(''),
    sshString(''),
    sshString(sshString('ssh-ed25519')),
    sshString(Buffer.alloc(64)),
  ]);
}

/** The message a FIDO authenticator signs for OpenSSH (PROTOCOL.u2f). */
function skMessage(application: string, flags: number, counter: number, data: Buffer): Buffer {
  return Buffer.concat([
    createHash('sha256').update(application).digest(),
    Buffer.from([flags]),
    uint32(counter),
    createHash('sha256').update(data).digest(),
  ]);
}

/** What an agent returns for a security key: the full blob, flags and counter included. */
function skSignature(key: SoftKey, data: Buffer, flags: number, counter: number): Buffer {
  const message = skMessage(key.application, flags, counter, data);
  let signature: Buffer;
  if (key.type === ED25519_SK) {
    signature = cryptoSign(null, message, key.privateKey);
  } else {
    const raw = cryptoSign('sha256', message, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    signature = Buffer.concat([mpint(raw.subarray(0, 32)), mpint(raw.subarray(32))]);
  }
  return Buffer.concat([sshString(key.type), sshString(signature), Buffer.from([flags]), uint32(counter)]);
}

/**
 * Check a security key signature the way sshd does, from what ssh2's server
 * hands over (the signature after its algorithm and length prefix).
 */
function verifySkSignature(
  key: SoftKey,
  signedData: Buffer,
  serverSignature: Buffer,
): { valid: boolean; flags: number; counter: number } {
  // ssh2's server only strips the signature's own algorithm and length when
  // that algorithm equals the key's, which it does not for a certificate.
  const prefix = sshString(key.type);
  const signature = serverSignature.subarray(0, prefix.length).equals(prefix)
    ? serverSignature.subarray(prefix.length + 4)
    : serverSignature;
  let raw: Buffer;
  let rest: Buffer;
  if (key.type === ED25519_SK) {
    raw = signature.subarray(0, 64);
    rest = signature.subarray(64);
  } else {
    const r = readField(signature, 0);
    const s = readField(signature, r.next);
    const pad = (value: Buffer) => Buffer.concat([Buffer.alloc(32), value]).subarray(-32);
    raw = Buffer.concat([pad(r.value), pad(s.value)]);
    rest = signature.subarray(s.next);
  }
  const flags = rest[0] ?? -1;
  const counter = rest.length === 5 ? rest.readUInt32BE(1) : -1;
  const message = skMessage(key.application, flags, counter, signedData);
  const publicKey = createPublicKey(key.privateKey);
  const valid =
    rest.length === 5 &&
    (key.type === ED25519_SK
      ? cryptoVerify(null, message, publicKey, raw)
      : cryptoVerify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
  return { valid, flags, counter };
}

interface AgentIdentity {
  blob: Buffer;
  comment: string;
  key?: SoftKey;
}

/** A minimal ssh-agent holding security keys, signing like a touched authenticator. */
async function startSkAgent(
  identities: AgentIdentity[],
  behaviour: { refuse?: boolean; delayMs?: number; flags?: number; counter?: number } = {},
): Promise<{ socketPath: string; signRequests: () => number; close: () => Promise<void> }> {
  const socketPath = path.join(mkdtempSync(path.join(tmp, 'agent-')), 'agent.sock');
  const sockets = new Set<net.Socket>();
  let signs = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const reply = (type: number, body: Buffer = Buffer.alloc(0)) => {
      socket.write(Buffer.concat([uint32(1 + body.length), Buffer.from([type]), body]));
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const message = buffer.subarray(4, 4 + buffer.readUInt32BE(0));
        buffer = buffer.subarray(4 + message.length);
        if (message[0] === 11) {
          reply(
            12,
            Buffer.concat([
              uint32(identities.length),
              ...identities.flatMap((identity) => [sshString(identity.blob), sshString(identity.comment)]),
            ]),
          );
        } else if (message[0] === 13) {
          signs += 1;
          const keyBlob = readField(message, 1);
          const data = readField(message, keyBlob.next).value;
          const identity = identities.find((entry) => entry.blob.equals(keyBlob.value));
          const answer = () => {
            if (behaviour.refuse || !identity?.key) reply(5);
            else {
              reply(
                14,
                sshString(skSignature(identity.key, data, behaviour.flags ?? 0x01, behaviour.counter ?? 0x01020304)),
              );
            }
          };
          if (behaviour.delayMs) setTimeout(answer, behaviour.delayMs);
          else answer();
        } else {
          reply(5);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    signRequests: () => signs,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

interface LoginEvent {
  algo: string;
  flags?: number;
  counter?: number;
  accepted: boolean;
}

/** sshd stand-in accepting one security key (checked the way sshd does) or the password. */
function startServer(
  allowed: { key: SoftKey; blob?: Buffer },
  { password = true }: { password?: boolean } = {},
): Promise<{ server: Server; port: number; logins: LoginEvent[] }> {
  const logins: LoginEvent[] = [];
  const methods: Array<'publickey' | 'password'> = password ? ['publickey', 'password'] : ['publickey'];
  const allowedBlob = allowed.blob ?? allowed.key.blob;
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && ctx.key.data.equals(allowedBlob)) {
        if (!ctx.signature || !ctx.blob) return ctx.accept();
        const result = verifySkSignature(allowed.key, ctx.blob, ctx.signature);
        logins.push({ algo: ctx.key.algo, flags: result.flags, counter: result.counter, accepted: result.valid });
        return result.valid ? ctx.accept() : ctx.reject(methods);
      }
      if (ctx.method === 'password' && password) {
        logins.push({ algo: 'password', accepted: ctx.password === PASSWORD });
        if (ctx.password === PASSWORD) return ctx.accept();
      }
      ctx.reject(methods);
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
      resolve({ server, port: (server.address() as net.AddressInfo).port, logins });
    });
  });
}

let counter = 0;
function makeManager(port: number, configLines: string[] = []): SshConnectionManager {
  const configFile = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    configFile,
    [
      'Host lab',
      '  HostName 127.0.0.1',
      '  User tester',
      `  Port ${port}`,
      '  StrictHostKeyChecking no',
      ...configLines.map((line) => `  ${line}`),
      '',
    ].join('\n'),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(path.join(tmp, `known_hosts-${counter++}`), path.join(tmp, 'no-global')),
    loadConfig: () => loadConfigDocument(configFile),
    agentOperationTimeoutMs: 100,
    agentWaitStatusMs: 10,
  });
}

function makeIo(): ConnectIo & { statuses: string[]; prompts: string[] } {
  const io = {
    statuses: [] as string[],
    prompts: [] as string[],
    status: (message: string) => {
      io.statuses.push(message);
    },
    prompt: (info: { prompts: Array<{ prompt: string }> }) => {
      io.prompts.push(...info.prompts.map((p) => p.prompt));
      return Promise.resolve({ answers: info.prompts.map(() => PASSWORD) });
    },
    hostKey: () => Promise.resolve(true),
  };
  return io as unknown as ConnectIo & { statuses: string[]; prompts: string[] };
}

const profile: SshProfile = { kind: 'ssh', target: 'lab' };

/** An unencrypted OpenSSH private key file for a security key, as ssh-keygen writes it. */
function skKeyFile(key: SoftKey, cipher = 'none'): string {
  const keyFields = key.blob.subarray(readField(key.blob, 0).next);
  const check = uint32(0x12345678);
  let privateSection = Buffer.concat([
    check,
    check,
    sshString(key.type),
    keyFields,
    Buffer.from([0x01]),
    sshString(Buffer.alloc(64, 9)),
    sshString(''),
    sshString('test-key'),
  ]);
  const padding: number[] = [];
  for (let i = 1; (privateSection.length + padding.length) % 8 !== 0; i++) padding.push(i);
  privateSection = Buffer.concat([privateSection, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString(cipher),
    sshString(cipher === 'none' ? 'none' : 'bcrypt'),
    sshString(cipher === 'none' ? '' : Buffer.concat([sshString(Buffer.alloc(16)), uint32(16)])),
    uint32(1),
    sshString(key.blob),
    sshString(privateSection),
  ]);
  const base64 = body.toString('base64').replace(/.{70}/g, '$&\n');
  const label = 'OPENSSH PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

const savedEnv = {
  HOME: process.env.HOME,
  SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
  PATH: process.env.PATH,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
};

beforeAll(() => {
  // No default identity files from the developer's ~/.ssh.
  process.env.HOME = tmp;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('security key public keys', () => {
  it('parses ed25519-sk and ecdsa-sk keys from text and agent blobs, keeping the application', () => {
    for (const key of [ed25519SkKey(), ecdsaSkKey()]) {
      const text = utils.parseKey(key.line);
      const binary = utils.parseKey(key.blob);
      if (text instanceof Error) throw text;
      if (binary instanceof Error) throw binary;
      expect(String(text.type)).toBe(key.type);
      expect(text.comment).toBe(key.type === ED25519_SK ? 'test-ed25519-sk' : 'test-ecdsa-sk');
      expect(text.getPublicSSH().equals(key.blob)).toBe(true);
      expect(String(binary.type)).toBe(key.type);
      expect(binary.getPublicSSH().equals(key.blob)).toBe(true);
      expect(text.isPrivateKey()).toBe(false);
      expect(createPublicKey(text.getPublicPEM()).asymmetricKeyType).toBe(
        key.type === ED25519_SK ? 'ed25519' : 'ec',
      );
    }
  });

  it('keeps a security key certificate whole', () => {
    for (const key of [ed25519SkKey(), ecdsaSkKey()]) {
      const certificate = certificateFor(key);
      const certType = key.type.replace('@openssh.com', '-cert-v01@openssh.com');
      const parsed = utils.parseKey(`${certType} ${certificate.toString('base64')} cert`);
      const binary = utils.parseKey(certificate);
      if (parsed instanceof Error) throw parsed;
      if (binary instanceof Error) throw binary;
      expect(String(parsed.type)).toBe(certType);
      expect(parsed.getPublicSSH().equals(certificate)).toBe(true);
      expect(binary.getPublicSSH().equals(certificate)).toBe(true);
    }
  });

  it('rejects malformed security keys', () => {
    const shortKey = Buffer.concat([sshString(ED25519_SK), sshString(Buffer.alloc(31)), sshString('ssh:')]);
    const noApplication = Buffer.concat([sshString(ED25519_SK), sshString(Buffer.alloc(32))]);
    const wrongCurve = Buffer.concat([sshString(ECDSA_SK), sshString('nistp384'), sshString(Buffer.alloc(65, 4)), sshString('ssh:')]);
    for (const blob of [shortKey, noApplication, wrongCurve]) {
      expect(utils.parseKey(blob)).toBeInstanceOf(Error);
      expect(utils.parseKey(`${readField(blob, 0).value.toString()} ${blob.toString('base64')}`)).toBeInstanceOf(Error);
    }
  });

  it('names a key the way OpenSSH asks for a touch', () => {
    const key = ed25519SkKey();
    const parsed = utils.parseKey(key.line) as ParsedKey;
    const certificate = utils.parseKey(certificateFor(key)) as ParsedKey;
    const fingerprint = `SHA256:${createHash('sha256').update(key.blob).digest('base64').replace(/=+$/, '')}`;
    expect(securityKeyLabel(parsed)).toBe(`ED25519-SK ${fingerprint}`);
    // Like ssh-add -l, a certificate shows the fingerprint of its key.
    expect(securityKeyLabel(certificate)).toBe(`ED25519-SK-CERT ${fingerprint}`);
    expect(securityKeyLabel(utils.parseKey(ecdsaSkKey().line) as ParsedKey)).toMatch(/^ECDSA-SK SHA256:/);
  });
});

describe('security keys in the ssh-agent', () => {
  it('lists security key identities, certificates included', async () => {
    const ed = ed25519SkKey();
    const ecdsa = ecdsaSkKey();
    const agent = await startSkAgent([
      { blob: ed.blob, comment: 'ed' },
      { blob: certificateFor(ed), comment: 'ed-cert' },
      { blob: ecdsa.blob, comment: 'ecdsa' },
      { blob: Buffer.concat([sshString('unknown-type@example.com'), sshString('x')]), comment: 'unknown' },
    ]);
    try {
      const responsive = new ResponsiveAgent(ssh2.createAgent(agent.socketPath) as never, { waitStatusMs: -1 });
      const keys = await new Promise<ParsedKey[]>((resolve, reject) =>
        responsive.getIdentities((err, list) => (err ? reject(err) : resolve(list ?? []))),
      );
      expect(keys.map((key) => [String(key.type), key.comment])).toEqual([
        [ED25519_SK, 'ed'],
        ['sk-ssh-ed25519-cert-v01@openssh.com', 'ed-cert'],
        [ECDSA_SK, 'ecdsa'],
      ]);
      const probe = await probeAgentKeys(agent.socketPath);
      expect(probe.keys.map((key) => key.type)).toEqual([
        ED25519_SK,
        'sk-ssh-ed25519-cert-v01@openssh.com',
        ECDSA_SK,
      ]);
    } finally {
      await agent.close();
    }
  });

  it.each([
    ['ed25519-sk', ed25519SkKey],
    ['ecdsa-sk', ecdsaSkKey],
  ])('logs in with an agent-held %s key, passing flags and counter through', async (_name, makeKey) => {
    const key = makeKey();
    const agent = await startSkAgent([{ blob: key.blob, comment: 'sk', key }], { flags: 0x05, counter: 4242 });
    const { server, port, logins } = await startServer({ key });
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    const io = makeIo();
    const manager = makeManager(port);
    try {
      const shell = await manager.connectShell(profile, io, 80, 24, 'xterm');
      expect(shell.summary.authMethods).toEqual(['agent']);
      expect(shell.summary.authKeyAlgorithm).toBe(key.type);
      shell.lease.release();
    } finally {
      manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.close();
    }
    expect(logins).toEqual([{ algo: key.type, flags: 0x05, counter: 4242, accepted: true }]);
    expect(io.statuses.some((s) => /^Touch your security key to log in to lab \((ED25519|ECDSA)-SK SHA256:/.test(s))).toBe(
      true,
    );
    expect(io.prompts).toEqual([]);
  }, 15_000);

  it('logs in with a security key certificate from the agent', async () => {
    const key = ed25519SkKey();
    const certificate = certificateFor(key);
    const agent = await startSkAgent([{ blob: certificate, comment: 'cert', key }]);
    const { server, port, logins } = await startServer({ key, blob: certificate });
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    const manager = makeManager(port);
    try {
      const shell = await manager.connectShell(profile, makeIo(), 80, 24, 'xterm');
      expect(shell.summary.authKeyAlgorithm).toBe('sk-ssh-ed25519-cert-v01@openssh.com');
      shell.lease.release();
    } finally {
      manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.close();
    }
    expect(logins).toEqual([
      { algo: 'sk-ssh-ed25519-cert-v01@openssh.com', flags: 0x01, counter: 0x01020304, accepted: true },
    ]);
  }, 15_000);

  it('waits for the touch beyond ConnectTimeout and the agent response bound', async () => {
    const key = ed25519SkKey();
    // Longer than both ConnectTimeout (1 s) and the agent bound (100 ms).
    const agent = await startSkAgent([{ blob: key.blob, comment: 'sk', key }], { delayMs: 1_300 });
    const { server, port, logins } = await startServer({ key });
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    const io = makeIo();
    const manager = makeManager(port, ['ConnectTimeout 1']);
    try {
      const lease = await manager.connect(profile, io);
      lease.release();
    } finally {
      manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.close();
    }
    expect(logins.some((login) => login.accepted)).toBe(true);
    // The touch prompt replaces the generic agent wait notice.
    expect(io.statuses.some((s) => s.includes('Waiting for the SSH agent'))).toBe(false);
  }, 15_000);

  it('says why the security key did not sign, instead of a bare authentication failure', async () => {
    const key = ecdsaSkKey();
    const agent = await startSkAgent([{ blob: key.blob, comment: 'sk', key }], { refuse: true });
    const { server, port } = await startServer({ key }, { password: false });
    process.env.SSH_AUTH_SOCK = agent.socketPath;
    const io = makeIo();
    const manager = makeManager(port);
    try {
      await expect(manager.connect(profile, io)).rejects.toThrow(
        /^authentication to 127\.0\.0\.1:\d+ failed: the security key ECDSA-SK SHA256:\S+ did not sign the login to lab: it was not touched in time/,
      );
    } finally {
      manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.close();
    }
    expect(agent.signRequests()).toBe(1);
    expect(io.statuses.some((s) => /did not sign the login to lab.* — trying other authentication methods$/.test(s))).toBe(true);
    expect(io.statuses.some((s) => s.includes('ssh-agent unavailable'))).toBe(false);
  }, 15_000);
});

describe('security key IdentityFile', () => {
  it('reads the public key from a key file header without its passphrase', () => {
    const key = ed25519SkKey();
    const plain = readOpenSshKeyFile(skKeyFile(key));
    expect(plain).toMatchObject({ type: ED25519_SK, encrypted: false });
    expect(plain?.publicBlob.equals(key.blob)).toBe(true);
    expect(readOpenSshKeyFile(skKeyFile(key, 'aes256-ctr'))).toMatchObject({ type: ED25519_SK, encrypted: true });
    expect(String(securityKeyFile(skKeyFile(key))?.type)).toBe(ED25519_SK);
    expect(securityKeyFile('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n')).toBeUndefined();
    if (commandExists('ssh-keygen')) {
      const file = path.join(tmp, 'plain-ed25519');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
      expect(readOpenSshKeyFile(readFileSync(file))?.type).toBe('ssh-ed25519');
      expect(securityKeyFile(readFileSync(file))).toBeUndefined();
    }
  });

  it('lists security key files in the key picker', async () => {
    const dir = path.join(tmp, 'picker');
    mkdirSync(dir, { recursive: true });
    const key = ecdsaSkKey('picker-key');
    writeFileSync(path.join(dir, 'id_ecdsa_sk'), skKeyFile(key), { mode: 0o600 });
    writeFileSync(path.join(dir, 'id_ecdsa_sk.pub'), `${key.line}\n`);
    const { keys } = await listSshKeys({ dir, identityAgent: 'none' });
    expect(keys).toEqual([
      expect.objectContaining({ name: 'id_ecdsa_sk', type: ECDSA_SK, comment: 'picker-key', encrypted: false }),
    ]);
  });

  it('explains what to do when OpenSSH cannot be found, then falls back', async () => {
    const key = ed25519SkKey();
    const file = path.join(tmp, 'id_ed25519_sk');
    writeFileSync(file, skKeyFile(key), { mode: 0o600 });
    const { server, port, logins } = await startServer({ key });
    delete process.env.SSH_AUTH_SOCK;
    process.env.PATH = path.join(tmp, 'empty-path');
    const io = makeIo();
    const manager = makeManager(port, [`IdentityFile ${file}`, 'IdentitiesOnly yes']);
    try {
      const lease = await manager.connect(profile, io);
      lease.release();
    } finally {
      process.env.PATH = savedEnv.PATH;
      manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const notice = io.statuses.find((s) => s.includes('is a security key'));
    if (process.platform === 'win32') {
      expect(notice).toContain(`To use it, load it into your SSH agent with "ssh-add ${file}"`);
    } else {
      expect(notice).toBe(
        `id_ed25519_sk is a security key (ED25519-SK). Muxus signs with it through OpenSSH's ssh-agent, which was not found: install the OpenSSH client, or load it into your SSH agent with "ssh-add ${file}" — trying other authentication methods`,
      );
    }
    // No passphrase prompt for the key handle file; the password still works.
    expect(io.prompts).toEqual(["tester@lab's password"]);
    expect(logins.at(-1)).toEqual({ algo: 'password', accepted: true });
  }, 15_000);

  it('pairs a security key CertificateFile with its key file', async () => {
    const key = ecdsaSkKey();
    const certificate = certificateFor(key);
    const certType = 'sk-ecdsa-sha2-nistp256-cert-v01@openssh.com';
    const keyFile = path.join(tmp, 'id_cert_ecdsa_sk');
    const certFile = `${keyFile}-cert.pub`;
    const strayCert = path.join(tmp, 'stray-cert.pub');
    writeFileSync(keyFile, skKeyFile(key), { mode: 0o600 });
    writeFileSync(certFile, `${certType} ${certificate.toString('base64')} cert\n`);
    writeFileSync(strayCert, `${certType} ${certificateFor(ecdsaSkKey()).toString('base64')} other\n`);
    // The server accepts only the certificate; no OpenSSH tools to sign with.
    const { server, port, logins } = await startServer({ key, blob: certificate });
    delete process.env.SSH_AUTH_SOCK;
    process.env.PATH = path.join(tmp, 'empty-path');
    const io = makeIo();
    const manager = makeManager(port, [
      `IdentityFile ${keyFile}`,
      `CertificateFile ${strayCert}`,
      `CertificateFile ${certFile}`,
      'IdentitiesOnly yes',
    ]);
    try {
      const lease = await manager.connect(profile, io);
      lease.release();
    } finally {
      process.env.PATH = savedEnv.PATH;
      manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(io.statuses).toContain(`certificate ${strayCert} has no matching identity file — skipping`);
    // The certificate reached the signing step with its own key file.
    expect(io.statuses.some((s) => s.startsWith('id_cert_ecdsa_sk is a security key (ECDSA-SK).'))).toBe(true);
    expect(io.statuses.some((s) => s.includes('unsupported certificate type'))).toBe(false);
    expect(logins.at(-1)).toEqual({ algo: 'password', accepted: true });
  }, 15_000);

  it.skipIf(process.platform === 'win32' || !hasOpenSshAgent())(
    'loads the key into a private ssh-agent, relaying the passphrase prompt, and cleans up',
    async () => {
      const key = ed25519SkKey();
      const file = path.join(tmp, 'id_encrypted_sk');
      writeFileSync(file, skKeyFile(key), { mode: 0o600 });
      execFileSync('ssh-keygen', ['-q', '-p', '-P', '', '-N', 'k3y-pass', '-f', file], { stdio: 'ignore' });
      const questions: string[] = [];
      const runtime = mkdtempSync(path.join(tmp, 'run-'));
      process.env.XDG_RUNTIME_DIR = runtime;
      let privateDirs: string[] = [];
      const agent = new SecurityKeyFileAgent({
        file,
        publicKey: utils.parseKey(key.blob) as ParsedKey,
        ask: (question) => {
          questions.push(`${question.kind}:${question.retry}`);
          privateDirs = readdirSync(runtime);
          return Promise.resolve(questions.length === 1 ? 'wrong' : 'k3y-pass');
        },
      });
      try {
        const error = await new Promise<Error | null | undefined>((resolve) =>
          agent.sign(utils.parseKey(key.blob) as ParsedKey, Buffer.from('data'), {}, (err) => resolve(err)),
        );
        // There is no authenticator here, so signing fails, but only after
        // ssh-add accepted the second passphrase and loaded the key.
        expect(questions, error?.message).toEqual(['passphrase:false', 'passphrase:true']);
        expect(error).toBeInstanceOf(SecurityKeyError);
        expect((error as SecurityKeyError).key, error?.message).toBeDefined();
      } finally {
        agent.dispose();
        if (savedEnv.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = savedEnv.XDG_RUNTIME_DIR;
      }
      // The private agent lived in the user's runtime directory, and is gone.
      expect(privateDirs).toEqual([expect.stringMatching(/^muxus-sk-/)]);
      expect(readdirSync(runtime)).toEqual([]);
    },
    20_000,
  );
});

describe('security key helpers', () => {
  it('classifies OpenSSH askpass prompts', () => {
    expect(classifyAskpassPrompt('Enter passphrase for /home/u/.ssh/id_ed25519_sk: ')).toEqual({
      kind: 'passphrase',
      retry: false,
      presence: false,
      text: 'Enter passphrase for /home/u/.ssh/id_ed25519_sk',
    });
    expect(classifyAskpassPrompt('Bad passphrase, try again for /k: ')).toMatchObject({ kind: 'passphrase', retry: true });
    expect(classifyAskpassPrompt('Enter PIN for ED25519-SK key SHA256:abc: ')).toMatchObject({
      kind: 'pin',
      presence: false,
    });
    expect(
      classifyAskpassPrompt('Enter PIN and confirm user presence for ED25519-SK key SHA256:abc: '),
    ).toMatchObject({ kind: 'pin', presence: true });
    expect(classifyAskpassPrompt('Something else?')).toMatchObject({ kind: 'other', text: 'Something else?' });
  });

  it('reads why the private agent could not sign from its log', () => {
    expect(agentFailureReason('process_sign_request2: sshkey_sign: device not found\n')).toBe(
      'no security key is plugged in',
    );
    expect(
      agentFailureReason('process_sign_request2: sshkey_sign: incorrect passphrase supplied to decrypt private key'),
    ).toBe('the PIN was not accepted');
    expect(agentFailureReason('error: internal security key support not enabled')).toMatch(
      /^this OpenSSH has no built-in security key support: set SecurityKeyProvider/,
    );
    expect(agentFailureReason('process_sign_request2: sshkey_sign: invalid format')).toBeUndefined();
  });

  it('resolves SecurityKeyProvider like ssh', () => {
    expect(securityKeyProvider(undefined, {})).toBeUndefined();
    expect(securityKeyProvider(undefined, { SSH_SK_PROVIDER: '/lib/sk.so' })).toBe('/lib/sk.so');
    expect(securityKeyProvider('/opt/sk.so', { SSH_SK_PROVIDER: '/lib/sk.so' })).toBe('/opt/sk.so');
    expect(securityKeyProvider('$MY_SK', { MY_SK: '/my/sk.so' })).toBe('/my/sk.so');
    expect(securityKeyProvider('internal', { SSH_SK_PROVIDER: '/lib/sk.so' })).toBeUndefined();
    expect(securityKeyProvider('~/sk.so', {})).toBe(path.join(os.homedir(), 'sk.so'));
  });

  it('describes signing failures in terms of the key and the hop', () => {
    const key = utils.parseKey(ed25519SkKey().line) as ParsedKey;
    expect(describeSecurityKeyError(new SecurityKeyError('Agent responded with failure', key), 'bastion')).toMatch(
      /^the security key ED25519-SK SHA256:\S+ did not sign the login to bastion: it was not touched in time, its PIN was not accepted, or it is not plugged in$/,
    );
    expect(describeSecurityKeyError(new SecurityKeyError('the PIN was wrong, or it was not touched in time', key), 'web')).toMatch(
      /did not sign the login to web: the PIN was wrong, or it was not touched in time$/,
    );
    expect(describeSecurityKeyError(new SecurityKeyError('could not load the security key x: y'), 'web')).toBe(
      'could not load the security key x: y',
    );
  });
});

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ['-?'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function hasOpenSshAgent(): boolean {
  return ['ssh-agent', 'ssh-add', 'ssh-keygen'].every(commandExists);
}
