import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import ssh2, {
  Client,
  type AnyAuthMethod,
  type AuthenticationType,
  type BaseAgent,
  type ClientChannel,
  type ConnectConfig,
  type ParsedKey,
  type Prompt,
  type PseudoTtyOptions,
  type SFTPWrapper,
} from 'ssh2';
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
  type AuthPromptInfo,
  type AuthPromptResponse,
  type ConfigForward,
  type ConnectionInfo,
  type SshProfile,
} from '@muxus/shared';
import {
  certificateAlgorithms,
  certificateMatchesKey,
  certifiedKey,
  parseOpenSshCertificate,
  parseSshKey,
  type OpenSshCertificate,
} from './certificates.js';
import { KnownHostsStore, fingerprintSha256, hostKeyType } from './known-hosts.js';
import { listAgentKeys, resolveAgentSocket } from './key-scan.js';
import {
  DEFAULT_AGENT_OPERATION_TIMEOUT_MS,
  DEFAULT_AGENT_WAIT_STATUS_MS,
  ResponsiveAgent,
} from './responsive-agent.js';
import {
  ConnectionLeaseRegistry,
  type ConnectionLeaseOwner,
  type TransportLease,
} from './connection-leases.js';
import { connectionAlgorithms } from './algorithms.js';
import { openIntegratedRemoteShell } from './remote-shell-integration.js';
import {
  CredentialVaultCorruptError,
  InvalidMasterPasswordError,
  InvalidMasterPasswordFormatError,
  PasswordVault,
  VaultAlreadyConfiguredError,
  sshPasswordAccount,
  sshPasswordLabel,
} from '../security/password-vault.js';
import { VaultKeyStoreUnavailableError } from '../security/vault-key-store.js';
import {
  expandIdentityPath,
  listHosts,
  loadConfigDocument,
  parseHostSpec,
  resolveHost,
  sessionEnvironment,
  type ConfigDocument,
  type ResolvedTarget,
} from './ssh-config.js';
import type { FolderAuthLookup, FolderPasswordRef } from './folder-auth.js';

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
  prompt(info: AuthPromptInfo): Promise<AuthPromptResponse>;
  /** Ask the user to accept a new or changed host key. */
  hostKey(challenge: HostKeyChallenge): Promise<boolean>;
}

/**
 * Per-session channel settings from ssh config. Resolved per connect call —
 * two aliases multiplexed onto one transport keep their own environment and
 * RemoteCommand, the way each `ssh` invocation does under ControlMaster.
 */
export interface SessionSettings {
  env?: Record<string, string>;
  remoteCommand?: string;
  requestTty?: ResolvedTarget['requestTty'];
}

export function sessionSettings(resolved: ResolvedTarget): SessionSettings {
  return {
    env: sessionEnvironment(resolved),
    remoteCommand: resolved.remoteCommand,
    requestTty: resolved.requestTty,
  };
}

/** RequestTTY the way ssh(1) treats it: auto ⇒ a tty only for plain shells. */
function wantsPty(requestTty: ResolvedTarget['requestTty'], hasCommand: boolean): boolean {
  if (requestTty === 'no') return false;
  if (requestTty === 'yes' || requestTty === 'force') return true;
  return !hasCommand;
}

export interface ManagedConnection {
  id: string;
  client: Client;
  profile: SshProfile;
  host: string;
  port: number;
  user: string;
  /** Dial-plan identity for connection sharing; see {@link muxKey}. */
  muxKey: string;
  /** Concrete OpenSSH alias eligible for Muxus-owned recent-use metadata. */
  metadataAlias?: string;
  /** *Forward lines resolved from ssh config — auto-started once the session is up. */
  configForwards: ConfigForward[];
  /** Current passive keepalive health of the transport. */
  health(): SshTransportHealth;
  /** Session defaults come from the dialed target when none are passed. */
  shell(cols: number, rows: number, term: string, session?: SessionSettings): Promise<ClientChannel>;
  sftp(): Promise<SFTPWrapper>;
  /** Subscribe to passive keepalive health; returns an unsubscribe function. */
  onHealth(listener: (state: SshTransportHealth) => void): () => void;
  /** Subscribe to transport loss; returns an unsubscribe function. */
  onClose(listener: (reason?: string) => void): () => void;
  /** Wait for post-authentication password-vault prompts and saving. */
  waitForPostAuth(): Promise<void>;
  /** Force-close the transport, regardless of active leases. */
  close(): void;
}

export type ConnectionLease = TransportLease<ManagedConnection>;
export type SshTransportHealth = 'healthy' | 'suspect';

export interface MuxedConnectionLease extends TransportLease<ManagedConnection> {
  /** True when this lease multiplexes onto a pre-existing transport instead of a fresh dial. */
  reused: boolean;
  /** This connect call's resolved final hop (not the dialing call's) — the
   *  source for per-alias session settings on a shared transport. */
  target: ChainHop;
}

export interface TerminalShell {
  lease: MuxedConnectionLease;
  stream: ClientChannel;
  /**
   * 'new' — fresh transport, this session owns starting its config forwards;
   * 'shared' — multiplexed onto a live transport that already has them;
   * 'overflow' — dedicated transport dialed because the shared one refused
   * another session; its sibling still owns the config forwards.
   */
  transport: 'new' | 'shared' | 'overflow';
}

