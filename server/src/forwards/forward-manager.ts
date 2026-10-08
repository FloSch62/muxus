import net from 'node:net';
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
 * 127.0.0.1 only — Muxus is a local single-user tool.
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
  /** Connections whose remote 'tcp connection' dispatcher is installed. */
  private readonly remoteDispatch = new Map<string, Map<number, ForwardInfo>>();
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
      lifecycle: req.tunnelId ? 'independent' : 'session',
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
    this.remoteDispatch.clear();
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

  /** -L: listen locally, open a direct-tcpip channel per client. */
  private async startLocal(conn: ManagedConnection, info: ForwardInfo): Promise<() => void> {
    const server = net.createServer((socket) => {
      conn.client.forwardOut(socket.localAddress ?? '127.0.0.1', socket.localPort ?? 0, info.targetHost!, info.targetPort!, (err, stream) => {
        if (err) {
          this.log.warn({ err, forward: info.id }, 'forwardOut failed');
          socket.destroy();
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.on('error', () => socket.destroy());
        socket.on('error', () => stream.destroy());
      });
    });
    await listen(server, info.bindPort);
    return () => server.close();
  }

  /** -R: ask the server to listen; route incoming channels to the local target. */
  private async startRemote(conn: ManagedConnection, info: ForwardInfo): Promise<() => void> {
    let dispatch = this.remoteDispatch.get(conn.id);
    if (!dispatch) {
      dispatch = new Map();
      this.remoteDispatch.set(conn.id, dispatch);
      const routes = dispatch;
      conn.client.on('tcp connection', (details, accept, reject) => {
        const route = routes.get(details.destPort);
        if (!route) {
          reject();
          return;
        }
        const stream = accept();
        const socket = net.connect(route.targetPort!, route.targetHost!);
        socket.on('connect', () => {
          socket.pipe(stream).pipe(socket);
        });
        socket.on('error', () => stream.close());
        stream.on('error', () => socket.destroy());
        stream.on('close', () => socket.destroy());
      });
    }
    await new Promise<void>((resolve, reject) => {
      conn.client.forwardIn('127.0.0.1', info.bindPort, (err) => (err ? reject(new HttpProblem(400, `remote bind failed: ${err.message}`)) : resolve()));
    });
    dispatch.set(info.bindPort, info);
    return () => {
      dispatch.delete(info.bindPort);
      if (dispatch.size === 0) this.remoteDispatch.delete(conn.id);
      try {
        conn.client.unforwardIn('127.0.0.1', info.bindPort, () => {});
      } catch {
        // The connection is already gone, and the server's listener with it.
      }
    };
  }

  /** -D: minimal SOCKS5 (no auth, CONNECT only) tunneling through the connection. */
  private async startDynamic(conn: ManagedConnection, info: ForwardInfo): Promise<() => void> {
    const server = net.createServer((socket) => {
      socks5Connect(socket, (host, port, done) => {
        conn.client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port, (err, stream) => {
          if (err) {
            done(false);
            return;
          }
          done(true);
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
    });
    await listen(server, info.bindPort);
    return () => server.close();
  }
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

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new HttpProblem(400, `could not listen on 127.0.0.1:${port}: ${err.message}`)));
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

/**
 * Speak just enough SOCKS5 (RFC 1928) to serve browsers and CLIs: no-auth
 * negotiation, then a CONNECT request with IPv4/domain/IPv6 target.
 */
function socks5Connect(socket: net.Socket, open: (host: string, port: number, done: (ok: boolean) => void) => void): void {
  let buffer = Buffer.alloc(0);
  let stage: 'greeting' | 'request' = 'greeting';

  const fail = (code: number) => {
    // +----+-----+-------+------+----------+----------+ reply with the error
    // |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT | code, then hang up.
    socket.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  };

  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (stage === 'greeting') {
      if (buffer.length < 2) return;
      const nMethods = buffer[1]!;
      if (buffer.length < 2 + nMethods) return;
      if (buffer[0] !== 5) {
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([5, 0])); // no authentication
      buffer = buffer.subarray(2 + nMethods);
      stage = 'request';
    }
    if (stage === 'request') {
      if (buffer.length < 4) return;
      if (buffer[0] !== 5 || buffer[1] !== 1) {
        fail(7); // command not supported
        return;
      }
      const atyp = buffer[3]!;
      let host: string;
      let consumed: number;
      if (atyp === 1) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join('.');
        consumed = 10;
      } else if (atyp === 3) {
        if (buffer.length < 5) return;
        const len = buffer[4]!;
        if (buffer.length < 5 + len + 2) return;
        host = buffer.subarray(5, 5 + len).toString('utf8');
        consumed = 5 + len + 2;
      } else if (atyp === 4) {
        if (buffer.length < 22) return;
        const parts: string[] = [];
        for (let i = 4; i < 20; i += 2) parts.push(buffer.readUInt16BE(i).toString(16));
        host = parts.join(':');
        consumed = 22;
      } else {
        fail(8); // address type not supported
        return;
      }
      const port = buffer.readUInt16BE(consumed - 2);
      socket.removeListener('data', onData);
      const leftover = buffer.subarray(consumed);
      open(host, port, (ok) => {
        if (!ok || socket.destroyed) {
          fail(5); // connection refused
          return;
        }
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (leftover.length) socket.unshift(leftover);
      });
    }
  };

  socket.on('data', onData);
  socket.on('error', () => socket.destroy());
}
