import net from 'node:net';
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import type { ForwardInfo, ForwardRequest } from '@muxus/shared';
import type { SshConnectionManager, ManagedConnection } from '../ssh/connection-manager.js';
import { HttpProblem } from '../util/errors.js';

interface ActiveForward {
  info: ForwardInfo;
  stop(): void;
}

/**
 * SSH port forwards over live connections: local (-L), remote (-R) and
 * dynamic (-D, a minimal no-auth SOCKS5 CONNECT server). All listeners bind
 * 127.0.0.1 only — Muxus is a local single-user tool.
 */
export class ForwardManager {
  private readonly forwards = new Map<string, ActiveForward>();
  /** Connections whose remote 'tcp connection' dispatcher is installed. */
  private readonly remoteDispatch = new Map<string, Map<number, ForwardInfo>>();

  constructor(
    private readonly connections: SshConnectionManager,
    private readonly log: FastifyBaseLogger,
  ) {}

  list(connId?: string): ForwardInfo[] {
    return [...this.forwards.values()].map((f) => f.info).filter((f) => !connId || f.connId === connId);
  }

  async start(req: ForwardRequest): Promise<ForwardInfo> {
    const conn = this.connections.get(req.connId);
    if (!conn) throw new HttpProblem(404, 'connection not found (terminal closed?)');
    if (req.type !== 'dynamic' && (!req.targetHost || !req.targetPort)) {
      throw new HttpProblem(400, 'targetHost and targetPort are required for local/remote forwards');
    }
    const info: ForwardInfo = {
      id: nanoid(8),
      connId: req.connId,
      type: req.type,
      bindPort: req.bindPort,
      targetHost: req.targetHost,
      targetPort: req.targetPort,
      status: 'active',
    };
    const stop =
      req.type === 'local'
        ? await this.startLocal(conn, info)
        : req.type === 'dynamic'
          ? await this.startDynamic(conn, info)
          : await this.startRemote(conn, info);
    this.forwards.set(info.id, { info, stop });
    return info;
  }

  stop(id: string): void {
    const active = this.forwards.get(id);
    if (!active) return;
    this.forwards.delete(id);
    active.stop();
  }

  stopForConnection(connId: string): void {
    for (const [id, active] of this.forwards) {
      if (active.info.connId === connId) {
        this.forwards.delete(id);
        active.stop();
      }
    }
    this.remoteDispatch.delete(connId);
  }

  stopAll(): void {
    for (const active of this.forwards.values()) active.stop();
    this.forwards.clear();
    this.remoteDispatch.clear();
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
      conn.client.unforwardIn('127.0.0.1', info.bindPort, () => {});
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