const MAX_JUMP_DEPTH = 8;
const MAX_KEYBOARD_INTERACTIVE_ATTEMPTS = 3;
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
  /** Folder passwords in the vault this hop may fall back to, nearest first. */
  folderPasswords?: readonly FolderPasswordRef[];
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
  private readonly postAuth = new WeakMap<Client, Promise<void>>();
  /** In-flight dials by mux key, so simultaneous sessions share one TCP connection and one auth round-trip. */
  private readonly pendingDials = new Map<string, Promise<ManagedConnection>>();
  private readonly loadConfig: () => ConfigDocument;
  private readonly vault: PasswordVault | undefined;
  private readonly folderAuth: FolderAuthLookup | undefined;
  private readonly agentOperationTimeoutMs: number;
  private readonly agentWaitStatusMs: number;
  readonly knownHosts: KnownHostsStore;

  constructor(
    private readonly log: FastifyBaseLogger,
    options: {
      knownHosts?: KnownHostsStore;
      loadConfig?: () => ConfigDocument;
      vault?: PasswordVault;
      /** Folder-inherited connection defaults per alias (Muxus sidebar folders). */
      folderAuth?: FolderAuthLookup;
      /** Test seam; production uses the exported responsive-agent defaults. */
      agentOperationTimeoutMs?: number;
      /** Test seam; production uses the exported responsive-agent defaults. */
      agentWaitStatusMs?: number;
    } = {},
  ) {
    this.knownHosts = options.knownHosts ?? new KnownHostsStore();
    this.loadConfig = options.loadConfig ?? (() => loadConfigDocument());
    this.vault = options.vault;
    this.folderAuth = options.folderAuth;
    this.agentOperationTimeoutMs =
      options.agentOperationTimeoutMs ?? DEFAULT_AGENT_OPERATION_TIMEOUT_MS;
    this.agentWaitStatusMs =
      options.agentWaitStatusMs ?? DEFAULT_AGENT_WAIT_STATUS_MS;
  }

  /** Acquire an independent consumer lease on an existing SSH transport. */
  acquire(id: string, owner: ConnectionLeaseOwner): ConnectionLease | undefined {
    return this.connections.acquire(id, owner);
  }

  /** Live lease count on a connection, optionally restricted to owner kinds. */
  leaseCount(id: string, owners?: readonly ConnectionLeaseOwner[]): number {
    return this.connections.leaseCount(id, owners);
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

  /**
   * Connect with OpenSSH-ControlMaster-style multiplexing: a session whose
   * dial plan matches a live, healthy transport attaches to it as a new
   * lease instead of opening another TCP connection — split panes, SFTP,
   * tunnels and repeated connects to one host share a single SSH connection,
   * which also keeps Muxus inside server-side connection caps (MaxStartups,
   * per-user limits). Concurrent dials to the same plan (workspace restore)
   * collapse into one connection and one auth round-trip.
   */
  async connect(
    profile: SshProfile,
    io: ConnectIo,
    owner: ConnectionLeaseOwner = 'terminal',
    opts: { freshTransport?: boolean } = {},
  ): Promise<MuxedConnectionLease> {
    const doc = this.loadConfig();
    const chain = buildChain(doc, profile, this.folderAuth);
    const key = muxKey(chain);
    const target = chain[chain.length - 1]!;
    const configForwards = target.resolved.forwards;
    const label = `${target.user}@${target.resolved.hostname}:${target.port}`;
    this.log.debug(
      { target: profile.target, label, hops: chain.length, owner },
      'ssh connect requested',
    );

    if (!opts.freshTransport) {
      const shared = this.acquireShared(key, owner, target);
      if (shared) {
        shared.connection.configForwards = mergeConfigForwards(
          shared.connection.configForwards,
          configForwards,
        );
        this.log.debug({ label, connId: shared.connection.id }, 'reusing multiplexed ssh transport');
        io.status(`Reusing the SSH connection to ${label} (multiplexed).`, { transient: true });
        return shared;
      }
      const pending = this.pendingDials.get(key);
      if (pending) {
        io.status(`Waiting for the SSH connection to ${label} …`, { transient: true });
        // A failed dial fails every session waiting on it — auth prompts and
        // errors surface on the session that started the dial.
        const conn = await pending;
        const lease = this.connections.acquire(conn.id, owner);
        if (lease) {
          conn.configForwards = mergeConfigForwards(conn.configForwards, configForwards);
          return { ...lease, reused: true, target };
        }
        // The transport died between ready and acquire; dial our own below.
      }
    }

    const dial = this.dialChain(doc, chain, profile, io, owner, key);
    const tracked = dial.then((lease) => lease.connection);
    tracked.catch(() => undefined); // waiters observe the rejection through their own await
    this.pendingDials.set(key, tracked);
    try {
      const lease = await dial;
      return { ...lease, reused: false, target };
    } finally {
      if (this.pendingDials.get(key) === tracked) this.pendingDials.delete(key);
    }
  }

  /** Least-busy live, healthy transport with the same dial plan, if any. */
  private acquireShared(
    key: string,
    owner: ConnectionLeaseOwner,
    target: ChainHop,
  ): MuxedConnectionLease | undefined {
    const candidates = this.connections
      .list()
      .filter((conn) => conn.muxKey === key && conn.health() === 'healthy')
      .sort((a, b) => this.connections.leaseCount(a.id) - this.connections.leaseCount(b.id));
    for (const conn of candidates) {
      const lease = this.connections.acquire(conn.id, owner);
      if (lease) return { ...lease, reused: true, target };
    }
    return undefined;
  }

  /**
   * Terminal entry point: connect (sharing a transport when possible) and
   * open the shell channel. When a shared transport refuses another session
   * channel (sshd MaxSessions and similar per-connection caps), falls back
   * to a dedicated transport — a new pane never fails just because the
   * multiplexed connection is full.
   */
  async connectShell(
    profile: SshProfile,
    io: ConnectIo,
    cols: number,
    rows: number,
    term: string,
  ): Promise<TerminalShell> {
    const lease = await this.connect(profile, io);
    try {
      const stream = await lease.connection.shell(cols, rows, term, sessionSettings(lease.target.resolved));
      return { lease, stream, transport: lease.reused ? 'shared' : 'new' };
    } catch (err) {
      lease.release();
      if (!lease.reused) throw err;
      this.log.info(
        { host: lease.connection.host, err: String(err) },
        'shared ssh transport refused a session; dialing a dedicated connection',
      );
      io.status('The shared SSH connection refused another session — opening a dedicated one …', { transient: true });
      const dedicated = await this.connect(profile, io, 'terminal', { freshTransport: true });
      try {
        const stream = await dedicated.connection.shell(cols, rows, term, sessionSettings(dedicated.target.resolved));
        return { lease: dedicated, stream, transport: 'overflow' };
      } catch (retryErr) {
        dedicated.release();
        throw retryErr;
      }
    }
  }

  private async dialChain(
    doc: ConfigDocument,
    chain: ChainHop[],
    profile: SshProfile,
    io: ConnectIo,
    owner: ConnectionLeaseOwner,
    key: string,
  ): Promise<ConnectionLease> {
    const clients: Client[] = [];
    const postAuth: Promise<void>[] = [];
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
        const pendingPostAuth = this.postAuth.get(client);
        if (pendingPostAuth) postAuth.push(pendingPostAuth);
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
      // dial() already logged the raw failure; this adds which hop died.
      this.log.debug(
        { err, hops: chain.length, dialed: clients.length },
        'ssh dial chain aborted',
      );
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
    const postAuthSettled = Promise.all(postAuth).then(() => undefined);
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
      muxKey: key,
      metadataAlias,
      health: () => transportHealth,
      configForwards: target.resolved.forwards,
      shell: async (cols, rows, term, session = sessionSettings(target.resolved)) => {
        const pty = wantsPty(session.requestTty, !!session.remoteCommand)
          ? terminalPtyOptions(cols, rows, term)
          : undefined;
        if (session.remoteCommand) {
          return openSessionExec(client, session.remoteCommand, pty, session.env);
        }
        if (pty) {
          const integrated = await openIntegratedRemoteShell(client, getSftp, pty, session.env);
          if (integrated) return integrated;
        }
        return new Promise((resolve, reject) => {
          client.shell(pty ?? false, { env: session.env }, (err, stream) =>
            err ? reject(err) : resolve(stream),
          );
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
      waitForPostAuth: () => postAuthSettled,
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
    const agentSocket = resolveAgentSocket(hop.resolved.identityAgent);
    let readyDeadline: PausableDeadline | undefined;
    const runInteraction: InteractionRunner = async (interaction) => {
      readyDeadline?.pause();
      try {
        return await interaction();
      } finally {
        readyDeadline?.resume();
      }
    };
    const authAgent =
      agentSocket && !hop.resolved.identitiesOnly
        ? new ResponsiveAgent(ssh2.createAgent(agentSocket) as BaseAgent<ParsedKey>, {
            pauseDeadline: () => readyDeadline?.pause(),
            resumeDeadline: () => readyDeadline?.resume(),
            onWaiting: (operation) => {
              this.log.info(
                { host: hop.resolved.hostname, operation, agentSocket },
                'waiting for the ssh agent to respond',
              );
              io.status(
                operation === 'sign'
                  ? 'Waiting for the SSH agent to approve signing…'
                  : 'Waiting for the SSH agent to list identities…',
                { transient: true },
              );
            },
            waitStatusMs: this.agentWaitStatusMs,
            operationTimeoutMs: this.agentOperationTimeoutMs,
          })
        : undefined;
    const auth = new AuthLadder(
      hop,
      io,
      this.vault,
      runInteraction,
      authAgent,
      this.log,
    );
    const { algorithms, notes } = connectionAlgorithms(hop.resolved);
    for (const note of notes) {
      this.log.debug({ host: hop.resolved.hostname }, note);
      io.status(note);
    }
    const proxySocket =
      !sock && hop.resolved.proxyCommand ? openProxyCommand(expandedProxyCommand(hop)!) : undefined;
    const transport = sock ?? proxySocket;
    const readyTimeoutMs = (hop.resolved.connectTimeout ?? 20) * 1000;
    this.log.debug(
      {
        host: hop.resolved.hostname,
        port: hop.port,
        user: hop.user,
        agent: !!agentSocket,
        identitiesOnly: !!hop.resolved.identitiesOnly,
        proxyCommand: !!hop.resolved.proxyCommand,
        viaJump: !!sock,
        readyTimeoutMs,
      },
      'dialing ssh host',
    );
    const config: ConnectConfig = {
      username: hop.user,
      // ssh2's deadline includes time spent in UI prompts and cannot be
      // paused. An equivalent pausable deadline is installed below.
      readyTimeout: 0,
      keepaliveInterval: (hop.resolved.serverAliveInterval ?? 15) * 1000,
      keepaliveCountMax: hop.resolved.serverAliveCountMax ?? 3,
      ...(algorithms ? { algorithms } : {}),
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        void this.verifyHostKey(hop, key, io, runInteraction).then(verify, (err) => {
          this.log.warn(
            { err, host: hop.resolved.hostname },
            'host key verification failed',
          );
          verify(false);
        });
      },
      authHandler: (authsLeft, partialSuccess, next) => {
        auth.next(
          authsLeft,
          partialSuccess,
          next as (method: AnyAuthMethod | false) => void,
        );
      },
      ...(transport ? { sock: transport } : { host: hop.resolved.hostname, port: hop.port }),
      ...(agentSocket
        ? { agent: agentSocket, agentForward: hop.resolved.forwardAgent }
        : {}),
    };

    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      let ready = false;
      const rejectBeforeReady = (err: Error) => {
        if (settled) return;
        settled = true;
        // The raw error, before friendlyConnectError() rewrites it — an agent
        // stall and a network timeout look identical to the user otherwise.
        this.log.warn(
          { err, host: hop.resolved.hostname, port: hop.port, user: hop.user },
          'ssh dial failed',
        );
        readyDeadline?.clear();
        auth.dispose();
        proxySocket?.destroy();
        reject(friendlyConnectError(err, hop));
      };
      readyDeadline = new PausableDeadline(readyTimeoutMs, () => {
        rejectBeforeReady(new Error('Timed out while waiting for SSH readiness.'));
        client.destroy();
      });
      client.on('banner', (message: string) => io.status(message.trimEnd()));
      client.on('ready', () => {
        if (settled) return;
        ready = true;
        settled = true;
        this.log.debug(
          { host: hop.resolved.hostname, port: hop.port, user: hop.user },
          'ssh connection ready',
        );
        readyDeadline?.clear();
        const postAuth = auth
          .commitRememberedPassword()
          .catch((err) => {
            io.status(
              err instanceof Error
                ? `Connected, but the password was not remembered: ${err.message}`
                : 'Connected, but the password was not remembered.',
            );
          })
          .finally(() => {
            auth.dispose();
          });
        this.postAuth.set(client, postAuth);
        resolve(client);
      });
      client.on('error', (err) => {
        if (!settled && err.level === 'agent') {
          // ssh2 reports an unreachable agent mid-auth and then moves on to
          // the next method itself. This is an expected fallback when a stale
          // agent socket is inherited, so keep it out of user-facing status.
          if (err.message === 'Failed to connect to agent') {
            this.log.debug(
              { err, host: hop.resolved.hostname },
              'ssh-agent unavailable; trying other authentication methods',
            );
            return;
          }
          this.log.warn(
            { err, host: hop.resolved.hostname },
            'ssh-agent unavailable; trying other authentication methods',
          );
          io.status(`ssh-agent unavailable (${err.message}) — trying other authentication methods`);
          return;
        }
        if (!settled) {
          rejectBeforeReady(
            auth.cancelled ? new Error('authentication cancelled') : err,
          );
        } else if (ready) {
          this.closeReasons.set(client, friendlyConnectError(err, hop).message);
          this.log.warn({ err, host: hop.resolved.hostname }, 'ssh connection error');
        }
      });
      client.on('close', () => {
        proxySocket?.destroy();
        rejectBeforeReady(
          new Error('SSH connection closed before it became ready.'),
        );
      });
      client.connect(config);
      // Interactive input consists of tiny packets. Disable Nagle explicitly
      // so a keystroke never waits for a previous packet's acknowledgement.
      client.setNoDelay(true);
    });
  }

  /** The default store, or a per-host one when the config redirects the files. */
  private knownHostsFor(hop: ChainHop): KnownHostsStore {
    const { userKnownHostsFiles, globalKnownHostsFiles } = hop.resolved;
    if (!userKnownHostsFiles && !globalKnownHostsFiles) return this.knownHosts;
    return new KnownHostsStore(userKnownHostsFiles, globalKnownHostsFiles);
  }

  private async verifyHostKey(
    hop: ChainHop,
    key: Buffer,
    io: ConnectIo,
    runInteraction: InteractionRunner,
  ): Promise<boolean> {
    const host = hop.resolved.hostname;
    const port = hop.port;
    const store = this.knownHostsFor(hop);
    const verdict = store.verify(host, port, key);
    this.log.debug(
      { host, port, keyType: hostKeyType(key), verdict: verdict.state },
      'host key verified against known_hosts',
    );
    if (verdict.state === 'ok') return true;
    if (verdict.state === 'revoked') {
      this.log.warn({ host, port }, 'host key is revoked in known_hosts');
      io.status(`HOST KEY REVOKED for ${host} — remove the @revoked entry from known_hosts if this is intentional.`);
      return false;
    }
    const strict = hop.resolved.strictHostKeyChecking ?? 'ask';
    if (strict === 'yes') {
      this.log.warn(
        { host, port, verdict: verdict.state },
        'refusing host key under StrictHostKeyChecking=yes',
      );
      io.status(
        verdict.state === 'changed'
          ? `HOST KEY CHANGED for ${host} and StrictHostKeyChecking is yes — refusing to connect.`
          : `No ${hostKeyType(key)} host key for ${host} in known_hosts and StrictHostKeyChecking is yes — refusing to connect.`,
      );
      return false;
    }
    // `no` on a *changed* key still asks below: silently trusting a swapped
    // key is a footgun OpenSSH's degraded continue-mode doesn't map to.
    if (verdict.state === 'unknown' && (strict === 'accept-new' || strict === 'no')) {
      store.record(host, port, key);
      io.status(`Automatically accepted the new host key for ${host} (${fingerprintSha256(key)}).`);
      return true;
    }
    const accepted = await runInteraction(() =>
      io.hostKey({
        host,
        port,
        keyType: hostKeyType(key),
        fingerprint: fingerprintSha256(key),
        state: verdict.state === 'changed' ? 'mismatch' : 'new',
        previous: verdict.state === 'changed' ? verdict.previous : undefined,
        hop: hop.hopLabel,
      }),
    ).catch(() => false);
    this.log.debug({ host, port, accepted }, 'host key decision from the user');
    if (accepted) store.record(host, port, key);
    return accepted;
  }
}

