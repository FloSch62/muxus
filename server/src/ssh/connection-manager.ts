import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
  environmentCommandLine,
  type AuthPromptInfo,
  type AuthPromptResponse,
  type ConfigForward,
  type ConnectionInfo,
  type ExternalPasswordRef,
  type SshProfile,
  type SshSessionSummary,
  type TerminalBackspaceKey,
  listedHostFor,
  savedHostHopId,
} from '@muxus/shared';
import {
  certificateAlgorithms,
  certificateMatchesKey,
  certificateRsaHash,
  isEncryptedKeyError,
  parseOpenSshCertificate,
  parseSshKey,
  type OpenSshCertificate,
} from './certificates.js';
import {
  isSshError,
  SshError,
  SshTransport,
  type AuthOutcome,
  type KeyboardPrompt,
  type PtyRequest,
  type SessionOptions,
  type SftpClient,
  type SshChannel,
  type SshPrivateKey,
  type SshTunnel,
  type TransportHealth,
} from './engine.js';
import type { SshAgent, SshIdentity } from './identity.js';
import {
  KnownHostsStore,
  fingerprintLike,
  fingerprintSha256,
  hostKeyMatchesFingerprint,
  hostKeyType,
} from './known-hosts.js';
import type { PasswordManagers } from '../password-managers/password-managers.js';
import { listAgentKeys, resolveAgentSocket } from './key-scan.js';
import {
  DEFAULT_AGENT_OPERATION_TIMEOUT_MS,
  DEFAULT_AGENT_WAIT_STATUS_MS,
  ResponsiveAgent,
  type ResponsiveAgentOptions,
} from './responsive-agent.js';
import {
  describeSecurityKeyError,
  plainKeyBlob,
  securityKeyCertificate,
  SecurityKeyError,
  securityKeyFile,
  securityKeyLabel,
  securityKeyProvider,
  type SecurityKeyQuestion,
} from './security-keys.js';
import { SecurityKeyFileAgent } from './security-key-agent.js';
import {
  ConnectionLeaseRegistry,
  type ConnectionLeaseOwner,
  type TransportLease,
} from './connection-leases.js';
import { connectionAlgorithms, hostKeyAlgorithmsPreferring } from './algorithms.js';
import { JumpHopRegistry, type JumpHop } from './jump-hops.js';
import {
  openRemoteShell,
  RemoteShellTransportLostError,
  type ShellProbeMemo,
} from './remote-shell-integration.js';
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
  isConcreteAlias,
  listedHosts,
  loadConfigDocument,
  parseHostSpec,
  resolveHost,
  sessionEnvironment,
  sortHostList,
  type ConfigDocument,
  type ResolvedTarget,
} from './ssh-config.js';
import type { FolderAuthLookup, FolderPasswordRef } from './folder-auth.js';
import type { LocalX11, X11Transport } from '../x11/local-x11.js';

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
  /** ForwardX11; undefined follows the local X server's default. */
  forwardX11?: boolean;
}

export function sessionSettings(resolved: ResolvedTarget): SessionSettings {
  return {
    env: sessionEnvironment(resolved),
    remoteCommand: resolved.remoteCommand,
    requestTty: resolved.requestTty,
    forwardX11: resolved.forwardX11,
  };
}

/**
 * A session into a container, pod or console runs that command on the host
 * instead of the login shell (or a configured RemoteCommand), always with a
 * terminal, the way `ssh -t host docker exec -it …` would.
 */
export function environmentSession(settings: SessionSettings, profile: SshProfile): SessionSettings {
  if (!profile.environment) return settings;
  return { ...settings, remoteCommand: environmentCommandLine(profile.environment), requestTty: 'force' };
}

/** RequestTTY the way ssh(1) treats it: auto ⇒ a tty only for plain shells. */
function wantsPty(requestTty: ResolvedTarget['requestTty'], hasCommand: boolean): boolean {
  if (requestTty === 'no') return false;
  if (requestTty === 'yes' || requestTty === 'force') return true;
  return !hasCommand;
}

/** A login method as the session summary names it. */
type AuthMethodName = 'none' | 'agent' | 'publickey' | 'keyboard-interactive' | 'password';

/** What one dialed hop learned while connecting, kept for the session summary. */
interface HandshakeFacts {
  /** Server software from its identification string. */
  serverSoftware?: string;
  kex?: string;
  cipher?: string;
  /** Client-to-server compression as negotiated. */
  compression?: string;
  /** Methods the server accepted, in order. */
  authMethods: AuthMethodName[];
  /** Signature algorithm of the key that logged in, when known. */
  authKeyAlgorithm?: string;
  /** The config asked for compression (`Compression yes`). */
  compressionRequested: boolean;
  agentForwarding: SshSessionSummary['agentForwarding'];
}

/** How a transport was reached and what it negotiated. */
export interface TransportFacts extends HandshakeFacts {
  /** Jump hosts in dialing order; empty for a direct connection. */
  jumpHosts: string[];
  /** The first hop was reached through a ProxyCommand. */
  proxyCommand: boolean;
}

