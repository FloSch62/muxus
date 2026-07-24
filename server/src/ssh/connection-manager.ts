import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import {
  Client,
  type AnyAuthMethod,
  type AuthenticationType,
  type ClientChannel,
  type ConnectConfig,
  type ParsedKey,
  type PseudoTtyOptions,
  type SFTPWrapper,
} from 'ssh2';
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import type { ConfigForward, ConnectionInfo, SshProfile } from '@muxus/shared';
import {
  certificateAlgorithms,
  certificateMatchesKey,
  certifiedKey,
  parseOpenSshCertificate,
  parseSshKey,
  type OpenSshCertificate,
} from './certificates.js';
import { KnownHostsStore, fingerprintSha256, hostKeyType } from './known-hosts.js';
import { agentSocket } from './key-scan.js';
import {
  ConnectionLeaseRegistry,
  type ConnectionLeaseOwner,
  type TransportLease,
} from './connection-leases.js';
import { openIntegratedRemoteShell } from './remote-shell-integration.js';
import {
  expandIdentityPath,
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
  status(message: string, options?: { transient?: boolean }): void;
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
  /** Subscribe to passive keepalive health; returns an unsubscribe function. */
  onHealth(listener: (state: SshTransportHealth) => void): () => void;
  /** Subscribe to transport loss; returns an unsubscribe function. */
  onClose(listener: (reason?: string) => void): () => void;
  /** Force-close the transport, regardless of active leases. */
  close(): void;
}

export type ConnectionLease = TransportLease<ManagedConnection>;
export type SshTransportHealth = 'healthy' | 'suspect';

const MAX_JUMP_DEPTH = 8;
const MAX_PASSWORD_ATTEMPTS = 3;
const MAX_PASSPHRASE_ATTEMPTS = 3;
const DEFAULT_IDENTITY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_ed25519_sk', 'id_ecdsa_sk'];

/**
 * Observe replies to ssh2's existing keepalives without sending any probes of
 * our own. Two silent intervals mean at least one keepalive went unanswered.
 */
export function observeSshTransportHealth(
  stream: Pick<Duplex, 'on' | 'off'>,
  keepaliveIntervalMs: number,
  listener: (state: SshTransportHealth) => void,
): () => void {
  if (keepaliveIntervalMs <= 0) return () => undefined;

  let state: SshTransportHealth = 'healthy';
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (state === 'suspect') return;
      state = 'suspect';
      listener(state);
    }, keepaliveIntervalMs * 2);
  };
  const onData = () => {
    if (state === 'suspect') {
      state = 'healthy';
      listener(state);
    }
    arm();
  };

  stream.on('data', onData);
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    stream.off('data', onData);
  };
}

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
 * (each hop resolved, verified and authenticated in its own right),
 * ProxyCommand transports, agent + CertificateFile/IdentityFile +
 * keyboard-interactive + password auth in OpenSSH order, and host keys
 * checked against the real known_hosts files.
 */
export class SshConnectionManager {
  private readonly connections = new ConnectionLeaseRegistry<ManagedConnection>();
  private readonly closeReasons = new WeakMap<Client, string>();
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
    const healthListeners = new Set<(state: SshTransportHealth) => void>();
    const hopHealth = new Map<number, SshTransportHealth>();
    const stopHealthObservers: Array<() => void> = [];
    let transportHealth: SshTransportHealth = 'healthy';
    const updateHopHealth = (index: number, state: SshTransportHealth) => {
      hopHealth.set(index, state);
      const next = [...hopHealth.values()].includes('suspect') ? 'suspect' : 'healthy';
      if (next === transportHealth) return;
      transportHealth = next;
      for (const listener of healthListeners) listener(next);
    };
    const stopHealth = () => {
      for (const stop of stopHealthObservers.splice(0)) stop();
    };
    let sock: Duplex | undefined;
    try {
      for (let i = 0; i < chain.length; i++) {
        const hop = chain[i]!;
        const via = i > 0 ? ` via ${chain[i - 1]!.spec.host}` : '';
        io.status(
          `Connecting to ${hop.user}@${hop.resolved.hostname}:${hop.port}${via} …`,
          { transient: true },
        );
        const client = await this.dial(hop, sock, io);
        clients.push(client);
        hopHealth.set(i, 'healthy');
        const transport = (client as Client & { _sock?: Duplex })._sock;
        if (transport) {
          stopHealthObservers.push(
            observeSshTransportHealth(
              transport,
              (hop.resolved.serverAliveInterval ?? 15) * 1000,
              (state) => updateHopHealth(i, state),
            ),
          );
        }
        const next = chain[i + 1];
        if (next) sock = await openJumpChannel(client, next.resolved.hostname, next.port);
      }
    } catch (err) {
      stopHealth();
      for (const c of clients.reverse()) c.end();
      throw err;
    }