// ---------------------------------------------------------------------------
// Dial plan
// ---------------------------------------------------------------------------

/**
 * Identity of a dial plan for connection sharing: the resolved hop sequence
 * (user@hostname:port and agent-forwarding policy for each hop) plus the
 * expanded ProxyCommand transport when one applies. Other auth settings are
 * deliberately absent — they matter while establishing a transport, not for
 * attaching to an established one.
 */
export function muxKey(chain: ChainHop[]): string {
  const hops = chain.map(
    (hop) =>
      `${hop.user}@${hop.resolved.hostname}:${hop.port};agentForward=${hop.resolved.forwardAgent ? 'yes' : 'no'}`,
  );
  const first = chain[0];
  const proxy = first?.resolved.proxyCommand ? expandedProxyCommand(first) : undefined;
  return (proxy ? [`proxy(${proxy})`, ...hops] : hops).join(' -> ');
}

function mergeConfigForwards(
  current: readonly ConfigForward[],
  requested: readonly ConfigForward[],
): ConfigForward[] {
  const merged = [...current];
  for (const forward of requested) {
    if (
      !merged.some(
        (existing) =>
          existing.type === forward.type &&
          existing.bindPort === forward.bindPort &&
          existing.targetHost === forward.targetHost &&
          existing.targetPort === forward.targetPort,
      )
    ) {
      merged.push(forward);
    }
  }
  return merged;
}