export interface ManagedConnection {
  id: string;
  /** The SSH connection itself: commands, tunnels and forwards open on it. */
  transport: SshTransport;
  profile: SshProfile;
  host: string;
  port: number;
  user: string;
  /** Dial-plan identity for connection sharing; see {@link muxKey}. */
  muxKey: string;
  /** Concrete OpenSSH alias eligible for Muxus-owned recent-use metadata. */
  metadataAlias?: string;
  /** Whether callers may open SFTP channels on this transport. */
  sftpAvailable: boolean;
  /**
   * Whether the server has run a shell command for Muxus on this transport.
   * Only then may optional extras open exec channels: some network devices
   * drop the whole connection when a second channel asks for one.
   */
  ranCommand(): boolean;
  /**
   * Whether the server is known not to run commands for Muxus: a shell here
   * asked and got no answer, or the host is set to console compatibility.
   * Such a host is left alone even when the user asks for it by name.
   */
  commandsDeclined(): boolean;
  /** *Forward lines resolved from ssh config — auto-started once the session is up. */
  configForwards: ConfigForward[];
  /** Force-reconnect group that dialed this transport, so sibling requests
   *  from the same gesture share the one replacement connection. */
  replacementToken?: string;
  /** Replaced by a forced fresh transport: never handed out for sharing again;
   *  existing leases (tunnels, transfers) keep it alive until they release. */
  superseded?: boolean;
  /** Current passive keepalive health of the transport. */
  health(): SshTransportHealth;
  /** Whether the server answered an x11-req on this transport with failure. */
  x11Refused(): boolean;
  /** Whether the server accepted X11 forwarding on this session channel. */
  x11Forwarded(channel: SshChannel): boolean;
  facts: TransportFacts;
  /**
   * Session defaults come from the dialed target when none are passed. `cwd`
   * is a best-effort start directory, honoured only by integrated shells;
   * `backspaceKey` sets the erase character the pty request advertises.
   */
  shell(
    cols: number,
    rows: number,
    term: string,
    session?: SessionSettings,
    cwd?: string,
    backspaceKey?: TerminalBackspaceKey,
  ): Promise<SshChannel>;
  sftp(): Promise<SftpClient>;
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
export type SshTransportHealth = TransportHealth;

/**
 * Translate OpenSSH keepalive settings without inventing a probe interval.
 * OpenSSH's ServerAliveInterval default is zero (disabled), while
 * ServerAliveCountMax defaults to three when an interval is explicitly set.
 * The interval is in milliseconds.
 */
export function sshKeepaliveOptions(
  resolved: Pick<ResolvedTarget, 'serverAliveInterval' | 'serverAliveCountMax'>,
): { keepaliveInterval: number; keepaliveCountMax: number } {
  return {
    keepaliveInterval: (resolved.serverAliveInterval ?? 0) * 1000,
    keepaliveCountMax: resolved.serverAliveCountMax ?? 3,
  };
}

export interface MuxedConnectionLease extends TransportLease<ManagedConnection> {
  /** True when this lease multiplexes onto a pre-existing transport instead of a fresh dial. */
  reused: boolean;
  /** This connect call's resolved final hop (not the dialing call's) — the
   *  source for per-alias session settings on a shared transport. */
  target: ChainHop;
}

export interface TerminalShell {
  lease: MuxedConnectionLease;
  stream: SshChannel;
  /**
   * 'new' — fresh transport, this session owns starting its config forwards;
   * 'shared' — multiplexed onto a live transport that already has them;
   * 'overflow' — dedicated transport dialed because the shared one refused
   * another session; its sibling still owns the config forwards.
   */
  transport: 'new' | 'shared' | 'overflow';
  /** Port forwards are started after the shell opens, so they are left to the caller. */
  summary: Omit<SshSessionSummary, 'forwards'>;
}

const MAX_JUMP_DEPTH = 8;
const MAX_KEYBOARD_INTERACTIVE_ATTEMPTS = 3;
const MAX_PASSWORD_ATTEMPTS = 3;
const MAX_PASSPHRASE_ATTEMPTS = 3;
const DEFAULT_IDENTITY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_ed25519_sk', 'id_ecdsa_sk'];

/**
 * xterm sends DEL for Backspace, or ^H when the host asks for it. Advertising
 * the same erase character while requesting the remote PTY prevents it from
 * being echoed as visible input (and advancing the cursor) on hosts with a
 * different login default.
 */
export function terminalPtyOptions(
  cols: number,
  rows: number,
  term: string,
  backspaceKey: TerminalBackspaceKey = 'del',
): PtyRequest {
  return { term, cols, rows, erase: backspaceKey === 'ctrl-h' ? 0x08 : 0x7f };
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
  /** A host saved in Muxus app data: its settings live in the host editor, not in ssh_config. */
  savedHost?: boolean;
  /** The password-manager entry this host itself logs in with. */
  passwordRef?: ExternalPasswordRef;
  /** Folder passwords this hop may fall back to, nearest first. */
  folderPasswords?: readonly FolderPasswordRef[];
  /** Target only: the host key an ssh:// link pinned, in canonical form. */
  hostKeyFingerprint?: string;
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
  private readonly jumpHops: JumpHopRegistry;
  private readonly closeReasons = new WeakMap<SshTransport, string>();
  private readonly postAuth = new WeakMap<SshTransport, Promise<void>>();
  private readonly handshakes = new WeakMap<SshTransport, HandshakeFacts>();
  /**
   * In-flight dials by mux key, so simultaneous sessions share one TCP
   * connection and one auth round-trip. A list, not a single slot: overlapping
   * force-reconnect gestures each keep their own dial joinable until it
   * settles, so a straggler always finds the dial of its own gesture.
   */
  private readonly pendingDials = new Map<
    string,
    Array<{ promise: Promise<ManagedConnection>; freshToken?: string }>
  >();
  /** Dial plans whose optional integration setup killed the remote transport; reset on app restart. */
  private readonly automaticPlainShellKeys = new Set<string>();
  private readonly loadConfig: () => ConfigDocument;
  private readonly vault: PasswordVault | undefined;
  private readonly savedSshProfile: ((id: string) => SshProfile | undefined) | undefined;
  private readonly passwordManagers: PasswordManagers | undefined;
  private readonly passwordRefs: PasswordRefLookups | undefined;
  private readonly folderAuth: FolderAuthLookup | undefined;
  private readonly profileFolderAuth: FolderAuthLookup | undefined;
  private readonly disableSftpForHost: ((alias: string) => boolean) | undefined;
  private readonly consoleCompatibilityForHost: ((alias: string) => boolean) | undefined;
  private readonly disableSftpForProfile: ((id: string) => boolean) | undefined;
  private readonly consoleCompatibilityForProfile: ((id: string) => boolean) | undefined;
  private readonly systemOpenSshForHost: ((alias: string) => boolean) | undefined;
  private readonly systemOpenSshForProfile: ((id: string) => boolean) | undefined;
  private readonly jumpFallbacksForHost: ((alias: string) => string[][]) | undefined;
  /** Per host, which of its jump routes (0 = the primary) connected last. */
  private readonly lastWorkingRoute = new Map<string, number>();
  private readonly agentOperationTimeoutMs: number;
  private readonly agentWaitStatusMs: number;
  private readonly x11: LocalX11 | undefined;
  readonly knownHosts: KnownHostsStore;

  constructor(
    private readonly log: FastifyBaseLogger,
    options: {
      knownHosts?: KnownHostsStore;
      loadConfig?: () => ConfigDocument;
      vault?: PasswordVault;
      /** External password managers that linked entries are read from. */
      passwordManagers?: PasswordManagers;
      /** The password-manager entry linked to an alias or a saved host. */
      passwordRefs?: PasswordRefLookups;
      /** Current database-owned SSH profile, keyed by stable profile ID. */
      savedSshProfile?: (id: string) => SshProfile | undefined;
      /** Folder-inherited connection defaults per alias (Muxus sidebar folders). */
      folderAuth?: FolderAuthLookup;
      /** Folder defaults for Muxus-owned profiles, keyed by stable profile ID. */
      profileFolderAuth?: FolderAuthLookup;
      /** Muxus-owned per-host compatibility setting; never written to ssh_config. */
      disableSftpForHost?: (alias: string) => boolean;
      /** Muxus-owned console compatibility setting; never written to ssh_config. */
      consoleCompatibilityForHost?: (alias: string) => boolean;
      /** Muxus-owned compatibility setting for a database-backed SSH host. */
      disableSftpForProfile?: (id: string) => boolean;
      /** Muxus-owned console setting for a database-backed SSH host. */
      consoleCompatibilityForProfile?: (id: string) => boolean;
      systemOpenSshForHost?: (alias: string) => boolean;
      systemOpenSshForProfile?: (id: string) => boolean;
      /** Muxus-owned fallback jump routes for an ssh_config alias. */
      jumpFallbacksForHost?: (alias: string) => string[][];
      /** Test seam; production uses the exported responsive-agent defaults. */
      agentOperationTimeoutMs?: number;
      /** Test seam; production uses the exported responsive-agent defaults. */
      agentWaitStatusMs?: number;
      /** Local X server for X11 forwarding; absent disables it. */
      x11?: LocalX11;
      /** Test seam; production uses JUMP_HOP_IDLE_MS. */
      jumpHopIdleMs?: number;
    } = {},
  ) {
    this.knownHosts = options.knownHosts ?? new KnownHostsStore();
    this.loadConfig = options.loadConfig ?? (() => loadConfigDocument());
    this.vault = options.vault;
    this.passwordManagers = options.passwordManagers;
    this.passwordRefs = options.passwordRefs;
    this.savedSshProfile = options.savedSshProfile;
    this.folderAuth = options.folderAuth;
    this.profileFolderAuth = options.profileFolderAuth;
    this.disableSftpForHost = options.disableSftpForHost;
    this.consoleCompatibilityForHost = options.consoleCompatibilityForHost;
    this.disableSftpForProfile = options.disableSftpForProfile;
    this.consoleCompatibilityForProfile = options.consoleCompatibilityForProfile;
    this.systemOpenSshForHost = options.systemOpenSshForHost;
    this.systemOpenSshForProfile = options.systemOpenSshForProfile;
    this.jumpFallbacksForHost = options.jumpFallbacksForHost;
    this.agentOperationTimeoutMs =
      options.agentOperationTimeoutMs ?? DEFAULT_AGENT_OPERATION_TIMEOUT_MS;
    this.agentWaitStatusMs =
      options.agentWaitStatusMs ?? DEFAULT_AGENT_WAIT_STATUS_MS;
    this.x11 = options.x11;
    this.jumpHops = new JumpHopRegistry(options.jumpHopIdleMs);
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
    // A superseded transport still carries its existing tunnels, but new
    // consumers must land on the replacement, not the corpse-to-be.
    return this.connections
      .list()
      .filter((conn) => !conn.superseded)
      .map((conn) => ({
      id: conn.id,
      target: conn.profile.target,
      host: conn.host,
      port: conn.port,
      user: conn.user,
      metadataAlias: conn.metadataAlias,
      ...(conn.profile.profileId ? { profileId: conn.profile.profileId } : {}),
      ...(conn.profile.useConfig === false ? { useConfig: false } : {}),
      sftpAvailable: conn.sftpAvailable,
    }));
  }

  /**
   * Connect with OpenSSH-ControlMaster-style multiplexing: a session whose
   * dial plan matches a live, healthy transport attaches to it as a new
   * lease instead of opening another TCP connection — split panes, SFTP,
   * tunnels and repeated connects to one host share a single SSH connection,
   * which also keeps Muxus inside server-side connection caps (MaxStartups,
   * per-user limits). Concurrent dials to the same plan (workspace restore)
   * collapse into one connection and one auth round-trip. A transport that
   * still has to be dialed rides any jump hop already connected for its route.
   */
  async connect(
    profile: SshProfile,
    io: ConnectIo,
    owner: ConnectionLeaseOwner = 'terminal',
    opts: {
      /** Force-reconnect group token: skip transports established before this
       *  request; requests sharing a token share one replacement connection. */
      freshTransport?: string;
      /** Internal fallbacks (MaxSessions overflow, plain-console retry): dial
       *  an own transport without joining or retiring anyone else's. */
      dedicatedTransport?: boolean;
      forcePlainShell?: boolean;
    } = {},
  ): Promise<MuxedConnectionLease> {
    profile = this.resolveProfile(profile);
    if (this.usesSystemOpenSsh(profile)) {
      // Tunnels and the like need the built-in client, which this host was set up not to use.
      throw new Error(
        'This host uses system OpenSSH, so Muxus cannot open a connection of its own to it. Use a terminal to the host, or turn the option off in the host settings.',
      );
    }
    const doc = this.loadConfig();
    const fallbacks = this.jumpFallbacksFor(doc, profile);
    if (fallbacks.length === 0) return this.connectRoute(doc, profile, io, owner, opts);

    // Alternative jump routes: each is the same host with another ProxyJump
    // chain. The route that worked last for this host goes first, so a retry
    // (a reconnect, an overflow transport) does not wait on a dead primary.
    const routeKey = lastRouteKey(profile);
    const all: SshProfile[] = [
      profile,
      ...fallbacks.map((proxyJump) => ({ ...profile, proxyJump, proxyCommand: undefined })),
    ];
    const remembered = this.lastWorkingRoute.get(routeKey);
    const routes =
      remembered && remembered > 0 && remembered < all.length
        ? [all[remembered]!, ...all.filter((_, i) => i !== remembered)]
        : all;
    // A route that cannot even be planned (a saved jump host that was
    // deleted, a loop) is skipped like one that cannot be reached.
    const plans = routes.map((route) => {
      try {
        return this.routePlan(doc, route, opts);
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    });
    if (!opts.dedicatedTransport && !opts.freshTransport) {
      // A live transport over any route serves the request first.
      for (const plan of plans) {
        if (plan instanceof Error) continue;
        const shared = this.tryShare(plan, owner);
        if (shared) {
          io.status(`Reusing the SSH connection to ${shared.connection.host} (multiplexed).`, {
            transient: true,
          });
          return shared;
        }
      }
    }
    for (let i = 0; ; i++) {
      const route = routes[i]!;
      const plan = plans[i]!;
      const next = routes[i + 1];
      let failedRoute: string | undefined;
      let failure: unknown;
      if (plan instanceof Error) {
        failedRoute = this.routeLabel(doc, route);
        failure = plan;
      } else {
        try {
          const lease = await this.connectRoute(doc, route, io, owner, opts, plan);
          this.lastWorkingRoute.set(routeKey, all.indexOf(route));
          if (opts.freshTransport && !opts.dedicatedTransport) {
            // A forced reconnect replaces the transports of every route to
            // this host, not just the one it landed on.
            for (const other of plans) {
              if (!(other instanceof Error) && other.key !== plan.key) {
                this.retireReplacedTransports(other.key, lease.connection.id);
              }
            }
          }
          return lease;
        } catch (err) {
          failedRoute = err instanceof Error ? routeFailures.get(err) : undefined;
          failure = err;
        }
      }
      if (failedRoute === undefined || !next) throw failure;
      const nextRoute = this.routeLabel(doc, next);
      const reason = failure instanceof Error ? failure.message : String(failure);
      this.log.info(
        { target: profile.target, failedRoute, nextRoute, err: reason },
        'ssh jump route failed; trying the next one',
      );
      io.status(
        `${failedRoute ? `Route via ${failedRoute}` : 'Direct connection'} failed (${reason}) — trying via ${nextRoute} …`,
      );
    }
  }

  /**
   * Fallback jump routes for a host: a saved Muxus host keeps them in its
   * profile, an ssh_config alias in its Muxus metadata.
   */
  private jumpFallbacksFor(doc: ConfigDocument, profile: SshProfile): string[][] {
    if (profile.proxyJumpFallbacks) return profile.proxyJumpFallbacks;
    if (profile.useConfig === false || !this.jumpFallbacksForHost) return [];
    // A caller that chose its own route (a NETCONF gateway, an explicit
    // ProxyJump) gets that route, not the alias's saved alternatives.
    if (profile.proxyJump?.length || profile.proxyCommand) return [];
    const alias = findMetadataAlias(doc, parseHostSpec(profile.target).host);
    return alias ? this.jumpFallbacksForHost(alias) : [];
  }

  /** "bastion-a → bastion-b" for the jump hosts a route dials, '' when direct. */
  private routeLabel(doc: ConfigDocument, profile: SshProfile): string {
    try {
      return buildChain(doc, profile, this.folderAuth, this.profileFolderAuth, this.savedSshProfile, this.passwordRefs)
        .slice(0, -1)
        .map((hop) => hop.spec.host)
        .join(' → ');
    } catch {
      return (profile.proxyJump ?? []).join(' → ');
    }
  }

  /**
   * A live transport already dialed for this plan, leased to `owner`, with
   * the plan's config forwards merged in. A force-reconnect passes its token
   * so it only ever joins its own replacement.
   */
  private tryShare(
    plan: RoutePlan,
    owner: ConnectionLeaseOwner,
    freshToken?: string,
  ): MuxedConnectionLease | undefined {
    const shared = this.acquireShared(plan.key, owner, plan.target, freshToken);
    if (shared) {
      shared.connection.configForwards = mergeConfigForwards(
        shared.connection.configForwards,
        plan.target.resolved.forwards,
      );
    }
    return shared;
  }

  /** The dial plan and multiplexing key `connectRoute` uses for one route. */
  private routePlan(
    doc: ConfigDocument,
    profile: SshProfile,
    opts: { forcePlainShell?: boolean },
  ): RoutePlan {
    const chain = buildChain(
      doc,
      profile,
      this.folderAuth,
      this.profileFolderAuth,
      this.savedSshProfile,
      this.passwordRefs,
    );
    const target = chain[chain.length - 1]!;
    const metadataAlias =
      profile.useConfig === false ? undefined : findMetadataAlias(doc, target.spec.host);
    const regularKey = muxKey(chain);
    const consoleCompatibility =
      (metadataAlias ? (this.consoleCompatibilityForHost?.(metadataAlias) ?? false) : false) ||
      (profile.profileId
        ? (this.consoleCompatibilityForProfile?.(profile.profileId) ?? false)
        : false) ||
      this.automaticPlainShellKeys.has(regularKey) ||
      opts.forcePlainShell === true;
    const disableSftp =
      consoleCompatibility ||
      (metadataAlias ? (this.disableSftpForHost?.(metadataAlias) ?? false) : false) ||
      (profile.profileId
        ? (this.disableSftpForProfile?.(profile.profileId) ?? false)
        : false);
    const key = muxKey(chain, disableSftp, consoleCompatibility);
    return { chain, target, metadataAlias, consoleCompatibility, disableSftp, key };
  }

  /** {@link connect} over one jump route. */
  private async connectRoute(
    doc: ConfigDocument,
    profile: SshProfile,
    io: ConnectIo,
    owner: ConnectionLeaseOwner,
    opts: {
      freshTransport?: string;
      dedicatedTransport?: boolean;
      forcePlainShell?: boolean;
    },
    plan: RoutePlan = this.routePlan(doc, profile, opts),
  ): Promise<MuxedConnectionLease> {
    const { chain, target, metadataAlias, consoleCompatibility, disableSftp, key } = plan;
    const configForwards = target.resolved.forwards;
    const label = `${target.user}@${target.resolved.hostname}:${target.port}`;
    this.log.debug(
      { target: profile.target, label, hops: chain.length, owner },
      'ssh connect requested',
    );

    const freshToken = opts.dedicatedTransport ? undefined : opts.freshTransport;
    if (!opts.dedicatedTransport) {
      // A force-reconnect request skips every pre-existing transport but may
      // still share the replacement its own gesture already established.
      const shared = this.tryShare(plan, owner, freshToken);
      if (shared) {
        this.log.debug({ label, connId: shared.connection.id }, 'reusing multiplexed ssh transport');
        io.status(`Reusing the SSH connection to ${label} (multiplexed).`, { transient: true });
        return shared;
      }
      const pendingList = this.pendingDials.get(key) ?? [];
      // A failed dial fails every session waiting on it — auth prompts and
      // errors surface on the session that started the dial. A fresh request
      // never waits on the dial it is trying to escape: it joins an in-flight
      // dial only when that dial belongs to its own force-reconnect group.
      // Regular requests join the newest dial.
      const pending = freshToken
        ? pendingList.find((entry) => entry.freshToken === freshToken)
        : pendingList.at(-1);
      if (pending) {
        io.status(`Waiting for the SSH connection to ${label} …`, { transient: true });
        const conn = await pending.promise;
        const lease = this.connections.acquire(conn.id, owner);
        if (lease) {
          conn.configForwards = mergeConfigForwards(conn.configForwards, configForwards);
          return { ...lease, reused: true, target };
        }
        // The transport died between ready and acquire; dial our own below.
      }
    }

    const dial = this.dialChain(
      chain,
      profile,
      io,
      owner,
      key,
      metadataAlias,
      disableSftp,
      consoleCompatibility,
      freshToken,
    ).then((lease) => {
      if (freshToken) {
        // Tag before waiters observe the connection, and retire the replaced
        // transports so no later session multiplexes onto them.
        lease.connection.replacementToken = freshToken;
        this.retireReplacedTransports(key, lease.connection.id);
      }
      return lease;
    });
    const tracked = dial.then((lease) => lease.connection);
    tracked.catch(() => undefined); // waiters observe the rejection through their own await
    if (!opts.dedicatedTransport) {
      const list = this.pendingDials.get(key);
      if (list) list.push({ promise: tracked, freshToken });
      else this.pendingDials.set(key, [{ promise: tracked, freshToken }]);
    }
    try {
      const lease = await dial;
      return { ...lease, reused: false, target };
    } finally {
      const list = this.pendingDials.get(key);
      if (list) {
        const index = list.findIndex((entry) => entry.promise === tracked);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) this.pendingDials.delete(key);
      }
    }
  }

  /**
   * A stable database ID is a reference, not permission for a client or a
   * stale workspace to replace the saved connection fields. Resolve it at the
   * server boundary so edits and deletions take effect on the next dial.
   */
  /** The hops `connect` dials for a profile, in dialing order, the target last. */
  dialPlan(profile: SshProfile): ChainHop[] {
    return buildChain(
      this.loadConfig(),
      this.resolveProfile(profile),
      this.folderAuth,
      this.profileFolderAuth,
      this.savedSshProfile,
      this.passwordRefs,
    );
  }

  /** The ssh_config alias whose Muxus metadata a session to this profile uses, as `connect` finds it. */
  metadataAliasFor(profile: SshProfile): string | undefined {
    if (profile.useConfig === false || profile.profileId) return undefined;
    return findMetadataAlias(this.loadConfig(), parseHostSpec(profile.target).host);
  }

  /** The ssh_config alias whose Muxus metadata the window applies to a tab dialing this profile. */
  listedMetadataAliasFor(profile: SshProfile): string | undefined {
    if (profile.useConfig === false || profile.profileId) return undefined;
    return listedMetadataAlias(this.loadConfig(), profile.target);
  }

  /** Whether a tab to this profile runs the computer's `ssh` program. */
  usesSystemOpenSsh(profile: SshProfile): boolean {
    if (profile.profileId) return this.systemOpenSshForProfile?.(profile.profileId) ?? false;
    if (!this.systemOpenSshForHost) return false;
    const alias = this.listedMetadataAliasFor(profile);
    return alias ? this.systemOpenSshForHost(alias) : false;
  }

  /** Whether a system OpenSSH host's settings leave SFTP on. Console compatibility shapes
   *  the built-in client's session, so the host editor greys it out for these hosts. */
  sftpAllowedFor(profile: SshProfile): boolean {
    if (profile.profileId) return !this.disableSftpForProfile?.(profile.profileId);
    const alias = this.listedMetadataAliasFor(profile);
    return !(alias && this.disableSftpForHost?.(alias));
  }

  resolveProfile(profile: SshProfile): SshProfile {
    if (!profile.profileId) return profile;
    const saved = this.savedSshProfile?.(profile.profileId);
    if (!saved || saved.profileId !== profile.profileId || saved.useConfig !== false) {
      throw new Error(`saved SSH profile "${profile.profileId}" was not found`);
    }
    // Connection fields come from the database. The keepalive fallback is an
    // application preference supplied by the current renderer, so the wire
    // value always wins — including its absence (preference set to
    // configuration-only), which must clear anything a client stored. So
    // does a link's host key fingerprint, which only tightens verification,
    // and the container or console a session enters, which is the session's
    // own choice rather than a connection setting.
    return {
      ...saved,
      keepaliveIntervalSeconds: profile.keepaliveIntervalSeconds,
      hostKeyFingerprint: profile.hostKeyFingerprint,
      environment: profile.environment,
    };
  }

  /**
   * Least-busy live, healthy transport with the same dial plan, if any.
   * A superseded transport is never handed out again; a force-reconnect
   * request reuses only the replacement its own gesture established.
   */
  private acquireShared(
    key: string,
    owner: ConnectionLeaseOwner,
    target: ChainHop,
    freshToken?: string,
  ): MuxedConnectionLease | undefined {
    const candidates = this.connections
      .list()
      .filter(
        (conn) =>
          conn.muxKey === key &&
          conn.health() === 'healthy' &&
          (freshToken ? conn.replacementToken === freshToken : !conn.superseded),
      )
      .sort((a, b) => this.connections.leaseCount(a.id) - this.connections.leaseCount(b.id));
    for (const conn of candidates) {
      const lease = this.connections.acquire(conn.id, owner);
      if (lease) return { ...lease, reused: true, target };
    }
    return undefined;
  }

  /**
   * A live replacement makes every older same-plan transport ineligible for
   * new consumers. Their existing leases (tunnels, transfers) stay valid, and
   * the transport still closes only after the last of them releases.
   */
  private retireReplacedTransports(key: string, replacementId: string): void {
    for (const conn of this.connections.list()) {
      if (conn.id === replacementId || conn.muxKey !== key || conn.superseded) continue;
      conn.superseded = true;
      this.log.info(
        { connId: conn.id, host: conn.host },
        'ssh transport superseded by a forced replacement',
      );
    }
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
    opts: { freshTransport?: string; cwd?: string; backspaceKey?: TerminalBackspaceKey } = {},
  ): Promise<TerminalShell> {
    const { cwd, backspaceKey, ...connectOpts } = opts;
    const lease = await this.connect(profile, io, 'terminal', connectOpts);
    const settings = (resolved: ResolvedTarget) => environmentSession(sessionSettings(resolved), profile);
    try {
      const stream = await lease.connection.shell(
        cols,
        rows,
        term,
        settings(lease.target.resolved),
        cwd,
        backspaceKey,
      );
      return this.opened(lease, stream, lease.reused ? 'shared' : 'new', io);
    } catch (err) {
      lease.release();
      if (err instanceof RemoteShellTransportLostError) {
        return this.retryPlainShell(profile, io, cols, rows, term, lease, 'new', err, backspaceKey);
      }
      if (!lease.reused) throw err;
      this.log.info(
        { host: lease.connection.host, err: String(err) },
        'shared ssh transport refused a session; dialing a dedicated connection',
      );
      io.status('The shared SSH connection refused another session — opening a dedicated one …', { transient: true });
      const dedicated = await this.connect(profile, io, 'terminal', { dedicatedTransport: true });
      try {
        const stream = await dedicated.connection.shell(
          cols,
          rows,
          term,
          settings(dedicated.target.resolved),
          cwd,
          backspaceKey,
        );
        return this.opened(dedicated, stream, 'overflow', io);
      } catch (retryErr) {
        dedicated.release();
        if (retryErr instanceof RemoteShellTransportLostError) {
          return this.retryPlainShell(
            profile,
            io,
            cols,
            rows,
            term,
            dedicated,
            'overflow',
            retryErr,
            backspaceKey,
          );
        }
        throw retryErr;
      }
    }
  }

  /** Report X11 trouble and describe what the new session ended up with. */
  private opened(
    lease: MuxedConnectionLease,
    stream: SshChannel,
    transport: TerminalShell['transport'],
    io: ConnectIo,
  ): TerminalShell {
    this.reportX11(lease, io);
    const conn = lease.connection;
    const { facts } = conn;
    const compression = facts.compression;
    return {
      lease,
      stream,
      transport,
      summary: {
        user: conn.user,
        host: conn.host,
        port: conn.port,
        jumpHosts: facts.jumpHosts,
        proxyCommand: facts.proxyCommand,
        shared: transport === 'shared',
        serverSoftware: facts.serverSoftware,
        authMethods: facts.authMethods,
        authKeyAlgorithm: facts.authKeyAlgorithm,
        cipher: facts.cipher,
        kex: facts.kex,
        compression:
          compression && compression !== 'none'
            ? 'on'
            : facts.compressionRequested
              ? 'unsupported'
              : 'off',
        sftp: conn.sftpAvailable,
        x11: this.x11State(lease, stream),
        agentForwarding: facts.agentForwarding,
      },
    };
  }

  /** Mirrors reportX11: a reason is given only when the session asked for X11. */
  private x11State(
    lease: MuxedConnectionLease,
    stream: SshChannel,
  ): SshSessionSummary['x11'] {
    if (lease.connection.x11Forwarded(stream)) return 'on';
    if (!this.x11?.enabled()) return 'off';
    const forwardX11 = lease.target.resolved.forwardX11;
    if (this.x11.status().source === 'none') return forwardX11 === true ? 'no-server' : 'off';
    return lease.connection.x11Refused() && this.x11.wanted(forwardX11) ? 'refused' : 'off';
  }

  /**
   * A host that explicitly sets ForwardX11 yes hears why it did not happen.
   * The default (on only with the bundled Windows X server) stays silent,
   * as MobaXterm does on servers without X11 forwarding.
   */
  private reportX11(lease: MuxedConnectionLease, io: ConnectIo): void {
    // With X11 switched off in Settings, hosts' ForwardX11 is ignored silently.
    if (!this.x11?.enabled() || lease.target.resolved.forwardX11 !== true) return;
    if (this.x11.status().source === 'none') {
      io.status(this.x11.missingServerMessage());
    } else if (lease.connection.x11Refused()) {
      io.status(
        'This server refused X11 forwarding. It needs "X11Forwarding yes" in sshd_config and xauth installed.',
      );
    }
  }

  private async retryPlainShell(
    profile: SshProfile,
    io: ConnectIo,
    cols: number,
    rows: number,
    term: string,
    failed: MuxedConnectionLease,
    transport: TerminalShell['transport'],
    error: RemoteShellTransportLostError,
    backspaceKey: TerminalBackspaceKey | undefined,
  ): Promise<TerminalShell> {
    // A probe-triggered disconnect can happen for config aliases and direct
    // profiles alike. The non-compatibility mux key is therefore the stable
    // runtime identity to remember, without silently persisting host edits.
    this.automaticPlainShellKeys.add(failed.connection.muxKey);
    this.log.info(
      { host: failed.connection.host, err: error.transportError ?? error },
      'remote shell integration disconnected the transport; retrying as a plain console',
    );
    io.status(
      'This server rejected SSH shell integration — reconnecting in plain-console mode …',
      { transient: true },
    );
    const compatible = await this.connect(profile, io, 'terminal', {
      dedicatedTransport: true,
      forcePlainShell: true,
    });
    try {
      const stream = await compatible.connection.shell(
        cols,
        rows,
        term,
        sessionSettings(compatible.target.resolved),
        undefined,
        backspaceKey,
      );
      return this.opened(compatible, stream, transport, io);
    } catch (retryError) {
      compatible.release();
      throw retryError;
    }
  }

  private async dialChain(
    chain: ChainHop[],
    profile: SshProfile,
    io: ConnectIo,
    owner: ConnectionLeaseOwner,
    key: string,
    metadataAlias: string | undefined,
    disableSftp: boolean,
    consoleCompatibility: boolean,
    freshToken: string | undefined,
    reuseJumpHops = true,
  ): Promise<ConnectionLease> {
    // Ride the deepest jump hop this route is already logged in to, so a
    // second connection behind a jump host costs no second login there.
    let first = 0;
    let route: JumpHop | undefined;
    for (let i = chain.length - 2; reuseJumpHops && i >= 0 && !route; i--) {
      route = this.jumpHops.reusable(muxKey(chain.slice(0, i + 1)), freshToken);
      if (route) first = i + 1;
    }
    const reused = route;
    reused?.retain();
    const postAuth: Promise<void>[] = [];
    let dialed: SshTransport | undefined;
    // Where a failure happened decides whether another jump route may help.
    let failingHop = first;
    let openingChannel = false;
    try {
      for (let i = first; i < chain.length; i++) {
        const hop = chain[i]!;
        failingHop = i;
        const reusing = route !== undefined && route === reused;
        const via = route
          ? ` via ${route.label}${reusing ? ' over its open connection' : ''}`
          : '';
        io.status(
          `Connecting to ${hop.user}@${hop.resolved.hostname}:${hop.port}${via} …`,
          { transient: true },
        );
        let tunnel: SshTunnel | undefined;
        if (route) {
          openingChannel = true;
          try {
            tunnel = await openJumpChannel(route.transport, hop.resolved.hostname, hop.port);
            openingChannel = false;
          } catch (err) {
            // A refusal from a live jump host is about the target. Anything
            // else means the shared connection itself is gone or unusable.
            if (reusing && (route.isClosed || !isChannelOpenRefusal(err))) {
              throw new StaleJumpHopError(route, err);
            }
            throw err;
          }
        }
        const transport = await this.dial(hop, tunnel, io);
        const pendingPostAuth = this.postAuth.get(transport);
        if (pendingPostAuth) postAuth.push(pendingPostAuth);
        if (i === chain.length - 1) {
          dialed = transport;
          break;
        }
        const next = this.jumpHops.add({
          key: muxKey(chain.slice(0, i + 1)),
          label: hop.spec.host,
          transport,
          parent: route,
          replacementToken: freshToken,
        });
        next.retain();
        route?.release();
        route = next;
      }
    } catch (err) {
      // Hops dialed for this chain close unless another chain rides them.
      route?.release();
      if (err instanceof StaleJumpHopError) {
        err.hop.superseded = true;
        this.log.info(
          { hop: err.hop.label, err: err.cause },
          'shared ssh jump host connection failed; dialing the jump host again',
        );
        return this.dialChain(
          chain,
          profile,
          io,
          owner,
          key,
          metadataAlias,
          disableSftp,
          consoleCompatibility,
          freshToken,
          false,
        );
      }
      // dial() already logged the raw failure; this adds which hop died.
      this.log.debug({ err, hops: chain.length, from: first }, 'ssh dial chain aborted');
      if (err instanceof Error && isRouteFailure(err, chain, failingHop, openingChannel)) {
        routeFailures.set(
          err,
          chain
            .slice(0, -1)
            .map((hop) => hop.spec.host)
            .join(' → '),
        );
      }
      throw err;
    }

    const target = chain[chain.length - 1]!;
    const transport = dialed!;
    const jumpRoute = route;
    const jumps = jumpRoute?.route() ?? [];
    const healthListeners = new Set<(state: SshTransportHealth) => void>();
    let targetHealth: SshTransportHealth = 'healthy';
    let transportHealth: SshTransportHealth = 'healthy';
    const updateHealth = () => {
      const next =
        targetHealth === 'suspect' || jumps.some((hop) => hop.health() === 'suspect')
          ? 'suspect'
          : 'healthy';
      if (next === transportHealth) return;
      transportHealth = next;
      for (const listener of healthListeners) listener(next);
    };
    const stopHealthObservers = [
      transport.onHealth((state) => {
        targetHealth = state;
        updateHealth();
      }),
      ...jumps.map((hop) => hop.onHealth(updateHealth)),
    ];
    const stopHealth = () => {
      for (const stop of stopHealthObservers.splice(0)) stop();
    };
    const x11: X11Transport | undefined = this.x11?.attach(transport);
    const id = nanoid(10);
    const closeListeners = new Set<(reason?: string) => void>();
    const postAuthSettled = Promise.all(postAuth).then(() => undefined);
    let sftpPromise: Promise<SftpClient> | undefined;
    const shellProbe: ShellProbeMemo = { ranCommand: false, execRefused: false };
    let probeUnanswered = false;
    let closed = false;
    let ending = false;

    const getSftp = () => {
      if (sftpPromise) return sftpPromise;
      const pending = transport.sftp();
      sftpPromise = pending;
      void pending.then(
        (sftp) => {
          sftp.onClose(() => {
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
      transport,
      profile,
      host: target.resolved.hostname,
      port: target.port,
      user: target.user,
      muxKey: key,
      metadataAlias,
      sftpAvailable: !disableSftp,
      ranCommand: () => shellProbe.ranCommand,
      commandsDeclined: () =>
        consoleCompatibility || (probeUnanswered && !shellProbe.ranCommand),
      health: () => transportHealth,
      configForwards: target.resolved.forwards,
      x11Refused: () => x11?.refused ?? false,
      x11Forwarded: (channel) => channel.x11Forwarded,
      facts: {
        ...this.handshakes.get(transport)!,
        jumpHosts: chain.slice(0, -1).map((hop) => hop.spec.host),
        proxyCommand: chain[0]!.resolved.proxyCommand !== undefined,
      },
      shell: async (
        cols,
        rows,
        term,
        session = sessionSettings(target.resolved),
        cwd,
        backspaceKey,
      ) => {
        const pty = wantsPty(session.requestTty, !!session.remoteCommand)
          ? terminalPtyOptions(cols, rows, term, backspaceKey)
          : undefined;
        const env = consoleCompatibility ? undefined : session.env;
        // A serial console has no environment, and appliances behind console
        // servers are the hosts least sure what to do with an env request.
        // For the same reason console hosts only get x11-req when they ask for it.
        const x11Request =
          consoleCompatibility && session.forwardX11 !== true
            ? undefined
            : x11?.request(session.forwardX11);
        const options: SessionOptions = {
          ...(pty ? { pty } : {}),
          ...(env ? { env } : {}),
          ...(x11Request ? { x11: x11Request } : {}),
        };
        const probed = !session.remoteCommand && !!pty && !disableSftp;
        const channel = session.remoteCommand
          ? await openSessionExec(transport, session.remoteCommand, options, consoleCompatibility)
          : pty && !disableSftp
            ? await openRemoteShell(transport, getSftp, { ...options, pty }, cwd, shellProbe)
            : await openPlainShell(transport, options, consoleCompatibility);
        if (probed && !shellProbe.ranCommand) probeUnanswered = true;
        if (x11Request && !channel.x11Forwarded) {
          // Like ssh(1), a refused x11-req costs X11, not the session.
          x11!.markRefused();
          this.log.info({ host: target.resolved.hostname }, 'ssh server refused X11 forwarding');
        }
        return channel;
      },
      // One SFTP channel per connection, shared by every file operation.
      sftp: () =>
        disableSftp
          ? Promise.reject(new Error('SFTP is disabled for this host.'))
          : getSftp(),
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
          queueMicrotask(() => listener(this.closeReasons.get(transport)));
          return () => undefined;
        }
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      waitForPostAuth: () => postAuthSettled,
      close: () => {
        if (ending) return;
        ending = true;
        transport.close();
      },
    };

    // A dying hop takes the whole chain with it; surface that as a close.
    const stopJumpWatch = jumps.map((hop) =>
      hop.onClose(() => {
        if (closed || ending) return;
        this.closeReasons.set(transport, `SSH jump host ${hop.label} disconnected.`);
        transport.close();
      }),
    );
    transport.onClose((failure) => {
      closed = true;
      stopHealth();
      for (const stop of stopJumpWatch) stop();
      this.connections.markClosed(managed);
      // Jump hops end with the last chain routed through them.
      jumpRoute?.release();
      if (failure && !ending && !this.closeReasons.has(transport)) {
        const reason = friendlyConnectError(new Error(failure), target).message;
        this.closeReasons.set(transport, reason);
        this.log.warn({ err: failure, host: target.resolved.hostname }, 'ssh connection error');
      }
      const reason = this.closeReasons.get(transport);
      for (const listener of closeListeners) listener(reason);
      closeListeners.clear();
      healthListeners.clear();
    });
    return this.connections.register(managed, owner);
  }

  closeAll(): void {
    this.connections.closeAll();
    this.jumpHops.closeAll();
  }

  /**
   * Reach one hop and log in to it: over `tunnel` when it sits behind a jump
   * host, else through its ProxyCommand or a TCP connection of its own.
   */
  private async dial(hop: ChainHop, tunnel: SshTunnel | undefined, io: ConnectIo): Promise<SshTransport> {
    const agentSocket = resolveAgentSocket(hop.resolved.identityAgent);
    const hopName = hop.hopLabel ?? hop.spec.host;
    let readyDeadline: PausableDeadline | undefined;
    const runInteraction: InteractionRunner = async (interaction) => {
      readyDeadline?.pause();
      try {
        return await interaction();
      } finally {
        readyDeadline?.resume();
      }
    };
    // A security key signs only once touched: user time, like any prompt.
    const agentHooks: ResponsiveAgentOptions = {
      pauseDeadline: () => readyDeadline?.pause(),
      resumeDeadline: () => readyDeadline?.resume(),
      onSecurityKey: (key) => {
        const label = securityKeyLabel(key);
        this.log.info({ host: hop.resolved.hostname, key: label }, 'waiting for a security key touch');
        io.status(`Touch your security key to log in to ${hopName} (${label})…`, { transient: true });
      },
      onSignature: (algorithm) => auth.noteSignature(algorithm),
    };
    const authAgent =
      agentSocket && !hop.resolved.identitiesOnly
        ? new ResponsiveAgent(agentSocket, {
            ...agentHooks,
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
      agentHooks,
      this.passwordManagers,
    );
    const { algorithms, notes } = connectionAlgorithms(pinnedHostKeyPreference(hop));
    for (const note of notes) {
      this.log.debug({ host: hop.resolved.hostname }, note);
      io.status(note);
    }
    const proxyCommand = !tunnel && hop.resolved.proxyCommand ? expandedProxyCommand(hop) : undefined;
    const readyTimeoutMs = (hop.resolved.connectTimeout ?? 20) * 1000;
    const keepalive = sshKeepaliveOptions(hop.resolved);
    this.log.debug(
      {
        host: hop.resolved.hostname,
        port: hop.port,
        user: hop.user,
        agent: !!agentSocket,
        identitiesOnly: !!hop.resolved.identitiesOnly,
        proxyCommand: !!hop.resolved.proxyCommand,
        viaJump: !!tunnel,
        readyTimeoutMs,
      },
      'dialing ssh host',
    );
    const transport = new SshTransport({
      host: hop.resolved.hostname,
      port: hop.port,
      ...(proxyCommand ? { proxyCommand } : {}),
      ...(tunnel ? { tunnel } : {}),
      ...algorithms,
      keepaliveIntervalMs: keepalive.keepaliveInterval,
      keepaliveCountMax: keepalive.keepaliveCountMax,
      // Sessions ask for agent forwarding, and the server's agent channels reach this agent.
      ...(agentSocket && hop.resolved.forwardAgent ? { agentForward: agentSocket } : {}),
      verifyHostKey: (key) =>
        this.verifyHostKey(hop, key, io, runInteraction).catch((err: unknown) => {
          this.log.warn({ err, host: hop.resolved.hostname }, 'host key verification failed');
          return false;
        }),
      onBanner: (message) => io.status(message.trimEnd()),
    });

    // The deadline covers reaching the host and logging in, less the time
    // spent in prompts, which only the user controls.
    let timedOut = false;
    readyDeadline = new PausableDeadline(readyTimeoutMs, () => {
      timedOut = true;
      transport.close();
    });
    try {
      const handshake = await transport.connect();
      await auth.login(transport);
      this.handshakes.set(transport, {
        serverSoftware: handshake.serverSoftware,
        kex: handshake.kex,
        cipher: handshake.cipher,
        compression: handshake.compression,
        authMethods: auth.acceptedMethods(),
        authKeyAlgorithm: auth.acceptedKeyAlgorithm(),
        compressionRequested: hop.resolved.compression === true,
        agentForwarding: !hop.resolved.forwardAgent ? 'off' : agentSocket ? 'on' : 'no-agent',
      });
    } catch (err) {
      readyDeadline.clear();
      auth.dispose();
      transport.close();
      const failure = timedOut
        ? new Error('Timed out while waiting for SSH readiness.')
        : auth.cancelled
          ? new Error('authentication cancelled')
          : err instanceof Error
            ? err
            : new Error(String(err));
      // The raw error, before friendlyConnectError() rewrites it — an agent
      // stall and a network timeout look identical to the user otherwise.
      this.log.warn(
        { err: failure, host: hop.resolved.hostname, port: hop.port, user: hop.user },
        'ssh dial failed',
      );
      throw friendlyConnectError(failure, hop, auth.securityKeyProblem());
    }
    readyDeadline.clear();
    this.log.debug(
      { host: hop.resolved.hostname, port: hop.port, user: hop.user },
      'ssh connection ready',
    );
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
    this.postAuth.set(transport, postAuth);
    return transport;
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
    const pinned = hop.hostKeyFingerprint;
    if (pinned) {
      // Checked before known_hosts: no stored key or StrictHostKeyChecking
      // setting may let a key through that the link rules out.
      if (!hostKeyMatchesFingerprint(key, pinned)) {
        this.log.warn(
          { host, port, keyType: hostKeyType(key) },
          'host key does not match the fingerprint in the link',
        );
        io.status(
          `HOST KEY MISMATCH for ${host}: the link expects ${pinned}, the server offered ${hostKeyType(key)} ${fingerprintLike(key, pinned)} — refusing to connect.`,
        );
        return false;
      }
      io.status(`The ${hostKeyType(key)} host key of ${host} matches the fingerprint in the link.`);
    }
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

/** The dial plan for one route: its hops, target and multiplexing key. */
interface RoutePlan {
  chain: ChainHop[];
  target: ChainHop;
  metadataAlias: string | undefined;
  consoleCompatibility: boolean;
  disableSftp: boolean;
  key: string;
}

/** Which host a remembered route belongs to. */
function lastRouteKey(profile: SshProfile): string {
  return profile.profileId ? `profile:${profile.profileId}` : `target:${profile.user ?? ''}@${profile.target}:${profile.port ?? ''}`;
}

/**
 * Identity of a dial plan for connection sharing: the resolved hop sequence
 * (user@hostname:port and agent-forwarding policy for each hop) plus the
 * expanded ProxyCommand transport when one applies. Settings that matter only
 * while establishing a transport — auth and keepalive policy alike — are
 * deliberately absent: a keepalive preference change must not fork sharing
 * (and demand a second login) while the established transport still works.
 */
export function muxKey(
  chain: ChainHop[],
  disableSftp = false,
  consoleCompatibility = false,
): string {
  // A pinned target never shares a transport whose key it has not checked.
  const hops = chain.map(
    (hop) =>
      `${hop.user}@${hop.resolved.hostname}:${hop.port};agentForward=${hop.resolved.forwardAgent ? 'yes' : 'no'}${
        hop.hostKeyFingerprint ? `;hostKey=${hop.hostKeyFingerprint}` : ''
      }`,
  );
  const first = chain[0];
  const proxy = first?.resolved.proxyCommand ? expandedProxyCommand(first) : undefined;
  let key = (proxy ? [`proxy(${proxy})`, ...hops] : hops).join(' -> ');
  if (disableSftp) key += ';muxusSftp=disabled';
  if (consoleCompatibility) key += ';muxusConsole=compatible';
  return key;
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

/** The password-manager entry linked to an OpenSSH alias or to a saved Muxus host. */
export interface PasswordRefLookups {
  forHost?: (alias: string) => ExternalPasswordRef | undefined;
  forProfile?: (id: string) => ExternalPasswordRef | undefined;
}

/**
 * Expand a profile into the ordered list of hosts to dial: every ProxyJump
 * hop (each recursively resolved through the config, like the `ssh -W`
 * processes OpenSSH would spawn) and the final target last. Each hop that is
 * a saved alias picks up its own folder's defaults as the lowest-priority
 * config layer. A hop naming a saved Muxus SSH host dials with that host's
 * own settings, exactly as connecting to it directly would.
 */
export function buildChain(
  doc: ConfigDocument,
  profile: Omit<SshProfile, 'kind'>,
  folderAuthFor?: FolderAuthLookup,
  profileFolderAuthFor?: FolderAuthLookup,
  savedProfileFor?: (id: string) => SshProfile | undefined,
  passwordRefs?: PasswordRefLookups,
): ChainHop[] {
  const chain: ChainHop[] = [];
  const visited = new Set<string>();

  /**
   * `owner` is the Muxus-side profile whose fields win over the resolved
   * base: the requested profile for the final target, or the saved host a
   * jump hop names. Plain jump hops have none and resolve through the config.
   */
  const walk = (
    spec: { host: string; user?: string; port?: number },
    owner: Omit<SshProfile, 'kind'> | undefined,
    final: boolean,
    depth: number,
  ): void => {
    if (depth > MAX_JUMP_DEPTH) throw new Error('ProxyJump chain too deep');
    const visitKeys = [
      ...(!final && owner?.profileId ? [] : [spec.host]),
      ...(owner?.profileId ? [`profile:${owner.profileId}`] : []),
    ];
    if (visitKeys.some((key) => visited.has(key))) {
      throw new Error(`ProxyJump cycle detected at "${spec.host}"`);
    }
    for (const key of visitKeys) visited.add(key);
    const fromConfig = owner?.useConfig !== false;
    const folder = fromConfig
      ? folderAuthFor?.(spec.host)
      : owner?.profileId
        ? profileFolderAuthFor?.(owner.profileId)
        : undefined;
    const hostPasswordRef = fromConfig
      ? passwordRefs?.forHost?.(spec.host)
      : owner?.profileId
        ? passwordRefs?.forProfile?.(owner.profileId)
        : undefined;
    const configuredBase = fromConfig
      ? resolveHost(doc, spec.host, folder?.optionLines)
      : folder
        ? resolveHost(EMPTY_CONFIG_DOCUMENT, spec.host, folder.optionLines)
        : directSettings(spec.host);
    // The application preference is a fallback, not an override: aliases with
    // an explicit ServerAliveInterval (including 0) keep their own policy.
    // Apply it to jump hops as well so every TCP leg stays alive while idle.
    const base = {
      ...configuredBase,
      serverAliveInterval:
        configuredBase.serverAliveInterval ?? profile.keepaliveIntervalSeconds,
    };
    const user = owner?.user ?? spec.user ?? base.user ?? os.userInfo().username;
    const resolved = owner ? overlayProfile(base, owner, user) : base;
    for (const hopSpec of resolved.proxyJump) {
      const savedId = savedHostHopId(hopSpec);
      if (savedId === undefined) {
        walk(parseHostSpec(hopSpec), undefined, false, depth + 1);
        continue;
      }
      const saved = savedProfileFor?.(savedId);
      if (!saved || saved.useConfig !== false) {
        throw new Error(`saved SSH host "${savedId}" used as a jump host was not found`);
      }
      walk(parseHostSpec(saved.target), { ...saved, profileId: savedId }, false, depth + 1);
    }
    chain.push({
      spec,
      resolved,
      user,
      port: owner?.port ?? spec.port ?? resolved.port,
      hopLabel: final ? undefined : spec.host,
      ...(!fromConfig && owner?.profileId ? { savedHost: true } : {}),
      folderPasswords: folder?.passwords,
      ...(hostPasswordRef ? { passwordRef: hostPasswordRef } : {}),
      ...(final && profile.hostKeyFingerprint
        ? { hostKeyFingerprint: profile.hostKeyFingerprint }
        : {}),
    });
  };

  walk(parseHostSpec(profile.target), profile, true, 0);
  return chain;
}

/** Layer a profile's own connection fields over the settings it resolved to. */
function overlayProfile(
  base: ResolvedTarget,
  profile: Omit<SshProfile, 'kind'>,
  user: string,
): ResolvedTarget {
  return {
    ...base,
    identityFiles:
      profile.identityFiles === undefined
        ? base.identityFiles
        : profile.identityFiles.map((file) =>
            expandIdentityPath(file, { h: base.hostname, r: user }),
          ),
    certificateFiles:
      profile.certificateFiles === undefined
        ? base.certificateFiles
        : profile.certificateFiles.map((file) =>
            expandIdentityPath(file, { h: base.hostname, r: user }),
          ),
    identitiesOnly: profile.identitiesOnly ?? base.identitiesOnly,
    identityAgent: profile.identityAgent ?? base.identityAgent,
    forwardAgent: profile.forwardAgent ?? base.forwardAgent,
    forwardX11: profile.forwardX11 ?? base.forwardX11,
    proxyJump: profile.proxyJump ?? base.proxyJump,
    proxyCommand:
      profile.proxyCommand ??
      (profile.proxyJump === undefined ? base.proxyCommand : undefined),
    forwards: profile.forwards ?? base.forwards,
    passwordOnly: profile.passwordOnly ?? base.passwordOnly,
    remoteCommand: profile.remoteCommand ?? base.remoteCommand,
    requestTty: profile.requestTty ?? base.requestTty,
    strictHostKeyChecking:
      profile.strictHostKeyChecking ?? base.strictHostKeyChecking,
    kexAlgorithms: profile.kexAlgorithms ?? base.kexAlgorithms,
    hostKeyAlgorithms: profile.hostKeyAlgorithms ?? base.hostKeyAlgorithms,
    ciphers: profile.ciphers ?? base.ciphers,
    macs: profile.macs ?? base.macs,
  };
}

/** Empty base used to apply only Muxus folder defaults to a DB-backed host. */
const EMPTY_CONFIG_DOCUMENT: ConfigDocument = {
  rootPath: '',
  files: new Map(),
  fileOrder: [],
  blocks: [],
  sequence: [],
};

/**
 * A fingerprint in the draft's `<key type>-<md5>` form names one key type, so
 * a server holding several host keys is asked for that one first. A
 * configured HostKeyAlgorithms list is left alone.
 */
function pinnedHostKeyPreference(hop: ChainHop): ResolvedTarget {
  const pinned = hop.hostKeyFingerprint;
  const space = pinned?.indexOf(' ') ?? -1;
  if (!pinned || space < 0 || hop.resolved.hostKeyAlgorithms) return hop.resolved;
  return { ...hop.resolved, hostKeyAlgorithms: hostKeyAlgorithmsPreferring(pinned.slice(0, space)) };
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

/** A hop's ProxyCommand with its tokens filled in, if it has one. */
export function expandedProxyCommand(hop: ChainHop): string | undefined {
  if (!hop.resolved.proxyCommand) return undefined;
  return expandProxyCommand(hop.resolved.proxyCommand, {
    hostname: hop.resolved.hostname,
    originalHost: hop.spec.host,
    port: hop.port,
    user: hop.user,
  });
}

/**
 * Ad-hoc targets never masquerade as OpenSSH-backed database profiles. Same
 * answer as looking the target up in listHosts(), without resolving every
 * host in the config on each connect.
 */
export function findMetadataAlias(doc: ConfigDocument, requestedHost: string): string | undefined {
  return doc.blocks.some((block) =>
    block.patterns.some((pattern) => pattern === requestedHost && isConcreteAlias(pattern)),
  )
    ? requestedHost
    : undefined;
}

/**
 * The alias of the host the window reads a tab's host metadata from: the
 * host list's first entry naming `target`, in the order the list is served.
 * Only a plain alias names one, not `user@alias` or `alias:port`.
 */
export function listedMetadataAlias(doc: ConfigDocument, target: string): string | undefined {
  return listedHostFor(sortHostList(listedHosts(doc)), target)?.alias;
}

/** direct-tcpip channel from a jump host to the next hop — the `ssh -W` equivalent. */
async function openJumpChannel(transport: SshTransport, host: string, port: number): Promise<SshTunnel> {
  try {
    return await transport.openTunnel(host, port);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`jump host could not reach ${host}:${port}: ${message}`, { cause: err });
  }
}

/** The server answered a channel open with an explicit refusal (RFC 4254 reason code). */
function isChannelOpenRefusal(err: unknown): boolean {
  return isSshError(err instanceof Error ? err.cause : undefined, 'CHANNEL_OPEN_FAILED');
}

/**
 * Dial failures another jump route could avoid, mapped to the route that
 * failed ('' for a direct connection). A target that refuses the login is
 * the same target on every route, and a cancelled prompt is the user's
 * choice, so neither tries the next route.
 */
const routeFailures = new WeakMap<Error, string>();

/** Failures that end the attempt instead of trying another route or gateway. */
export const STOP_FALLBACK = /authentication cancelled|host key verification failed|host denied/i;

const NETWORK_FAILURE =
  /connection refused|could not resolve|timed out|connection reset|no route to|network is unreachable|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE/i;

export function isRouteFailure(
  err: Error,
  chain: readonly ChainHop[],
  failingHop: number,
  openingChannel: boolean,
): boolean {
  // A cancelled prompt is the user's choice; a rejected or changed host key
  // must be seen, not quietly routed around.
  if (STOP_FALLBACK.test(err.message)) return false;
  // A jump host failed, or could not reach the next hop.
  if (failingHop < chain.length - 1 || openingChannel) return true;
  // The target itself: only a direct connection that never got through counts.
  return chain.length === 1 && NETWORK_FAILURE.test(err.message);
}

/** A shared jump hop could not carry another chain; the chain dials it again. */
class StaleJumpHopError extends Error {
  constructor(
    readonly hop: JumpHop,
    cause: unknown,
  ) {
    super(`shared connection to jump host ${hop.label} failed`, { cause });
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

interface AuthAttempt {
  type: AuthMethodName;
  /** Offer the method to the server; undefined when there is nothing to offer. */
  run(transport: SshTransport): Promise<AuthOutcome | undefined>;
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
function isKeyboardInteractivePasswordPrompt(prompts: readonly KeyboardPrompt[]): boolean {
  if (prompts.length !== 1 || prompts[0]?.echo !== false) return false;
  const label = prompts[0].prompt.trim().replace(/:\s*$/, '').trim();
  return (
    /^password(?:\s+for\s+.+)?$/i.test(label) ||
    /^.+(?:'s|’s)\s+password$/i.test(label)
  );
}

type InteractionRunner = <T>(interaction: () => Promise<T>) => Promise<T>;

type LoadedCertificate =
  | { file: string; certificate: OpenSshCertificate }
  | { file: string; securityKey: SshIdentity };

/** The server's own word for a method: agents and key files both log in as publickey. */
function wireMethod(type: AuthMethodName): string {
  return type === 'agent' ? 'publickey' : type;
}

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
 * OpenSSH's client auth order: none → agent (unless IdentitiesOnly) →
 * configured certificates with their matching private keys → identity files
 * (config ones first, else the default id_* files) with passphrase prompts →
 * keyboard-interactive → password.
 * That order is a preference, not a single pass: each reply from the server
 * picks the first untried attempt it currently accepts, so a multi-step login
 * can ask for a method it did not advertise until an earlier one succeeded.
 * Every attempt happens inside one TCP connection, like the real client.
 */
class AuthLadder {
  private readonly attempts: AuthAttempt[];
  /** Attempts already offered, or found to have nothing to offer. */
  private readonly tried = new Set<AuthAttempt>();
  private readonly privateKeys = new Map<string, Promise<SshPrivateKey | undefined>>();
  private readonly certificateKeys = new Map<
    OpenSshCertificate,
    Promise<SshPrivateKey | undefined>
  >();
  private agentIdentityPrints: Promise<Set<string>> | undefined;
  private lastPasswordCandidate: RememberedPasswordCandidate | undefined;
  private partialPasswordCandidate: RememberedPasswordCandidate | undefined;
  private savedPasswordAttempted = false;
  private retryKeyboardInteractive = false;
  /** The method last offered to the server, and those it partially accepted. */
  private lastMethod: AuthMethodName | undefined;
  private readonly partialMethods: AuthMethodName[] = [];
  /** Signature algorithm of the key in the attempt in flight, and of a partially accepted one. */
  private keyAlgorithm: string | undefined;
  private partialKeyAlgorithm: string | undefined;
  private readonly securityKeyAgents: SecurityKeyFileAgent[] = [];
  private lastSecurityKeyProblem: string | undefined;
  cancelled = false;

  constructor(
    private readonly hop: ChainHop,
    private readonly io: ConnectIo,
    private readonly vault?: PasswordVault,
    private readonly runInteraction: InteractionRunner = (interaction) =>
      interaction(),
    private readonly agent?: ResponsiveAgent,
    private readonly log?: FastifyBaseLogger,
    /** Deadline and touch-prompt hooks for agents signing on this hop. */
    private readonly agentHooks: ResponsiveAgentOptions = {},
    private readonly passwordManagers?: PasswordManagers,
  ) {
    this.attempts = this.build();
  }

  /**
   * Log in, or throw: `authentication cancelled` when the user dismissed a
   * prompt, `All configured authentication methods failed` when the server
   * took none of them, or the engine's own error when the connection broke.
   */
  async login(transport: SshTransport): Promise<void> {
    const host = this.hop.resolved.hostname;
    /** Methods the server said can still succeed; unknown before its first reply. */
    let authsLeft: string[] | undefined;
    for (;;) {
      // The server told us which methods can still succeed; pass over the rest
      // without spending them, since a later step may start accepting them.
      const attempt = this.cancelled
        ? undefined
        : this.attempts.find(
            (candidate) =>
              !this.tried.has(candidate) &&
              (!authsLeft || candidate.type === 'none' || authsLeft.includes(wireMethod(candidate.type))),
          );
      if (!attempt) {
        this.log?.debug({ host, cancelled: this.cancelled, authsLeft }, 'ssh auth ladder exhausted');
        throw new Error(
          this.cancelled ? 'authentication cancelled' : 'All configured authentication methods failed',
        );
      }
      this.tried.add(attempt);
      this.lastMethod = undefined;
      this.keyAlgorithm = undefined;
      let outcome: AuthOutcome | undefined;
      try {
        outcome = await attempt.run(transport);
      } catch (err) {
        // The connection itself failed; nothing is left to try on it.
        if (err instanceof SshError) throw err;
        // A dismissed prompt gives the login up.
        this.cancelled = true;
        continue;
      }
      if (!outcome) {
        this.log?.debug({ host, method: attempt.type }, 'ssh auth method unavailable; skipping');
        continue;
      }
      this.lastMethod = attempt.type;
      if (outcome.success) return;
      if (this.lastPasswordCandidate) {
        if (outcome.partial) this.partialPasswordCandidate = this.lastPasswordCandidate;
        this.lastPasswordCandidate = undefined;
      }
      if (outcome.partial) {
        this.partialMethods.push(attempt.type);
        if (this.keyAlgorithm) this.partialKeyAlgorithm = this.keyAlgorithm;
      }
      authsLeft = outcome.remaining;
    }
  }

  /** Once the connection is ready: the methods that logged in, in order. */
  acceptedMethods(): AuthMethodName[] {
    return this.lastMethod ? [...this.partialMethods, this.lastMethod] : [...this.partialMethods];
  }

  /** Once the connection is ready: the signature algorithm of the key that logged in. */
  acceptedKeyAlgorithm(): string | undefined {
    return this.keyAlgorithm ?? this.partialKeyAlgorithm;
  }

  /** An agent signed for the attempt in flight. */
  noteSignature(algorithm: string): void {
    this.keyAlgorithm = algorithm;
  }

  /** Why a security key could not log in, for the error when nothing else did. */
  securityKeyProblem(): string | undefined {
    return this.lastSecurityKeyProblem;
  }

  /**
   * Offer the identities an agent holds, one after the other. An identity
   * the agent cannot sign with costs that identity, not the login; an agent
   * that is not there ends the round. Undefined when nothing was offered.
   */
  private async offerAgentIdentities(
    transport: SshTransport,
    agent: SshAgent,
  ): Promise<AuthOutcome | undefined> {
    const host = this.hop.resolved.hostname;
    const hopName = this.hop.hopLabel ?? this.hop.spec.host;
    let identities: SshIdentity[];
    try {
      identities = await agent.identities();
    } catch (err) {
      this.agentUnavailable(err);
      return undefined;
    }
    let last: AuthOutcome | undefined;
    for (const identity of identities) {
      if (this.cancelled) break;
      if (last && !last.remaining.includes('publickey')) break;
      const rsa = identity.type === 'ssh-rsa' || identity.type.startsWith('ssh-rsa-cert-');
      const hash = rsa ? await transport.rsaHash() : undefined;
      let signFailure: unknown;
      let outcome: AuthOutcome;
      try {
        outcome = await transport.authSigner(
          this.hop.user,
          identity.blob,
          hash,
          async (data) => {
            try {
              return await agent.sign(identity, data, hash === 'sha1' ? {} : { hash });
            } catch (err) {
              signFailure = err ?? new Error('the agent did not sign');
              throw err;
            }
          },
        );
      } catch (err) {
        // An identity of a type the engine does not know is passed over, like one the server refuses.
        if (isSshError(err, 'KEY_INVALID')) continue;
        if (!isSshError(err, 'SIGN_FAILED')) throw err;
        if (this.cancelled) break;
        if (signFailure instanceof SecurityKeyError) {
          const message = describeSecurityKeyError(signFailure, hopName);
          this.log?.warn({ err: signFailure, host }, 'security key did not sign');
          this.lastSecurityKeyProblem = message;
          this.io.status(`${message} — trying other authentication methods`);
          continue;
        }
        this.agentUnavailable(signFailure);
        // An agent that is gone will not sign with its other keys either.
        if (agent instanceof ResponsiveAgent && agent.unavailable) break;
        continue;
      }
      last = outcome;
      if (outcome.success || outcome.partial) return outcome;
      this.keyAlgorithm = undefined;
    }
    return last;
  }

  /** Say that the agent could not help, unless it simply is not running. */
  private agentUnavailable(err: unknown): void {
    const host = this.hop.resolved.hostname;
    // An unreachable agent is an expected fallback when a stale agent socket
    // is inherited, so keep it out of user-facing status.
    if (isSshError(err, 'AGENT_UNAVAILABLE')) {
      this.log?.debug({ err, host }, 'ssh-agent unavailable; trying other authentication methods');
      return;
    }
    if (err instanceof SecurityKeyError) {
      const message = describeSecurityKeyError(err, this.hop.hopLabel ?? this.hop.spec.host);
      this.log?.warn({ err, host }, 'security key did not sign');
      this.lastSecurityKeyProblem = message;
      this.io.status(`${message} — trying other authentication methods`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.log?.warn({ err, host }, 'ssh-agent unavailable; trying other authentication methods');
    this.io.status(`ssh-agent unavailable (${message}) — trying other authentication methods`);
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
    for (const agent of this.securityKeyAgents.splice(0)) agent.dispose();
  }

  private build(): AuthAttempt[] {
    const { resolved, user, hopLabel } = this.hop;
    const label = hopLabel ?? this.hop.spec.host;
    const attempts: AuthAttempt[] = [{ type: 'none', run: (transport) => transport.authNone(user) }];
    const agentSocket = resolveAgentSocket(resolved.identityAgent);

    if (!resolved.passwordOnly) {
      const agent = this.agent;
      if (agentSocket && agent && !resolved.identitiesOnly) {
        attempts.push({ type: 'agent', run: (transport) => this.offerAgentIdentities(transport, agent) });
      }
      const explicit = resolved.identityFiles.length > 0;
      const files = explicit ? resolved.identityFiles : defaultIdentityFiles();
      const certificates = resolved.certificateFiles
        .map((file) => this.loadCertificate(file))
        .filter((item): item is LoadedCertificate => !!item);
      for (const loaded of certificates) {
        const { file } = loaded;
        if ('securityKey' in loaded) {
          attempts.push({
            type: 'publickey',
            run: async (transport) => {
              const signer = await this.securityKeyCertificateAgent(file, loaded.securityKey, files, agentSocket, label);
              return signer && this.offerAgentIdentities(transport, signer);
            },
          });
          continue;
        }
        const { certificate } = loaded;
        for (const algorithm of certificateAlgorithms(certificate)) {
          attempts.push({
            type: 'publickey',
            run: async (transport) => {
              const privateKey = await this.findCertificateKey(
                file,
                certificate,
                files,
                explicit || resolved.certificateFiles.length > 0,
                agentSocket,
                label,
              );
              if (!privateKey) return undefined;
              this.keyAlgorithm = algorithm;
              return transport.authCertificate(user, privateKey, certificate.publicBlob, certificateRsaHash(algorithm));
            },
          });
        }
      }
      for (const file of files) {
        attempts.push({
          type: 'publickey',
          run: async (transport) => {
            const securityKey = await this.securityKeyAgent(file, agentSocket, label);
            if (securityKey !== null) return securityKey && this.offerAgentIdentities(transport, securityKey);
            const key = await this.loadPrivateKey(
              file,
              explicit,
              agentSocket,
              label,
            );
            if (!key) return undefined;
            if (key.keyType !== 'ssh-rsa') {
              this.keyAlgorithm = key.keyType;
              return transport.authPublicKey(user, key);
            }
            const hash = await transport.rsaHash();
            this.keyAlgorithm = hash === 'sha1' ? 'ssh-rsa' : `rsa-sha2-${hash.slice(3)}`;
            return transport.authPublicKey(user, key, hash);
          },
        });
      }
    }

    if (resolved.kbdInteractiveAuthentication !== false) {
      for (let attempt = 0; attempt < MAX_KEYBOARD_INTERACTIVE_ATTEMPTS; attempt++) {
        attempts.push({
          type: 'keyboard-interactive',
          run: (transport) => {
            // Arbitrary challenges get one attempt; only a recognized password
            // flow may retry for stale-password replacement.
            if (attempt > 0 && !this.retryKeyboardInteractive) {
              return Promise.resolve(undefined);
            }
            this.retryKeyboardInteractive = false;
            let challengeRound = 0;
            return transport.authKeyboardInteractive(user, async (name, instructions, prompts) => {
              challengeRound += 1;
              try {
                return await this.keyboardInteractiveAnswers(
                  name,
                  instructions,
                  label,
                  prompts,
                  challengeRound === 1,
                );
              } catch {
                // The exchange still has to be answered; the login ends after it.
                this.cancelled = true;
                return prompts.map(() => '');
              }
            });
          },
        });
      }
    }

    if (resolved.passwordAuthentication !== false) {
      for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
        attempts.push({
          type: 'password',
          run: async (transport) => transport.authPassword(user, await this.passwordMethod(attempt, label)),
        });
      }
    }
    return attempts;
  }

  /** The password to offer: a saved one first, else what the user types. */
  private async passwordMethod(
    attempt: number,
    promptLabel: string,
  ): Promise<string> {
    const { user } = this.hop;
    const credential = this.passwordCredential();
    const saved = await this.availableSavedPassword(credential);
    if (saved !== undefined) return saved;

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
    return response.answers[0] ?? '';
  }

  private async keyboardInteractiveAnswers(
    name: string,
    instructions: string,
    promptLabel: string,
    prompts: KeyboardPrompt[],
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
    if (this.savedPasswordAttempted) return undefined;
    // The host's own password wins: its linked password-manager entry, then
    // its saved vault password. Folder passwords are the shared default the
    // host falls back to, nearest folder first.
    const sources: Array<{ entry: ExternalPasswordRef } | { account: string; label: string }> = [];
    if (this.hop.passwordRef && this.passwordManagers) sources.push({ entry: this.hop.passwordRef });
    if (credential.existing) sources.push({ account: credential.account, label: credential.label });
    for (const folder of this.hop.folderPasswords ?? []) {
      if (folder.entry && this.passwordManagers) sources.push({ entry: folder.entry });
      else if (this.vault?.hasSshPassword(folder.account)) sources.push(folder);
    }

    for (const source of sources) {
      this.savedPasswordAttempted = true;
      if ('entry' in source) {
        // Reading may wait on the manager's own approval or unlock prompt.
        const password = await this.runInteraction(() =>
          this.passwordManagers!.passwordFor(source.entry, this.io),
        );
        if (password !== undefined) return password;
        // An entry that cannot be read leaves the next saved password its turn.
        continue;
      }
      const saved = await this.savedPassword(source.account, source.label);
      if (saved !== undefined) {
        this.io.status(`Using the saved password for ${source.label}.`, {
          transient: true,
        });
      }
      return saved;
    }
    return undefined;
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

  private loadCertificate(file: string): LoadedCertificate | undefined {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch {
      this.io.status(`certificate file ${file} not found — skipping`);
      return undefined;
    }
    const securityKey = securityKeyCertificate(content);
    if (securityKey) return { file, securityKey };
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
  ): Promise<SshPrivateKey | undefined> {
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
  ): Promise<SshPrivateKey | undefined> {
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
  ): Promise<SshPrivateKey | undefined> {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch {
      if (explicit) this.io.status(`identity file ${file} not found — skipping`);
      return undefined;
    }
    // Security key files are signed through an agent, never parsed here.
    if (securityKeyFile(content)) return undefined;
    let parsed = parseSshKey(content);
    if (isEncryptedKeyError(parsed)) {
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
    return parsed;
  }

  /** True when the key's .pub sibling names an identity the agent holds. */
  private async agentHoldsKey(
    file: string,
    agentSocket: string,
    agent: SshAgent,
  ): Promise<boolean> {
    let fingerprint: string;
    try {
      const blob = fs.readFileSync(`${file}.pub`, 'utf8').trim().split(/\s+/)[1];
      if (!blob) return false;
      fingerprint = fingerprintSha256(Buffer.from(blob, 'base64'));
    } catch {
      return false; // no readable .pub — prompt rather than guess
    }
    return this.agentHoldsFingerprint(fingerprint, agentSocket, agent);
  }

  private async agentHoldsFingerprint(
    fingerprint: string,
    agentSocket: string,
    agent: SshAgent,
  ): Promise<boolean> {
    this.agentIdentityPrints ??= listAgentKeys(agentSocket, agent).then(
      (keys) => new Set(keys.map((k) => k.fingerprint)),
    );
    return (await this.agentIdentityPrints).has(fingerprint);
  }

  /**
   * A security key IdentityFile signs through a private ssh-agent (see
   * SecurityKeyFileAgent). null when the file is not a security key, and
   * undefined when the login agent has already offered it.
   */
  private async securityKeyAgent(
    file: string,
    agentSocket: string | undefined,
    label: string,
  ): Promise<SecurityKeyFileAgent | undefined | null> {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch {
      return null;
    }
    const publicKey = securityKeyFile(content);
    if (!publicKey) return null;
    return this.securityKeyFileAgent(file, publicKey, undefined, agentSocket, label);
  }

  /** A security key CertificateFile, signed by its matching IdentityFile. */
  private async securityKeyCertificateAgent(
    certificateFile: string,
    certificate: SshIdentity,
    identityFiles: string[],
    agentSocket: string | undefined,
    label: string,
  ): Promise<SecurityKeyFileAgent | undefined> {
    const keyBlob = plainKeyBlob(certificate.blob);
    for (const file of identityFiles) {
      let content: Buffer;
      try {
        content = fs.readFileSync(file);
      } catch {
        continue;
      }
      const publicKey = securityKeyFile(content);
      if (publicKey?.blob.equals(keyBlob)) {
        return this.securityKeyFileAgent(file, publicKey, certificate, agentSocket, label);
      }
    }
    this.io.status(`certificate ${certificateFile} has no matching identity file — skipping`);
    return undefined;
  }

  private async securityKeyFileAgent(
    file: string,
    publicKey: SshIdentity,
    certificate: SshIdentity | undefined,
    agentSocket: string | undefined,
    label: string,
  ): Promise<SecurityKeyFileAgent | undefined> {
    // The login agent already offered this identity, and signs it the same way.
    const fingerprint = fingerprintSha256((certificate ?? publicKey).blob);
    if (agentSocket && this.agent && (await this.agentHoldsFingerprint(fingerprint, agentSocket, this.agent))) {
      return undefined;
    }
    const agent = new SecurityKeyFileAgent({
      file,
      publicKey,
      identity: certificate,
      provider: securityKeyProvider(this.hop.resolved.securityKeyProvider),
      ask: (question) => this.securityKeyAnswer(question, file, label),
      agentOptions: this.agentHooks,
    });
    this.securityKeyAgents.push(agent);
    return agent;
  }

  /** OpenSSH asks for the key file's passphrase or the security key's PIN. */
  private async securityKeyAnswer(
    question: SecurityKeyQuestion,
    file: string,
    label: string,
  ): Promise<string | undefined> {
    const name = path.basename(file);
    const prompt =
      question.kind === 'passphrase'
        ? `${question.retry ? 'Bad passphrase, try again. ' : ''}Passphrase for ${name}`
        : question.kind === 'pin'
          ? `PIN for the security key ${name}`
          : question.text;
    try {
      const response = await this.runInteraction(() =>
        this.io.prompt({
          host: label,
          purpose: 'authentication',
          instructions:
            question.kind === 'pin' && question.presence
              ? 'Touch the security key after entering its PIN.'
              : undefined,
          prompts: [{ prompt, echo: false }],
        }),
      );
      return response.answers[0] || undefined;
    } catch (err) {
      this.cancelled = true;
      throw err;
    }
  }
}

function defaultIdentityFiles(): string[] {
  const dir = path.join(os.homedir(), '.ssh');
  return DEFAULT_IDENTITY_NAMES.map((name) => path.join(dir, name)).filter((p) => fs.existsSync(p));
}

/** RemoteCommand session: exec instead of a shell, tty per RequestTTY. */
async function openSessionExec(
  transport: SshTransport,
  command: string,
  options: SessionOptions,
  retryWithoutPty = false,
): Promise<SshChannel> {
  try {
    return await transport.exec(command, options);
  } catch (err) {
    if (!retryWithoutPty || !options.pty || !isSshError(err, 'PTY_REFUSED')) throw err;
    return transport.exec(command, { ...options, pty: undefined });
  }
}

/**
 * Console appliances disagree about pty-req: some reject it, others refuse a
 * shell without one. Ask for the tty ssh(1) would and, like ssh(1), carry on
 * without it when the server says no. The refused request ended its channel,
 * so the retry opens a fresh one.
 */
async function openPlainShell(
  transport: SshTransport,
  options: SessionOptions,
  retryWithoutPty = false,
): Promise<SshChannel> {
  try {
    return await transport.shell(options);
  } catch (err) {
    if (!retryWithoutPty || !options.pty || !isSshError(err, 'PTY_REFUSED')) throw err;
    return transport.shell({ ...options, pty: undefined });
  }
}

/**
 * Translate the common connect failures into user-actionable messages.
 * `securityKeyProblem` explains why a security key could not take part.
 */
function friendlyConnectError(err: Error, hop: ChainHop, securityKeyProblem?: string): Error {
  const msg = err.message;
  const code = err instanceof SshError ? err.code : undefined;
  const where = `${hop.resolved.hostname}:${hop.port}`;
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
    return new Error(`connection refused by ${where} — is sshd running?`);
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND|EAI_AGAIN/.test(msg)) {
    return new Error(`could not resolve host ${hop.resolved.hostname}`);
  }
  if (code === 'ETIMEDOUT' || /ETIMEDOUT|Timed out/i.test(msg)) {
    return new Error(`connection to ${where} timed out`);
  }
  if (code === 'EHOSTUNREACH' || /EHOSTUNREACH/.test(msg)) return new Error(`no route to ${where}`);
  if (code === 'ENETUNREACH' || /ENETUNREACH/.test(msg)) {
    return new Error(`the network is unreachable for ${where}`);
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || /ECONNRESET|EPIPE/.test(msg)) {
    return new Error(`connection reset by ${where}`);
  }
  if (code === 'KEEPALIVE_TIMEOUT' || /^Keepalive timeout$/.test(msg)) {
    return new Error(`${where} stopped answering keepalives`);
  }
  if (/All configured authentication methods failed/.test(msg)) {
    return new Error(
      securityKeyProblem
        ? `authentication to ${where} failed: ${securityKeyProblem}`
        : `authentication to ${where} failed`,
    );
  }
  if (code === 'NO_MATCHING_ALGORITHM' || /Handshake failed: no matching/i.test(msg)) {
    const fix = hop.savedHost
      ? 'set KexAlgorithms/Ciphers/HostKeyAlgorithms for this host (Advanced → Algorithms in the host editor)'
      : "add KexAlgorithms/Ciphers/HostKeyAlgorithms lines to this host's ssh config (Advanced options in the host editor)";
    return new Error(`${msg} — if ${where} only speaks legacy algorithms, ${fix}`);
  }
  // The engine's code names nothing the user needs; its message does.
  return err instanceof SshError ? new Error(msg) : err;
}