    const target = chain[chain.length - 1]!;
    const client = clients[clients.length - 1]!;
    const jumpClients = clients.slice(0, -1);
    const metadataAlias =
      profile.useConfig === false ? undefined : findMetadataAlias(doc, target.spec.host);
    const id = nanoid(10);
    const closeListeners = new Set<(reason?: string) => void>();
    let sftpPromise: Promise<SFTPWrapper> | undefined;
    let closed = false;
    let ending = false;

    const getSftp = () => {
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
    };

    const managed: ManagedConnection = {
      id,
      client,
      profile,
      host: target.resolved.hostname,
      port: target.port,
      user: target.user,
      metadataAlias,
      configForwards: target.resolved.forwards,
      shell: async (cols, rows, term) => {
        const pty = terminalPtyOptions(cols, rows, term);
        const integrated = await openIntegratedRemoteShell(client, getSftp, pty);
        if (integrated) return integrated;
        return new Promise((resolve, reject) => {
          client.shell(pty, (err, stream) => (err ? reject(err) : resolve(stream)));
        });
      },
      // One SFTP channel per connection, shared by every file operation.
      sftp: getSftp,
      onHealth: (listener) => {
        healthListeners.add(listener);
        if (transportHealth === 'suspect') {
          queueMicrotask(() => {
            if (healthListeners.has(listener)) listener(transportHealth);
          });
        }
        return () => healthListeners.delete(listener);
      },
      onClose: (listener) => {
        if (closed) {
          queueMicrotask(() => listener(this.closeReasons.get(client)));
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
      stopHealth();
      this.connections.markClosed(managed);
      for (const jump of jumpClients) jump.end();
      const reason = this.closeReasons.get(client);
      for (const listener of closeListeners) listener(reason);
      closeListeners.clear();
      healthListeners.clear();
    });
    for (const [index, jump] of jumpClients.entries()) {
      // A dying hop takes the whole chain with it; surface that as a close.
      jump.on('close', () => {
        if (closed || ending) return;
        this.closeReasons.set(
          client,
          `SSH jump host ${chain[index]?.spec.host ?? index + 1} disconnected.`,
        );
        client.end();
      });
    }
    return this.connections.register(managed, owner);
  }

  closeAll(): void {
    this.connections.closeAll();
  }

