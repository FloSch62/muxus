import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
// ssh2 is CommonJS; `utils` is attached dynamically and escapes Node's
// named-export detection, so it must come off the default export.
import ssh2, {
  Client,
  type AnyAuthMethod,
  type AuthenticationType,
  type ClientChannel,
  type ConnectConfig,
  type ParsedKey,
  type PseudoTtyOptions,
  type SFTPWrapper,
} from 'ssh2';

const { utils } = ssh2;
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import type { ConfigForward, ConnectionInfo, SshProfile } from '@muxus/shared';
import { KnownHostsStore, fingerprintSha256, hostKeyType } from './known-hosts.js';
import { agentSocket } from './key-scan.js';
import {
  ConnectionLeaseRegistry,
  type ConnectionLeaseOwner,
  type TransportLease,
} from './connection-leases.js';
import {
  listHosts,
  loadConfigDocument,
  parseHostSpec,
  resolveHost,
  type ConfigDocument,
  type ResolvedTarget,
} from './ssh-config.js';

export interface HostKeyChallenge {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  state: 'new' | 'mismatch';
  previous?: string;
  /** Set when verifying an intermediate ProxyJump hop, not the final target. */
  hop?: string;
}

/** Interactive hooks a connection attempt needs from the UI. */
export interface ConnectIo {
  status(message: string): void;
  /** Ask the user to answer auth prompts (password, 2FA, key passphrase). */
  prompt(info: { name?: string; instructions?: string; host?: string; prompts: Array<{ prompt: string; echo: boolean }> }): Promise<string[]>;
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
  /** Concrete OpenSSH alias eligible for Muxus-owned recent/favorite metadata. */
  metadataAlias?: string;
  /** *Forward lines resolved from ssh config — auto-started once the session is up. */
  configForwards: ConfigForward[];
  shell(cols: number, rows: number, term: string): Promise<ClientChannel>;
  sftp(): Promise<SFTPWrapper>;
  /** Subscribe to transport loss; returns an unsubscribe function. */
  onClose(listener: () => void): () => void;
  /** Force-close the transport, regardless of active leases. */
  close(): void;
}

export type ConnectionLease = TransportLease<ManagedConnection>;

const MAX_JUMP_DEPTH = 8;
const MAX_PASSWORD_ATTEMPTS = 3;
const MAX_PASSPHRASE_ATTEMPTS = 3;
const DEFAULT_IDENTITY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_ed25519_sk', 'id_ecdsa_sk'];

/**
 * xterm sends DEL for Backspace. Advertising the same erase character while
 * requesting the remote PTY prevents DEL from being echoed as visible input
 * (and advancing the cursor) on hosts with a different login default.
 */
export function terminalPtyOptions(cols: number, rows: number, term: string): PseudoTtyOptions {
  return { term, cols, rows, modes: { VERASE: 0x7f } };
}

/** One node of the dial plan: the final target or a ProxyJump hop before it. */
export interface ChainHop {
  /** What the user wrote for this node — an alias or [user@]host[:port]. */
  spec: { host: string; user?: string; port?: number };
  resolved: ResolvedTarget;
  user: string;
  port: number;
  /** Display label for prompts when this is an intermediate hop. */
  hopLabel?: string;
}

/**
 * Dials SSH targets exactly the way `ssh <target>` would, using OpenSSH as
 * the source for connection details: alias resolution, ProxyJump chains
 * (each hop resolved, verified and authenticated in its own right), agent +
 * IdentityFile + keyboard-interactive + password auth in OpenSSH order, and
 * host keys checked against the real known_hosts files.
 */
export class SshConnectionManager {
  private readonly connections = new ConnectionLeaseRegistry<ManagedConnection>();
  readonly knownHosts = new KnownHostsStore();

  constructor(private readonly log: FastifyBaseLogger) {}

  /** Acquire an independent consumer lease on an existing SSH transport. */
  acquire(id: string, owner: ConnectionLeaseOwner): ConnectionLease | undefined {
    return this.connections.acquire(id, owner);
  }

  /** Live transports (forwarding panel, connection reuse when starting tunnels). */
  list(): ConnectionInfo[] {
    return this.connections.list().map((conn) => ({
      id: conn.id,
      target: conn.profile.target,
      host: conn.host,
      port: conn.port,
      user: conn.user,
      metadataAlias: conn.metadataAlias,
    }));
  }

