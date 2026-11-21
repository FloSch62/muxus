import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import type { ForwardInfo, ForwardRequest, SshProfile, TunnelRecord } from '@muxus/shared';
import { DEFAULT_SSH_KEEPALIVE_INTERVAL_SECONDS } from '@muxus/shared/ws-protocol';
import type {
  ConnectIo,
  ConnectionLease,
  SshConnectionManager,
  ManagedConnection,
} from '../ssh/connection-manager.js';
import { isSshError } from '../ssh/engine.js';
import { HttpProblem } from '../util/errors.js';

/** Waits before each redial of a dropped tunnel; the last one repeats. */
export const TUNNEL_RECONNECT_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Uptime after which a drop starts over at the shortest wait. */
export const TUNNEL_RECONNECT_STABLE_MS = 30_000;

/** A redial needed a password, passphrase, 2FA code or host key answer. */
const NEEDS_SIGN_IN = 'Sign-in needed — start the tunnel again';

interface ActiveForward {
  info: ForwardInfo;
  /** Close the listener and release the connection lease. Idempotent. */
  unbind(): void;
  /** Cancel a scheduled or in-flight dial. */
  cancelReconnect?(): void;
  /** When the listener last came up on a connection. */
  boundAt: number;
  /** Redials since the last stable connection. */
  attempts: number;
  /** The renderer's keepalive fallback that the original dial carried. */
  keepaliveIntervalSeconds?: number;
}

/** Why the server dials a saved tunnel on its own. */
type TunnelDial = 'autostart' | 'reconnect';

export interface ForwardManagerOptions {
  /** Saved tunnel definition, read again whenever a tunnel loses its connection. */
  tunnel?(id: string): TunnelRecord | undefined;
  /** Test seam; production uses {@link TUNNEL_RECONNECT_DELAYS_MS}. */
  reconnectDelaysMs?: readonly number[];
}

/**
 * SSH port forwards over live connections: local (-L), remote (-R) and
 * dynamic (-D, a minimal no-auth SOCKS5 CONNECT server). All listeners bind
 * 127.0.0.1 only — Muxus is a local single-user tool. The SSH engine carries
 * the bytes; this class decides which rules run on which connection.
 *
 * Saved tunnels can also be dialed without anyone at the keyboard: at
 * startup when they start with Muxus, and after a drop when they reconnect.
 * Those dials never prompt (agent, keys and vault passwords only). A
 * reconnecting tunnel keeps its entry while the connection is down: the
 * listener closes and the rule starts again on the new connection under the
 * same forward id.
 */
export class ForwardManager {
  private readonly forwards = new Map<string, ActiveForward>();
  /** Config forwards currently being created, keyed by connection and rule. */
  private readonly pendingConfigStarts = new Map<string, Promise<ForwardInfo>>();
  private readonly reconnectDelaysMs: readonly number[];