  private dial(hop: ChainHop, sock: Duplex | undefined, io: ConnectIo): Promise<Client> {
    const agent = agentSocket();
    const auth = new AuthLadder(hop, io);
    const proxySocket =
      !sock && hop.resolved.proxyCommand
        ? openProxyCommand(
            expandProxyCommand(hop.resolved.proxyCommand, {
              hostname: hop.resolved.hostname,
              originalHost: hop.spec.host,
              port: hop.port,
              user: hop.user,
            }),
          )
        : undefined;
    const transport = sock ?? proxySocket;
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
      ...(transport ? { sock: transport } : { host: hop.resolved.hostname, port: hop.port }),
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
          proxySocket?.destroy();
          reject(friendlyConnectError(auth.cancelled ? new Error('authentication cancelled') : err, hop));
        } else {
          this.closeReasons.set(client, friendlyConnectError(err, hop).message);
          this.log.warn({ err, host: hop.resolved.hostname }, 'ssh connection error');
        }
      });
      client.on('close', () => proxySocket?.destroy());
      client.connect(config);
      // Interactive input consists of tiny packets. Disable Nagle explicitly
      // so a keystroke never waits for a previous packet's acknowledgement.
      client.setNoDelay(true);
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
export function buildChain(
  doc: ConfigDocument,
  profile: Omit<SshProfile, 'kind'>,
): ChainHop[] {
  const chain: ChainHop[] = [];
  const visited = new Set<string>();

  const walk = (spec: { host: string; user?: string; port?: number }, final: boolean, depth: number): void => {
    if (depth > MAX_JUMP_DEPTH) throw new Error('ProxyJump chain too deep');
    if (visited.has(spec.host)) throw new Error(`ProxyJump cycle detected at "${spec.host}"`);
    visited.add(spec.host);
    const fromConfig = !final || profile.useConfig !== false;
    const base = fromConfig ? resolveHost(doc, spec.host) : directSettings(spec.host);
    const user = (final ? profile.user : undefined) ?? spec.user ?? base.user ?? os.userInfo().username;
    const resolved: ResolvedTarget = final
      ? {
          ...base,
          identityFiles:
            profile.identityFiles === undefined
              ? base.identityFiles
              : profile.identityFiles.map((file) =>
                  expandIdentityPath(file, { h: base.hostname, r: user }),
                ),
          identitiesOnly: profile.identitiesOnly ?? base.identitiesOnly,
          forwardAgent: profile.forwardAgent ?? base.forwardAgent,
          proxyJump: profile.proxyJump ?? base.proxyJump,
          proxyCommand:
            profile.proxyJump === undefined ? base.proxyCommand : undefined,
          passwordOnly: profile.passwordOnly ?? base.passwordOnly,
        }
      : base;
    for (const hopSpec of resolved.proxyJump) walk(parseHostSpec(hopSpec), false, depth + 1);
    chain.push({
      spec,
      resolved,
      user,
      port: (final ? profile.port : undefined) ?? spec.port ?? resolved.port,
      hopLabel: final ? undefined : spec.host,
    });
  };

  walk(parseHostSpec(profile.target), true, 0);
  return chain;
}

function directSettings(hostname: string): ResolvedTarget {
  return {
    hostname,
    port: 22,
    identityFiles: [],
    certificateFiles: [],
    identitiesOnly: false,
    forwardAgent: false,
    proxyJump: [],
    forwards: [],
    passwordOnly: false,
  };
}

/** Expand the tokens accepted by OpenSSH's ProxyCommand directive. */
export function expandProxyCommand(
  command: string,
  tokens: { hostname: string; originalHost: string; port: number; user: string },
): string {
  return command.replace(/%%|%[hnpr]/g, (token) => {
    switch (token) {
      case '%%':
        return '%';
      case '%h':
        return tokens.hostname;
      case '%n':
        return tokens.originalHost;
      case '%p':
        return String(tokens.port);
      default:
        return tokens.user;
    }
  });
}

const PROXY_STDERR_LIMIT = 8 * 1024;

/**
 * Run ProxyCommand with the user's platform shell and expose its stdin/stdout
 * as the byte stream ssh2 expects. This matches OpenSSH's shell-command
 * semantics, including pipes and quoted arguments.
 */
function openProxyCommand(command: string): Duplex {
  const child = spawn(command, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stream = Duplex.from({
    readable: child.stdout,
    writable: child.stdin,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-PROXY_STDERR_LIMIT);
  });
  child.once('error', (err) => {
    stream.destroy(new Error(`ProxyCommand could not start: ${err.message}`));
  });
  child.once('exit', (code, signal) => {
    if (code === 0 || stream.destroyed) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    const detail = stderr.trim();
    stream.destroy(
      new Error(`ProxyCommand failed with ${reason}${detail ? `: ${detail}` : ''}`),
    );
  });
  stream.once('close', () => {
    if (child.exitCode === null && !child.killed) child.kill();
  });
  return stream;
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
 * IdentitiesOnly) → configured certificates with their matching private keys
 * → identity files (config ones first, else the default id_* files) with
 * passphrase prompts → keyboard-interactive → password.
 * Every attempt happens inside one TCP connection, like the real client.
 */