  async connect(profile: SshProfile, io: ConnectIo, owner: ConnectionLeaseOwner = 'terminal'): Promise<ConnectionLease> {
    const doc = loadConfigDocument();
    const chain = buildChain(doc, profile);

    const clients: Client[] = [];
    let sock: Duplex | undefined;
    try {
      for (let i = 0; i < chain.length; i++) {
        const hop = chain[i]!;
        const via = i > 0 ? ` via ${chain[i - 1]!.spec.host}` : '';
        io.status(`Connecting to ${hop.user}@${hop.resolved.hostname}:${hop.port}${via} …`);
        const client = await this.dial(hop, sock, io);
        clients.push(client);
        const next = chain[i + 1];
        if (next) sock = await openJumpChannel(client, next.resolved.hostname, next.port);
      }
    } catch (err) {
      for (const c of clients.reverse()) c.end();
      throw err;
    }

    const target = chain[chain.length - 1]!;
    const client = clients[clients.length - 1]!;
    const jumpClients = clients.slice(0, -1);
    const metadataAlias = findMetadataAlias(doc, target.spec.host);
    const id = nanoid(10);
    const closeListeners = new Set<() => void>();
    let sftpPromise: Promise<SFTPWrapper> | undefined;
    let closed = false;
    let ending = false;

    const managed: ManagedConnection = {
      id,
      client,
      profile,
      host: target.resolved.hostname,
      port: target.port,
      user: target.user,
      metadataAlias,
      configForwards: target.resolved.forwards,
      shell: (cols, rows, term) =>
        new Promise((resolve, reject) => {
          client.shell(terminalPtyOptions(cols, rows, term), (err, stream) =>
            err ? reject(err) : resolve(stream),
          );
        }),
      sftp: () => {
        // One SFTP channel per connection, shared by every file operation.
        if (sftpPromise) return sftpPromise;
        const pending = new Promise<SFTPWrapper>((resolve, reject) => {
          client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
        });
        sftpPromise = pending;
        void pending.then(
          (sftp) => {
            sftp.once('close', () => {
              if (sftpPromise === pending) sftpPromise = undefined;
            });
          },
          () => {
            // A transient channel-open failure must not poison every future
            // SFTP operation on an otherwise healthy transport.
            if (sftpPromise === pending) sftpPromise = undefined;
          },
        );
        return pending;
      },
      onClose: (listener) => {
        if (closed) {
          queueMicrotask(listener);
          return () => undefined;
        }
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: () => {
        if (ending) return;
        ending = true;
        client.end();
        for (const jump of [...jumpClients].reverse()) jump.end();
      },
    };

    client.on('close', () => {
      closed = true;
      this.connections.markClosed(managed);
      for (const jump of jumpClients) jump.end();
      for (const listener of closeListeners) listener();
      closeListeners.clear();
    });
    for (const jump of jumpClients) {
      // A dying hop takes the whole chain with it; surface that as a close.
      jump.on('close', () => client.end());
    }
    return this.connections.register(managed, owner);
  }

  closeAll(): void {
    this.connections.closeAll();
  }

  private dial(hop: ChainHop, sock: Duplex | undefined, io: ConnectIo): Promise<Client> {
    const agent = agentSocket();
    const auth = new AuthLadder(hop, io);
    const config: ConnectConfig = {
      username: hop.user,
      readyTimeout: (hop.resolved.connectTimeout ?? 20) * 1000,
      keepaliveInterval: (hop.resolved.serverAliveInterval ?? 15) * 1000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        void this.verifyHostKey(hop, key, io).then(verify);
      },
      authHandler: (authsLeft, _partialSuccess, next) => {
        auth.next(authsLeft, next as (method: AnyAuthMethod | false) => void);
      },
      ...(sock ? { sock } : { host: hop.resolved.hostname, port: hop.port }),
      ...(agent ? { agent, agentForward: hop.resolved.forwardAgent } : {}),
    };

    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      client.on('banner', (message: string) => io.status(message.trimEnd()));
      client.on('ready', () => {
        settled = true;
        resolve(client);
      });
      client.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(friendlyConnectError(auth.cancelled ? new Error('authentication cancelled') : err, hop));
        } else {
          this.log.warn({ err, host: hop.resolved.hostname }, 'ssh connection error');
        }
      });
      client.connect(config);
    });
  }

  private async verifyHostKey(hop: ChainHop, key: Buffer, io: ConnectIo): Promise<boolean> {
    const host = hop.resolved.hostname;
    const port = hop.port;
    const verdict = this.knownHosts.verify(host, port, key);
    if (verdict.state === 'ok') return true;
    if (verdict.state === 'revoked') {
      io.status(`HOST KEY REVOKED for ${host} — remove the @revoked entry from known_hosts if this is intentional.`);
      return false;
    }
    const accepted = await io
      .hostKey({
        host,
        port,
        keyType: hostKeyType(key),
        fingerprint: fingerprintSha256(key),
        state: verdict.state === 'changed' ? 'mismatch' : 'new',
        previous: verdict.state === 'changed' ? verdict.previous : undefined,
        hop: hop.hopLabel,
      })
      .catch(() => false);
    if (accepted) this.knownHosts.record(host, port, key);
    return accepted;
  }
}

