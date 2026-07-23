import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import type { SshProfile } from '@muxus/shared';
import { KnownHostsStore } from './known-hosts.js';
import { parseSshConfigHosts } from './ssh-config.js';

export interface HostKeyChallenge {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  state: 'new' | 'mismatch';
  previous?: string;
}

/** Interactive hooks a connection attempt needs from the UI. */
export interface ConnectIo {
  status(message: string): void;
  /** Ask the user to answer auth prompts (password, 2FA, key passphrase). */
  prompt(info: { name?: string; instructions?: string; prompts: Array<{ prompt: string; echo: boolean }> }): Promise<string[]>;
  /** Ask the user to accept a new or changed host key. */
  hostKey(challenge: HostKeyChallenge): Promise<boolean>;
}

export interface ManagedConnection {
  id: string;
  client: Client;
  profile: SshProfile;
  host: string;
  port: number;
  user: string;
  shell(cols: number, rows: number, term: string): Promise<ClientChannel>;
  sftp(): Promise<SFTPWrapper>;
  onClose(listener: () => void): void;
  close(): void;
}

const MAX_AUTH_ATTEMPTS = 3;

export class SshConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>();
  readonly knownHosts = new KnownHostsStore();

  constructor(private readonly log: FastifyBaseLogger) {}

  get(id: string): ManagedConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * Dial an SSH host and register the live connection under a fresh id.
   * Host aliases from ~/.ssh/config resolve to their HostName/User/Port
   * hints, so the sidebar's config entries connect like `ssh <alias>` would
   * (minus ProxyJump and per-host identities, which need the real ssh).
   */
  async connect(profile: SshProfile, io: ConnectIo): Promise<ManagedConnection> {
    const alias = parseSshConfigHosts().hosts.find((h) => h.alias === profile.host);
    const host = alias?.hostname ?? profile.host;
    const port = profile.port ?? alias?.port ?? 22;
    const user = profile.user ?? alias?.user ?? os.userInfo().username;

    const base: ConnectConfig = {
      host,
      port,
      username: user,
      tryKeyboard: true,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        void this.verifyHostKey(host, port, key, io).then(verify);
      },
    };

    io.status(`Connecting to ${user}@${host}:${port} …`);
    const client = await this.authenticate(profile, base, io);
    const id = nanoid(10);
    const closeListeners = new Set<() => void>();
    let sftpPromise: Promise<SFTPWrapper> | undefined;

    const managed: ManagedConnection = {
      id,
      client,
      profile,
      host,
      port,
      user,
      shell: (cols, rows, term) =>
        new Promise((resolve, reject) => {
          client.shell({ term, cols, rows }, (err, stream) => (err ? reject(err) : resolve(stream)));
        }),
      sftp: () => {
        // One SFTP channel per connection, shared by every file operation.
        sftpPromise ??= new Promise((resolve, reject) => {
          client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
        });
        return sftpPromise;
      },
      onClose: (listener) => closeListeners.add(listener),
      close: () => client.end(),
    };

    client.on('close', () => {
      this.connections.delete(id);
      for (const listener of closeListeners) listener();
    });
    this.connections.set(id, managed);
    return managed;
  }

  closeAll(): void {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
  }

  private async verifyHostKey(host: string, port: number, key: Buffer, io: ConnectIo): Promise<boolean> {
    const keyType = hostKeyType(key);
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    const known = this.knownHosts.lookup(host, port);
    if (known?.fingerprint === fingerprint) return true;
    const accepted = await io
      .hostKey({ host, port, keyType, fingerprint, state: known ? 'mismatch' : 'new', previous: known?.fingerprint })
      .catch(() => false);
    if (accepted) this.knownHosts.record(host, port, keyType, fingerprint);
    return accepted;
  }

  /**
   * Run the auth flow for the profile's method, looping on interactive
   * failures (wrong password, wrong passphrase) up to MAX_AUTH_ATTEMPTS.
   * keyboard-interactive is always answered via the prompt hook, so 2FA and
   * PAM conversations work regardless of the chosen method.
   */
  private async authenticate(profile: SshProfile, base: ConnectConfig, io: ConnectIo): Promise<Client> {
    const method = profile.auth ?? 'agent';
    let passphrase: string | undefined;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
      const config: ConnectConfig = { ...base };
      if (method === 'agent') {
        config.agent = process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
        if (!config.agent) throw new Error('no SSH agent found — set SSH_AUTH_SOCK or use key/password auth');
      } else if (method === 'key') {
        const keyPath = expandHome(profile.keyPath ?? '');
        if (!keyPath) throw new Error('key auth selected but no key file configured');
        config.privateKey = readFileSync(keyPath);
        config.passphrase = passphrase;
      } else {
        const [password] = await io.prompt({
          prompts: [{ prompt: attempt === 1 ? `Password for ${config.username}@${config.host}` : 'Permission denied, try again. Password', echo: false }],
        });
        config.password = password ?? '';
      }

      try {
        return await this.dial(config, io);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (method === 'key' && /passphrase|encrypted|cannot parse/i.test(lastError.message) && attempt < MAX_AUTH_ATTEMPTS) {
          const [answer] = await io.prompt({
            prompts: [{ prompt: `Passphrase for ${path.basename(expandHome(profile.keyPath ?? ''))}`, echo: false }],
          });
          passphrase = answer ?? '';
          continue;
        }
        if (method === 'password' && /authentication/i.test(lastError.message) && attempt < MAX_AUTH_ATTEMPTS) continue;
        throw lastError;
      }
    }
    throw lastError ?? new Error('authentication failed');
  }

  private dial(config: ConnectConfig, io: ConnectIo): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
        io.prompt({ name: name || undefined, instructions: instructions || undefined, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo !== false })) })
          .then(finish)
          .catch(() => finish(prompts.map(() => '')));
      });
      client.on('banner', (message) => io.status(message.trimEnd()));
      client.on('ready', () => {
        settled = true;
        resolve(client);
      });
      client.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(friendlyConnectError(err, config));
        } else {
          this.log.warn({ err }, 'ssh connection error');
        }
      });
      client.connect(config);
    });
  }
}

/** "ssh-ed25519", "ecdsa-sha2-nistp256", … — the leading string of the key blob. */
function hostKeyType(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('latin1');
  } catch {
    return 'unknown';
  }
}

function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Translate the common ssh2 failure modes into user-actionable messages. */
function friendlyConnectError(err: Error, config: ConnectConfig): Error {
  const msg = err.message;
  if (/ECONNREFUSED/.test(msg)) return new Error(`connection refused by ${config.host}:${config.port} — is sshd running?`);
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return new Error(`could not resolve host ${config.host}`);
  if (/ETIMEDOUT|Timed out/i.test(msg)) return new Error(`connection to ${config.host}:${config.port} timed out`);
  if (/All configured authentication methods failed/.test(msg)) return new Error('authentication failed');
  return err;
}