class AuthLadder {
  private readonly attempts: AuthAttempt[];
  private readonly privateKeys = new Map<string, Promise<ParsedKey | undefined>>();
  private readonly certificateKeys = new Map<
    OpenSshCertificate,
    Promise<ParsedKey | undefined>
  >();
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
      const certificates = resolved.certificateFiles
        .map((file) => this.loadCertificate(file))
        .filter((item): item is { file: string; certificate: OpenSshCertificate } => !!item);
      for (const { file, certificate } of certificates) {
        for (const algorithm of certificateAlgorithms(certificate)) {
          attempts.push({
            type: 'publickey',
            get: async () => {
              const privateKey = await this.findCertificateKey(
                file,
                certificate,
                files,
                explicit || resolved.certificateFiles.length > 0,
                !!agent,
                label,
              );
              if (!privateKey) return undefined;
              const key = certifiedKey(privateKey, certificate, algorithm);
              if (key instanceof Error) {
                this.io.status(`could not load ${path.basename(file)}: ${key.message}`);
                return undefined;
              }
              return { type: 'publickey', username: user, key };
            },
          });
        }
      }
      for (const file of files) {
        attempts.push({
          type: 'publickey',
          get: async () => {
            const key = await this.loadPrivateKey(file, explicit, !!agent, label);
            return key ? { type: 'publickey', username: user, key } : undefined;
          },
        });
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

  private loadCertificate(
    file: string,
  ): { file: string; certificate: OpenSshCertificate } | undefined {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch {
      this.io.status(`certificate file ${file} not found — skipping`);
      return undefined;
    }
    const certificate = parseOpenSshCertificate(content);
    if (certificate instanceof Error) {
      this.io.status(
        `could not load ${path.basename(file)}: ${certificate.message}`,
      );
      return undefined;
    }
    return { file, certificate };
  }

  private findCertificateKey(
    certificateFile: string,
    certificate: OpenSshCertificate,
    identityFiles: string[],
    explicit: boolean,
    agentAvailable: boolean,
    label: string,
  ): Promise<ParsedKey | undefined> {
    const cached = this.certificateKeys.get(certificate);
    if (cached) return cached;
    const pending = (async () => {
      for (const file of identityFiles) {
        const key = await this.loadPrivateKey(
          file,
          explicit,
          agentAvailable,
          label,
        );
        if (key && certificateMatchesKey(certificate, key)) {
          return key;
        }
      }
      this.io.status(
        `certificate ${certificateFile} has no matching identity file — skipping`,
      );
      return undefined;
    })();
    this.certificateKeys.set(certificate, pending);
    return pending;
  }

  /** Read + parse one identity file, prompting for its passphrase when needed. */
  private loadPrivateKey(
    file: string,
    explicit: boolean,
    agentAvailable: boolean,
    label: string,
  ): Promise<ParsedKey | undefined> {
    const cached = this.privateKeys.get(file);
    if (cached) return cached;
    const pending = this.readPrivateKey(file, explicit, agentAvailable, label);
    this.privateKeys.set(file, pending);
    return pending;
  }

  private async readPrivateKey(
    file: string,
    explicit: boolean,
    agentAvailable: boolean,
    label: string,
  ): Promise<ParsedKey | undefined> {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch {
      if (explicit) this.io.status(`identity file ${file} not found — skipping`);
      return undefined;
    }
    let parsed = parseSshKey(content);
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
        parsed = parseSshKey(content, passphrase);
      }
    }
    if (parsed instanceof Error) {
      this.io.status(`could not load ${path.basename(file)}: ${parsed.message}`);
      return undefined;
    }
    return parsed as ParsedKey;
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