// ---------------------------------------------------------------------------
// Dial plan
// ---------------------------------------------------------------------------

/**
 * Expand a profile into the ordered list of hosts to dial: every ProxyJump
 * hop (each recursively resolved through the config, like the `ssh -W`
 * processes OpenSSH would spawn) and the final target last.
 */
export function buildChain(doc: ConfigDocument, profile: Pick<SshProfile, 'target' | 'user' | 'port'>): ChainHop[] {
  const chain: ChainHop[] = [];
  const visited = new Set<string>();

  const walk = (spec: { host: string; user?: string; port?: number }, final: boolean, depth: number): void => {
    if (depth > MAX_JUMP_DEPTH) throw new Error('ProxyJump chain too deep');
    if (visited.has(spec.host)) throw new Error(`ProxyJump cycle detected at "${spec.host}"`);
    visited.add(spec.host);
    const resolved = resolveHost(doc, spec.host);
    for (const hopSpec of resolved.proxyJump) walk(parseHostSpec(hopSpec), false, depth + 1);
    chain.push({
      spec,
      resolved,
      user: (final ? profile.user : undefined) ?? spec.user ?? resolved.user ?? os.userInfo().username,
      port: (final ? profile.port : undefined) ?? spec.port ?? resolved.port,
      hopLabel: final ? undefined : spec.host,
    });
  };

  walk(parseHostSpec(profile.target), true, 0);
  return chain;
}

/** Ad-hoc targets never masquerade as OpenSSH-backed database profiles. */
export function findMetadataAlias(doc: ConfigDocument, requestedHost: string): string | undefined {
  return listHosts(doc).some((entry) => entry.aliases.includes(requestedHost))
    ? requestedHost
    : undefined;
}

/** direct-tcpip channel from a jump host to the next hop — the `ssh -W` equivalent. */
function openJumpChannel(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) reject(new Error(`jump host could not reach ${host}:${port}: ${err.message}`));
      else resolve(stream);
    });
  });
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

interface AuthAttempt {
  type: AuthenticationType;
  get(): Promise<AnyAuthMethod | undefined>;
}

/**
 * OpenSSH's client auth order as an ssh2 authHandler: none → agent (unless
 * IdentitiesOnly) → identity files (config ones first, else the default
 * id_* files) with passphrase prompts → keyboard-interactive → password.
 * Every attempt happens inside one TCP connection, like the real client.
 */
class AuthLadder {
  private readonly attempts: AuthAttempt[];
  private index = 0;
  cancelled = false;

  constructor(
    private readonly hop: ChainHop,
    private readonly io: ConnectIo,
  ) {
    this.attempts = this.build();
  }

  next(authsLeft: AuthenticationType[] | null, cb: (method: AnyAuthMethod | false) => void): void {
    const attempt = this.attempts[this.index++];
    if (!attempt || this.cancelled) {
      cb(false);
      return;
    }
    // The server told us which methods can still succeed; skip the rest.
    if (authsLeft && attempt.type !== 'none' && !authsLeft.includes(attempt.type)) {
      this.next(authsLeft, cb);
      return;
    }
    attempt
      .get()
      .then((method) => {
        if (method) cb(method);
        else this.next(authsLeft, cb);
      })
      .catch(() => {
        this.cancelled = true;
        cb(false);
      });
  }