  constructor(
    private readonly connections: SshConnectionManager,
    private readonly log: FastifyBaseLogger,
    private readonly options: ForwardManagerOptions = {},
  ) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? TUNNEL_RECONNECT_DELAYS_MS;
  }

  list(connId?: string): ForwardInfo[] {
    return [...this.forwards.values()].map((f) => f.info).filter((f) => !connId || f.connId === connId);
  }

  async start(req: ForwardRequest, origin: ForwardInfo['origin'] = 'manual'): Promise<ForwardInfo> {
    if (req.type !== 'dynamic' && (!req.targetHost || !req.targetPort)) {
      throw new HttpProblem(400, 'targetHost and targetPort are required for local/remote forwards');
    }
    // Starting a tunnel by hand takes over from a dial the server is making for it.
    if (req.tunnelId) this.stopPending(req.tunnelId);
    const lease = this.connections.acquire(req.connId, 'forward');
    if (!lease) throw new HttpProblem(404, 'connection not found');
    const info: ForwardInfo = {
      id: nanoid(8),
      connId: req.connId,
      type: req.type,
      bindPort: req.bindPort,
      targetHost: req.targetHost,
      targetPort: req.targetPort,
      origin,
      lifecycle: req.tunnelId || req.independent ? 'independent' : 'session',
      status: 'active',
      tunnelId: req.tunnelId,
    };
    const entry: ActiveForward = { info, unbind: () => undefined, boundAt: 0, attempts: 0 };
    // Listed before the listener is up so a connection that closes while
    // binding still finds the entry it has to stop or redial.
    this.forwards.set(info.id, entry);
    try {
      await this.bind(entry, lease);
    } catch (err) {
      if (this.forwards.get(info.id) === entry) this.forwards.delete(info.id);
      throw err;
    }
    if (this.forwards.get(info.id) !== entry) {
      entry.unbind();
      throw new HttpProblem(409, 'the forward was stopped while it started');
    }
    return info;
  }

  /**
   * Start an ssh-config forward once per connection and rule. Every terminal
   * on a multiplexed transport runs its resolved config through this method,
   * so aliases can add distinct rules while repeated/concurrent sessions do
   * not race into duplicate listener binds.
   */
  async startConfig(req: ForwardRequest): Promise<{ info: ForwardInfo; started: boolean }> {
    const key = configForwardKey(req);
    const existing = [...this.forwards.values()].find(
      (active) =>
        active.info.origin === 'config' &&
        active.info.lifecycle === 'session' &&
        configForwardKey(active.info) === key,
    );
    if (existing) return { info: existing.info, started: false };

    const pending = this.pendingConfigStarts.get(key);
    if (pending) return { info: await pending, started: false };

    const start = this.start(req, 'config');
    this.pendingConfigStarts.set(key, start);
    try {
      return { info: await start, started: true };
    } finally {
      if (this.pendingConfigStarts.get(key) === start) this.pendingConfigStarts.delete(key);
    }
  }

  stop(id: string): void {
    const active = this.forwards.get(id);
    if (!active) return;
    this.forwards.delete(id);
    discard(active);
  }

  /** Adopt a running forward into a saved tunnel (no restart needed). */
  assignTunnel(id: string, tunnelId: string): ForwardInfo | undefined {
    const active = this.forwards.get(id);
    if (!active) return undefined;
    active.info.tunnelId = tunnelId;
    active.info.lifecycle = 'independent';
    return active.info;
  }

  /**
   * Start the saved tunnels marked to start with Muxus, without prompting.
   * Each shows as `starting` until its first connection is up.
   */
  autostart(tunnels: readonly TunnelRecord[]): void {
    const present = new Set(this.list().map((info) => info.tunnelId));
    for (const tunnel of tunnels) {
      if (!tunnel.autoStart || present.has(tunnel.id)) continue;
      const entry: ActiveForward = {
        info: {
          id: nanoid(8),
          connId: '',
          type: tunnel.type,
          bindPort: tunnel.bindPort,
          targetHost: tunnel.targetHost,
          targetPort: tunnel.targetPort,
          origin: 'manual',
          lifecycle: 'independent',
          status: 'starting',
          tunnelId: tunnel.id,
        },
        unbind: () => undefined,
        boundAt: 0,
        attempts: 0,
        // No window has supplied the preference yet; later redials keep this.
        keepaliveIntervalSeconds: DEFAULT_SSH_KEEPALIVE_INTERVAL_SECONDS,
      };
      this.forwards.set(entry.info.id, entry);
      void this.dial(entry, 'autostart');
    }
  }

  /**
   * Drop a pending start or redial that the saved tunnel no longer asks for,
   * or every one left behind by a deleted tunnel. Running forwards stay.
   */
  tunnelChanged(tunnelId: string): void {
    const tunnel = this.options.tunnel?.(tunnelId);
    for (const [id, active] of this.forwards) {
      if (active.info.tunnelId !== tunnelId || active.info.status === 'active') continue;
      const wanted =
        !!tunnel &&
        (active.info.status === 'error' ||
          (active.info.status === 'starting' ? tunnel.autoStart : tunnel.autoReconnect));
      if (!wanted) this.stop(id);
    }
  }

  /** Stop forwards owned by the terminal session while preserving saved/manual tunnels. */
  stopSessionForConnection(connId: string): void {
    for (const [id, active] of this.forwards) {
      if (active.info.connId === connId && active.info.lifecycle === 'session') {
        this.forwards.delete(id);
        discard(active);
      }
    }
  }

  stopAll(): void {
    for (const active of this.forwards.values()) discard(active);
    this.forwards.clear();
  }

  /** Bring the rule up on the lease's connection; the lease is released on failure. */
  private async bind(entry: ActiveForward, lease: ConnectionLease): Promise<void> {
    const conn = lease.connection;
    const { info } = entry;
    let stopTransport: () => void;
    try {
      stopTransport =
        info.type === 'local'
          ? await this.startLocal(conn, info)
          : info.type === 'dynamic'
            ? await this.startDynamic(conn, info)
            : await this.startRemote(conn, info);
    } catch (err) {
      lease.release();
      throw err;
    }

    let bound = true;
    let unsubscribe: () => void = () => undefined;
    entry.unbind = () => {
      if (!bound) return;
      bound = false;
      unsubscribe();
      try {
        stopTransport();
      } finally {
        lease.release();
      }
    };
    info.connId = conn.id;
    entry.boundAt = Date.now();
    entry.keepaliveIntervalSeconds = conn.profile.keepaliveIntervalSeconds;
    unsubscribe = conn.onClose((reason) => {
      if (bound) this.connectionLost(entry, reason);
    });
  }

  private connectionLost(entry: ActiveForward, reason?: string): void {
    entry.unbind();
    const { info } = entry;
    if (this.forwards.get(info.id) !== entry) return;
    if (!info.tunnelId || !this.options.tunnel?.(info.tunnelId)?.autoReconnect) {
      this.forwards.delete(info.id);
      return;
    }
    if (Date.now() - entry.boundAt >= TUNNEL_RECONNECT_STABLE_MS) entry.attempts = 0;
    this.log.info({ forward: info.id, tunnel: info.tunnelId, reason }, 'tunnel connection lost; reconnecting');
    this.scheduleReconnect(entry, reason ?? 'The SSH connection was lost.');
  }

  private scheduleReconnect(entry: ActiveForward, error: string): void {
    const delays = this.reconnectDelaysMs;
    const delay = delays[Math.min(entry.attempts, delays.length - 1)] ?? 0;
    entry.attempts += 1;
    entry.info.status = 'reconnecting';
    entry.info.error = error;
    const timer = setTimeout(() => void this.dial(entry, 'reconnect'), delay);
    entry.cancelReconnect = () => clearTimeout(timer);
  }

  /** Dial a saved tunnel without prompts and start its rule on the connection. */
  private async dial(entry: ActiveForward, why: TunnelDial): Promise<void> {
    let cancelled = false;
    entry.cancelReconnect = () => {
      cancelled = true;
    };
    const { info } = entry;
    const live = () => !cancelled && this.forwards.get(info.id) === entry;
    const tunnel = info.tunnelId ? this.options.tunnel?.(info.tunnelId) : undefined;
    if (!tunnel || !(why === 'autostart' ? tunnel.autoStart : tunnel.autoReconnect)) {
      // Deleted, or switched off while waiting.
      this.forwards.delete(info.id);
      return;
    }
    // The saved definition wins, just as when the tunnel is started again.
    info.type = tunnel.type;
    info.bindPort = tunnel.bindPort;
    info.targetHost = tunnel.targetHost;
    info.targetPort = tunnel.targetPort;

    // Nobody is there to answer: any prompt or host key question ends the
    // attempt, and only the user can take it from there.
    let needsUser = false;
    const io: ConnectIo = {
      status: () => undefined,
      prompt: () => {
        needsUser = true;
        return Promise.reject(new Error('authentication needs input'));
      },
      hostKey: () => {
        needsUser = true;
        return Promise.resolve(false);
      },
    };
    let lease: ConnectionLease;
    try {
      lease = await this.connections.connect(
        tunnelProfile(tunnel, entry.keepaliveIntervalSeconds),
        io,
        'forward',
      );
    } catch (err) {
      if (!live()) return;
      if (needsUser) {
        this.log.warn({ forward: info.id, tunnel: info.tunnelId, why }, 'tunnel dial needs user input; giving up');
        this.giveUp(entry, NEEDS_SIGN_IN);
        return;
      }
      this.retryOrGiveUp(entry, tunnel, err, why);
      return;
    }
    if (!live()) {
      lease.release();
      return;
    }
    try {
      await this.bind(entry, lease);
    } catch (err) {
      if (!live()) return;
      // A remote port can stay taken until the server notices the old
      // connection is gone, so a failed bind is worth another try too.
      this.retryOrGiveUp(entry, tunnel, err, why);
      return;
    }
    if (!live()) {
      entry.unbind();
      return;
    }
    entry.cancelReconnect = undefined;
    info.status = 'active';
    delete info.error;
    this.log.info({ forward: info.id, tunnel: info.tunnelId, connId: info.connId, why }, 'tunnel connected');
  }

  /** A tunnel that reconnects tries again, also after a failed start; others wait for the user. */
  private retryOrGiveUp(entry: ActiveForward, tunnel: TunnelRecord, err: unknown, why: TunnelDial): void {
    const { info } = entry;
    if (tunnel.autoReconnect) {
      this.log.info({ err, forward: info.id, tunnel: info.tunnelId, why }, 'tunnel dial failed; retrying');
      this.scheduleReconnect(entry, errorMessage(err));
      return;
    }
    this.log.warn({ err, forward: info.id, tunnel: info.tunnelId, why }, 'tunnel dial failed');
    this.giveUp(entry, errorMessage(err));
  }

  /** Keep the entry, with its reason, until the user starts or dismisses it. */
  private giveUp(entry: ActiveForward, error: string): void {
    entry.cancelReconnect = undefined;
    entry.info.status = 'error';
    entry.info.error = error;
  }

  /** Stop the tunnel's forwards that are starting, waiting to reconnect or gave up. */
  private stopPending(tunnelId: string): void {
    for (const [id, active] of this.forwards) {
      if (active.info.tunnelId === tunnelId && active.info.status !== 'active') this.stop(id);
    }
  }

  /** -L: listen locally; each client gets a direct-tcpip channel to the target. */
  private async startLocal(conn: ManagedConnection, info: ForwardInfo): Promise<() => void> {
    const listener = await conn.transport
      .forwardLocal(BIND_HOST, info.bindPort, info.targetHost!, info.targetPort!)
      .catch((err: unknown) => {
        throw listenProblem(info.bindPort, err);
      });
    info.bindPort = listener.port;
    // A client whose channel the server refuses is dropped; say why.
    const stopErrors = conn.transport.onForwardError((port, message) => {
      if (port === listener.port) this.log.warn({ err: message, forward: info.id }, 'forwardOut failed');
    });
    return () => {
      stopErrors();
      listener.close();
    };
  }

  /** -R: ask the server to listen; its connections are carried to the local target. */
  private async startRemote(conn: ManagedConnection, info: ForwardInfo): Promise<() => void> {
    const forward = await conn.transport
      .forwardRemote(BIND_HOST, info.bindPort, info.targetHost!, info.targetPort!)
      .catch((err: unknown) => {
        throw new HttpProblem(400, `remote bind failed: ${errorMessage(err)}`);
      });
    info.bindPort = forward.port;
    return () => {
      // The connection may already be gone, and the server's listener with it.
      forward.close().catch(() => undefined);
    };
  }

  /** -D: minimal SOCKS5 (no auth, CONNECT only) tunneling through the connection. */
  private async startDynamic(conn: ManagedConnection, info: ForwardInfo): Promise<() => void> {
    // Port 0 lets the system pick a free one (a web host's private proxy);
    // the forward then reports the port it got.
    const listener = await conn.transport.forwardDynamic(BIND_HOST, info.bindPort).catch((err: unknown) => {
      throw listenProblem(info.bindPort, err);
    });
    info.bindPort = listener.port;
    return () => listener.close();
  }
}

const BIND_HOST = '127.0.0.1';

/** A listener that could not be bound is the request's fault; a lost connection is not. */
function listenProblem(port: number, err: unknown): unknown {
  if (isSshError(err, 'DISCONNECTED')) return err;
  return new HttpProblem(400, `could not listen on ${BIND_HOST}:${port}: ${errorMessage(err)}`);
}

function discard(active: ActiveForward): void {
  active.cancelReconnect?.();
  active.unbind();
}

/** The dial a saved tunnel's start makes (see the client's dialConnection). */
function tunnelProfile(tunnel: TunnelRecord, keepaliveIntervalSeconds: number | undefined): SshProfile {
  return {
    kind: 'ssh',
    target: tunnel.target,
    ...(tunnel.sshOptions === undefined ? {} : { useConfig: false, ...tunnel.sshOptions }),
    ...(keepaliveIntervalSeconds === undefined ? {} : { keepaliveIntervalSeconds }),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configForwardKey(
  forward: Pick<ForwardRequest, 'connId' | 'type' | 'bindPort' | 'targetHost' | 'targetPort'>,
): string {
  return JSON.stringify([
    forward.connId,
    forward.type,
    forward.bindPort,
    forward.targetHost,
    forward.targetPort,
  ]);
}