/**
 * Expand a profile into the ordered list of hosts to dial: every ProxyJump
 * hop (each recursively resolved through the config, like the `ssh -W`
 * processes OpenSSH would spawn) and the final target last. Each hop that is
 * a saved alias picks up its own folder's defaults as the lowest-priority
 * config layer.
 */
export function buildChain(
  doc: ConfigDocument,
  profile: Omit<SshProfile, 'kind'>,
  folderAuthFor?: FolderAuthLookup,
): ChainHop[] {
  const chain: ChainHop[] = [];
  const visited = new Set<string>();

  const walk = (spec: { host: string; user?: string; port?: number }, final: boolean, depth: number): void => {
    if (depth > MAX_JUMP_DEPTH) throw new Error('ProxyJump chain too deep');
    if (visited.has(spec.host)) throw new Error(`ProxyJump cycle detected at "${spec.host}"`);
    visited.add(spec.host);
    const fromConfig = !final || profile.useConfig !== false;
    const folder = fromConfig ? folderAuthFor?.(spec.host) : undefined;
    const base = fromConfig ? resolveHost(doc, spec.host, folder?.optionLines) : directSettings(spec.host);
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
      folderPasswords: folder?.passwords,
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
    setEnv: {},
    sendEnv: [],
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

function expandedProxyCommand(hop: ChainHop): string | undefined {
  if (!hop.resolved.proxyCommand) return undefined;
  return expandProxyCommand(hop.resolved.proxyCommand, {
    hostname: hop.resolved.hostname,
    originalHost: hop.spec.host,
    port: hop.port,
    user: hop.user,
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

interface RememberedPasswordCandidate {
  account: string;
  label: string;
  password: string;
}

interface PasswordCredential {
  account: string;
  label: string;
  existing: boolean;
}

/**
 * Keyboard-interactive is also used for OTPs and arbitrary challenges. Only
 * treat an unambiguous, single hidden password field as an SSH password.
 */
function isKeyboardInteractivePasswordPrompt(prompts: readonly Prompt[]): boolean {
  if (prompts.length !== 1 || prompts[0]?.echo !== false) return false;
  const label = prompts[0].prompt.trim().replace(/:\s*$/, '').trim();
  return (
    /^password(?:\s+for\s+.+)?$/i.test(label) ||
    /^.+(?:'s|’s)\s+password$/i.test(label)
  );
}

type InteractionRunner = <T>(interaction: () => Promise<T>) => Promise<T>;

class PausableDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remainingMs: number;
  private startedAt = 0;
  private pauseDepth = 0;
  private active: boolean;

  constructor(
    durationMs: number,
    private readonly expire: () => void,
  ) {
    this.remainingMs = durationMs;
    this.active = durationMs > 0;
    this.arm();
  }

  pause(): void {
    if (!this.active) return;
    this.pauseDepth += 1;
    if (this.pauseDepth !== 1) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.remainingMs = Math.max(
        0,
        this.remainingMs - (Date.now() - this.startedAt),
      );
    }
  }

  resume(): void {
    if (!this.active || this.pauseDepth === 0) return;
    this.pauseDepth -= 1;
    if (this.pauseDepth === 0) this.arm();
  }

  clear(): void {
    this.active = false;
    this.pauseDepth = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (!this.active || this.pauseDepth > 0) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.active) return;
      this.active = false;
      this.expire();
    }, this.remainingMs);
    this.timer.unref?.();
  }
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
  private agentIdentityPrints: Promise<Set<string>> | undefined;
  private lastPasswordCandidate: RememberedPasswordCandidate | undefined;
  private partialPasswordCandidate: RememberedPasswordCandidate | undefined;
  private savedPasswordAttempted = false;
  private retryKeyboardInteractive = false;
  cancelled = false;

  constructor(
    private readonly hop: ChainHop,
    private readonly io: ConnectIo,
    private readonly vault?: PasswordVault,
    private readonly runInteraction: InteractionRunner = (interaction) =>
      interaction(),
    private readonly agent?: BaseAgent<ParsedKey>,
    private readonly log?: FastifyBaseLogger,
  ) {
    this.attempts = this.build();
  }

  next(
    authsLeft: AuthenticationType[] | null,
    partialSuccess: boolean,
    cb: (method: AnyAuthMethod | false) => void,
  ): void {
    if (this.lastPasswordCandidate) {
      if (partialSuccess) {
        this.partialPasswordCandidate = this.lastPasswordCandidate;
      }
      this.lastPasswordCandidate = undefined;
    }
    this.advance(authsLeft, cb);
  }

  private advance(
    authsLeft: AuthenticationType[] | null,
    cb: (method: AnyAuthMethod | false) => void,
  ): void {
    const host = this.hop.resolved.hostname;
    const attempt = this.attempts[this.index++];
    if (!attempt || this.cancelled) {
      this.log?.debug(
        { host, cancelled: this.cancelled },
        'ssh auth ladder exhausted',
      );
      cb(false);
      return;
    }
    // The server told us which methods can still succeed; skip the rest.
    // Agent auth is publickey on the wire — servers never advertise "agent".
    const wireType = attempt.type === 'agent' ? 'publickey' : attempt.type;
    if (authsLeft && attempt.type !== 'none' && !authsLeft.includes(wireType)) {
      this.log?.debug(
        { host, method: attempt.type, authsLeft },
        'ssh auth method not accepted by server; skipping',
      );
      this.advance(authsLeft, cb);
      return;
    }
    attempt
      .get()
      .then((method) => {
        if (method) {
          this.log?.debug({ host, method: attempt.type }, 'trying ssh auth method');
          cb(method);
        } else {
          this.log?.debug(
            { host, method: attempt.type },
            'ssh auth method unavailable; skipping',
          );
          this.advance(authsLeft, cb);
        }
      })
      .catch(() => {
        this.cancelled = true;
        cb(false);
      });
  }

  async commitRememberedPassword(): Promise<void> {
    const candidate =
      this.lastPasswordCandidate ?? this.partialPasswordCandidate;
    if (!candidate || !this.vault) return;
    try {
      const status = this.vault.status();
      if (!status.configured) {
        if (!(await this.createVaultForSave(candidate.label))) return;
      }
      if (this.vault.status().locked) {
        const result = await this.promptForVaultOperation(
          'Unlock password vault',
          `Enter the master password to remember the password for ${candidate.label}.`,
          'Not now',
          (masterPassword) =>
            this.vault!.rememberSshPassword(
              candidate.account,
              candidate.label,
              candidate.password,
              masterPassword,
            ),
        );
        if (!result.ok) return;
      } else {
        await this.vault.rememberSshPassword(
          candidate.account,
          candidate.label,
          candidate.password,
        );
      }
      this.io.status(`Remembered the password for ${candidate.label}.`);
    } finally {
      this.lastPasswordCandidate = undefined;
      this.partialPasswordCandidate = undefined;
    }
  }

  dispose(): void {
    this.lastPasswordCandidate = undefined;
    this.partialPasswordCandidate = undefined;
    this.privateKeys.clear();
    this.certificateKeys.clear();
    this.agentIdentityPrints = undefined;
  }

  private build(): AuthAttempt[] {
    const { resolved, user, hopLabel } = this.hop;
    const label = hopLabel ?? this.hop.spec.host;
    const attempts: AuthAttempt[] = [{ type: 'none', get: () => Promise.resolve({ type: 'none', username: user }) }];
    const agentSocket = resolveAgentSocket(resolved.identityAgent);

    if (!resolved.passwordOnly) {
      if (agentSocket && this.agent && !resolved.identitiesOnly) {
        attempts.push({
          type: 'agent',
          get: () =>
            Promise.resolve({
              type: 'agent',
              username: user,
              agent: this.agent!,
            }),
        });
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
                agentSocket,
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
            const key = await this.loadPrivateKey(
              file,
              explicit,
              agentSocket,
              label,
            );
            return key ? { type: 'publickey', username: user, key } : undefined;
          },
        });
      }
    }

    if (resolved.kbdInteractiveAuthentication !== false) {
      for (let attempt = 0; attempt < MAX_KEYBOARD_INTERACTIVE_ATTEMPTS; attempt++) {
        attempts.push({
          type: 'keyboard-interactive',
          get: () => {
            // Arbitrary challenges get one attempt; only a recognized password
            // flow may retry for stale-password replacement.
            if (attempt > 0 && !this.retryKeyboardInteractive) {
              return Promise.resolve(undefined);
            }
            this.retryKeyboardInteractive = false;
            let challengeRound = 0;
            return Promise.resolve({
              type: 'keyboard-interactive',
              username: user,
              prompt: (name, instructions, _lang, prompts, finish) => {
                challengeRound += 1;
                void this.keyboardInteractiveAnswers(
                  name,
                  instructions,
                  label,
                  prompts,
                  challengeRound === 1,
                )
                  .then(finish)
                  .catch(() => {
                    this.cancelled = true;
                    finish(prompts.map(() => ''));
                  });
              },
            });
          },
        });
      }
    }

    if (resolved.passwordAuthentication !== false) {
      for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
        attempts.push({
          type: 'password',
          get: () => this.passwordMethod(attempt, label),
        });
      }
    }
    return attempts;
  }

  private async passwordMethod(
    attempt: number,
    promptLabel: string,
  ): Promise<AnyAuthMethod> {
    const { user } = this.hop;
    const credential = this.passwordCredential();
    const saved = await this.availableSavedPassword(credential);
    if (saved !== undefined) {
      return { type: 'password', username: user, password: saved };
    }

    const response = await this.runInteraction(() =>
      this.io.prompt({
        host: promptLabel,
        purpose: 'ssh-password',
        instructions:
          this.savedPasswordAttempted
            ? 'The saved password was unavailable or was not accepted. Enter the current password.'
            : undefined,
        prompts: [
          {
            prompt:
              attempt === 1
                ? `${user}@${promptLabel}'s password`
                : 'Permission denied, please try again. Password',
            echo: false,
          },
        ],
        ...(this.vault
          ? {
              rememberPassword: {
                label: credential.label,
                existing: credential.existing,
              },
            }
          : {}),
      }),
    );
    if (response.skipped) throw new Error('authentication cancelled');
    this.capturePasswordCandidate(response, credential);
    return {
      type: 'password',
      username: user,
      password: response.answers[0] ?? '',
    };
  }

  private async keyboardInteractiveAnswers(
    name: string,
    instructions: string,
    promptLabel: string,
    prompts: Prompt[],
    firstChallengeRound: boolean,
  ): Promise<string[]> {
    const mappedPrompts = prompts.map((prompt) => ({
      prompt: prompt.prompt,
      echo: prompt.echo !== false,
    }));
    if (
      !firstChallengeRound ||
      !isKeyboardInteractivePasswordPrompt(prompts)
    ) {
      // A later round makes the exchange multi-field, so a password offered
      // for saving in an earlier round is no longer a safe candidate.
      this.lastPasswordCandidate = undefined;
      this.retryKeyboardInteractive = false;
      const response = await this.runInteraction(() =>
        this.io.prompt({
          name: name || undefined,
          instructions: instructions || undefined,
          host: promptLabel,
          purpose: 'authentication',
          prompts: mappedPrompts,
        }),
      );
      return response.answers;
    }

    this.retryKeyboardInteractive = true;
    const credential = this.passwordCredential();
    const saved = await this.availableSavedPassword(credential);
    if (saved !== undefined) return [saved];

    const retryInstructions = this.savedPasswordAttempted
      ? 'The saved password was unavailable or was not accepted. Enter the current password.'
      : undefined;
    const response = await this.runInteraction(() =>
      this.io.prompt({
        name: name || undefined,
        instructions:
          [retryInstructions, instructions || undefined]
            .filter((item): item is string => !!item)
            .join('\n\n') || undefined,
        host: promptLabel,
        purpose: 'ssh-password',
        prompts: mappedPrompts,
        ...(this.vault
          ? {
              rememberPassword: {
                label: credential.label,
                existing: credential.existing,
              },
            }
          : {}),
      }),
    );
    this.capturePasswordCandidate(response, credential);
    return response.answers;
  }

  private passwordCredential(): PasswordCredential {
    const { user, resolved, port } = this.hop;
    const input = { user, host: resolved.hostname, port };
    const account = sshPasswordAccount(input);
    return {
      account,
      label: sshPasswordLabel(input),
      existing: this.vault?.hasSshPassword(account) ?? false,
    };
  }

  private async availableSavedPassword(
    credential: PasswordCredential,
  ): Promise<string | undefined> {
    if (this.savedPasswordAttempted || !this.vault) return undefined;
    // The host's own saved password wins; folder passwords are the shared
    // default the host falls back to, nearest folder first.
    const source = credential.existing
      ? { account: credential.account, label: credential.label }
      : (this.hop.folderPasswords ?? []).find((folder) =>
          this.vault!.hasSshPassword(folder.account),
        );
    if (!source) return undefined;

    this.savedPasswordAttempted = true;
    const saved = await this.savedPassword(source.account, source.label);
    if (saved !== undefined) {
      this.io.status(`Using the saved password for ${source.label}.`, {
        transient: true,
      });
    }
    return saved;
  }

  private capturePasswordCandidate(
    response: AuthPromptResponse,
    credential: PasswordCredential,
  ): void {
    this.lastPasswordCandidate = response.rememberPassword
      ? {
          account: credential.account,
          label: credential.label,
          password: response.answers[0] ?? '',
        }
      : undefined;
  }

  private async savedPassword(
    account: string,
    label: string,
  ): Promise<string | undefined> {
    if (!this.vault) return undefined;
    try {
      if (!this.vault.status().locked) {
        return await this.vault.sshPassword(account);
      }
      const result = await this.promptForVaultOperation(
        'Unlock password vault',
        `Enter the master password to use the saved password for ${label}.`,
        'Use another password',
        (masterPassword) =>
          this.vault!.sshPassword(account, masterPassword),
      );
      return result.ok ? result.value : undefined;
    } catch (err) {
      if (err instanceof CredentialVaultCorruptError) {
        this.io.status(
          `The saved password for ${label} is damaged. Enter it again to replace the saved copy.`,
        );
        return undefined;
      }
      if (err instanceof VaultKeyStoreUnavailableError) {
        this.io.status(
          `The OS credential store is unavailable. Enter the current password for ${label}.`,
        );
        return undefined;
      }
      throw err;
    }
  }

  private async createVaultForSave(label: string): Promise<boolean> {
    if (!this.vault) return false;

    const response = await this.runInteraction(() =>
      this.io.prompt({
        name: 'Create password vault',
        purpose: 'vault-create',
        instructions:
          `Create a master password to protect viewing and editing saved SSH passwords. ` +
          `By default, Muxus stores the vault key in the operating-system credential store ` +
          `so saved passwords can be used without another master-password prompt.`,
        prompts: [
          { prompt: 'Master password', echo: false },
          { prompt: 'Confirm master password', echo: false },
        ],
        skipLabel: 'Not now',
      }),
    );
    if (response.skipped) return false;
    const [masterPassword = '', confirmation = ''] = response.answers;
    if (masterPassword !== confirmation) {
      throw new InvalidMasterPasswordFormatError(
        'The master-password confirmation did not match.',
      );
    }
    try {
      await this.vault.create(
        masterPassword,
        DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
      );
    } catch (err) {
      if (!(err instanceof VaultAlreadyConfiguredError)) throw err;
      this.io.status(
        `The vault was created in another session; unlock it to remember the password for ${label}.`,
      );
    }
    return true;
  }

  private async promptForVaultOperation<T>(
    name: string,
    instructions: string,
    skipLabel: string,
    operation: (masterPassword: string) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (!this.vault) return { ok: false };
    return this.runInteraction(async () => {
      let error: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await this.io.prompt({
          name,
          purpose: 'vault-unlock',
          instructions: error ? `${error}\n\n${instructions}` : instructions,
          prompts: [{ prompt: 'Master password', echo: false }],
          skipLabel,
        });
        if (response.skipped) return { ok: false };
        try {
          const value = await operation(response.answers[0] ?? '');
          return { ok: true, value };
        } catch (err) {
          if (
            err instanceof InvalidMasterPasswordError ||
            err instanceof InvalidMasterPasswordFormatError
          ) {
            error = err.message;
            continue;
          }
          throw err;
        }
      }
      this.io.status('The password vault remains locked.');
      return { ok: false };
    });
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
    agent: string | undefined,
    label: string,
  ): Promise<ParsedKey | undefined> {
    const cached = this.certificateKeys.get(certificate);
    if (cached) return cached;
    const pending = (async () => {
      for (const file of identityFiles) {
        const key = await this.loadPrivateKey(
          file,
          explicit,
          agent,
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
    agent: string | undefined,
    label: string,
  ): Promise<ParsedKey | undefined> {
    const cached = this.privateKeys.get(file);
    if (cached) return cached;
    const pending = this.readPrivateKey(file, explicit, agent, label);
    this.privateKeys.set(file, pending);
    return pending;
  }

  private async readPrivateKey(
    file: string,
    explicit: boolean,
    agent: string | undefined,
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
      // Encrypted. A default (unconfigured) key the agent already holds was
      // covered by the agent attempt — skip it silently. Anything else
      // prompts for its passphrase, like ssh(1).
      if (
        !explicit &&
        agent &&
        this.agent &&
        (await this.agentHoldsKey(file, agent, this.agent))
      ) {
        return undefined;
      }
      for (let i = 0; i < MAX_PASSPHRASE_ATTEMPTS && parsed instanceof Error; i++) {
        const response = await this.runInteraction(() =>
          this.io.prompt({
            host: label,
            purpose: 'authentication',
            prompts: [{ prompt: `${i > 0 ? 'Bad passphrase, try again. ' : ''}Passphrase for ${path.basename(file)}`, echo: false }],
          }),
        );
        const [passphrase] = response.answers;
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

  /** True when the key's .pub sibling names an identity the agent holds. */
  private async agentHoldsKey(
    file: string,
    agentSocket: string,
    agent: BaseAgent<ParsedKey>,
  ): Promise<boolean> {
    let fingerprint: string;
    try {
      const blob = fs.readFileSync(`${file}.pub`, 'utf8').trim().split(/\s+/)[1];
      if (!blob) return false;
      fingerprint = fingerprintSha256(Buffer.from(blob, 'base64'));
    } catch {
      return false; // no readable .pub — prompt rather than guess
    }
    this.agentIdentityPrints ??= listAgentKeys(agentSocket, agent).then(
      (keys) => new Set(keys.map((k) => k.fingerprint)),
    );
    return (await this.agentIdentityPrints).has(fingerprint);
  }
}

function defaultIdentityFiles(): string[] {
  const dir = path.join(os.homedir(), '.ssh');
  return DEFAULT_IDENTITY_NAMES.map((name) => path.join(dir, name)).filter((p) => fs.existsSync(p));
}

/** RemoteCommand session: exec instead of a shell, tty per RequestTTY. */
function openSessionExec(
  client: Client,
  command: string,
  pty: PseudoTtyOptions | undefined,
  env?: Record<string, string>,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, { ...(pty ? { pty } : {}), ...(env ? { env } : {}) }, (err, stream) =>
      err ? reject(err) : resolve(stream),
    );
  });
}

/** Translate the common ssh2 failure modes into user-actionable messages. */
function friendlyConnectError(err: Error, hop: ChainHop): Error {
  const msg = err.message;
  const where = `${hop.resolved.hostname}:${hop.port}`;
  if (/ECONNREFUSED/.test(msg)) return new Error(`connection refused by ${where} — is sshd running?`);
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return new Error(`could not resolve host ${hop.resolved.hostname}`);
  if (/ETIMEDOUT|Timed out/i.test(msg)) return new Error(`connection to ${where} timed out`);
  if (/All configured authentication methods failed/.test(msg)) return new Error(`authentication to ${where} failed`);
  if (/Handshake failed: no matching/i.test(msg)) {
    return new Error(
      `${msg} — if ${where} only speaks legacy algorithms, add KexAlgorithms/Ciphers/HostKeyAlgorithms lines to this host's ssh config (Advanced options in the host editor)`,
    );
  }
  return err;
}