  private build(): AuthAttempt[] {
    const { resolved, user, hopLabel } = this.hop;
    const label = hopLabel ?? this.hop.spec.host;
    const attempts: AuthAttempt[] = [{ type: 'none', get: () => Promise.resolve({ type: 'none', username: user }) }];
    const agent = agentSocket();

    if (!resolved.passwordOnly) {
      if (agent && !resolved.identitiesOnly) {
        attempts.push({ type: 'agent', get: () => Promise.resolve({ type: 'agent', username: user, agent }) });
      }
      const explicit = resolved.identityFiles.length > 0;
      const files = explicit ? resolved.identityFiles : defaultIdentityFiles();
      for (const file of files) {
        attempts.push({ type: 'publickey', get: () => this.loadKey(file, explicit, !!agent, user, label) });
      }
    }

    attempts.push({
      type: 'keyboard-interactive',
      get: () =>
        Promise.resolve({
          type: 'keyboard-interactive',
          username: user,
          prompt: (name, instructions, _lang, prompts, finish) => {
            this.io
              .prompt({
                name: name || undefined,
                instructions: instructions || undefined,
                host: label,
                prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo !== false })),
              })
              .then(finish)
              .catch(() => {
                this.cancelled = true;
                finish(prompts.map(() => ''));
              });
          },
        }),
    });

    for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
      attempts.push({
        type: 'password',
        get: async () => {
          const [password] = await this.io.prompt({
            host: label,
            prompts: [{ prompt: attempt === 1 ? `${user}@${label}'s password` : 'Permission denied, please try again. Password', echo: false }],
          });
          return { type: 'password', username: user, password: password ?? '' };
        },
      });
    }
    return attempts;
  }

  /** Read + parse one identity file, prompting for its passphrase when needed. */
  private async loadKey(file: string, explicit: boolean, agentAvailable: boolean, user: string, label: string): Promise<AnyAuthMethod | undefined> {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch {
      if (explicit) this.io.status(`identity file ${file} not found — skipping`);
      return undefined;
    }
    let parsed = utils.parseKey(content);
    if (parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message)) {
      // Encrypted. Default (unconfigured) keys next to a running agent are
      // skipped silently — the agent attempt already covered the loaded ones.
      if (!explicit && agentAvailable) return undefined;
      for (let i = 0; i < MAX_PASSPHRASE_ATTEMPTS && parsed instanceof Error; i++) {
        const [passphrase] = await this.io.prompt({
          host: label,
          prompts: [{ prompt: `${i > 0 ? 'Bad passphrase, try again. ' : ''}Passphrase for ${path.basename(file)}`, echo: false }],
        });
        if (!passphrase) return undefined; // empty answer = skip this key
        parsed = utils.parseKey(content, passphrase);
      }
    }
    if (parsed instanceof Error) {
      this.io.status(`could not load ${path.basename(file)}: ${parsed.message}`);
      return undefined;
    }
    return { type: 'publickey', username: user, key: parsed as ParsedKey };
  }
}

function defaultIdentityFiles(): string[] {
  const dir = path.join(os.homedir(), '.ssh');
  return DEFAULT_IDENTITY_NAMES.map((name) => path.join(dir, name)).filter((p) => fs.existsSync(p));
}

/** Translate the common ssh2 failure modes into user-actionable messages. */
function friendlyConnectError(err: Error, hop: ChainHop): Error {
  const msg = err.message;
  const where = `${hop.resolved.hostname}:${hop.port}`;
  if (/ECONNREFUSED/.test(msg)) return new Error(`connection refused by ${where} — is sshd running?`);
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return new Error(`could not resolve host ${hop.resolved.hostname}`);
  if (/ETIMEDOUT|Timed out/i.test(msg)) return new Error(`connection to ${where} timed out`);
  if (/All configured authentication methods failed/.test(msg)) return new Error(`authentication to ${where} failed`);
  return err;
}
