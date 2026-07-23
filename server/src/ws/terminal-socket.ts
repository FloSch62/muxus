import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { TerminalServerMessage } from '@muxus/shared';
import { terminalClientMessageSchema, type TerminalClientMessage } from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import type { ConnectIo } from '../ssh/connection-manager.js';
import { spawnLocalPty, DEFAULT_TERM } from '../local/pty-manager.js';

const CONNECT_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 30_000;
/** Pause the upstream when the browser socket buffers more than this. */
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 50;

/**
 * /ws/terminal — one socket per terminal tab. Binary frames are terminal
 * bytes both ways; text frames are JSON control (see shared/ws-protocol).
 * The first client frame must be `connect` (shell session) or `dial`
 * (shell-less SSH transport for tunnels); SSH connections may interleave
 * `auth-prompt`/`host-key` round-trips before `ready`.
 */
export function registerTerminalSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/terminal', { websocket: true }, (socket) => {
    void handleSession(socket, ctx, app).catch((err) => {
      app.log.warn({ err }, 'terminal session failed');
      sendControl(socket, { op: 'exit', code: 1, message: err instanceof Error ? err.message : String(err) });
      socket.close();
    });
  });
}

/** Control frames split from the binary stream, with a waiter for the auth round-trips. */
class ControlChannel {
  private waiters: Array<{
    resolve: (msg: TerminalClientMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  onMessage: ((msg: TerminalClientMessage) => void) | undefined;

  push(msg: TerminalClientMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(msg);
    else this.onMessage?.(msg);
  }

  /** Await the next control frame (connect / auth-response / host-key-response). */
  next(): Promise<TerminalClientMessage> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('connection closed');
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

async function handleSession(socket: WebSocket, ctx: AppContext, app: FastifyInstance): Promise<void> {
  const control = new ControlChannel();
  let writeInput: ((data: Buffer) => void) | undefined;
  let socketOpen = true;

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      writeInput?.(data);
      return;
    }
    try {
      const parsed = terminalClientMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
      if (parsed.success) control.push(parsed.data);
    } catch {
      // Non-JSON text frames are treated as input (some clients send text).
      writeInput?.(Buffer.from(data.toString('utf8'), 'utf8'));
    }
  });
  socket.on('close', () => {
    socketOpen = false;
    control.close();
  });

  let connectTimer: NodeJS.Timeout | undefined;
  const connectMsg = await Promise.race([
    control.next(),
    new Promise<never>((_resolve, reject) => {
      connectTimer = setTimeout(() => reject(new Error('timed out waiting for connect')), CONNECT_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(connectTimer));
  if (connectMsg.op !== 'connect' && connectMsg.op !== 'dial') {
    throw new Error(`expected connect or dial, got ${connectMsg.op}`);
  }
  if (!socketOpen) return;

  const keepalive = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
  }, KEEPALIVE_MS);
  socket.on('close', () => clearInterval(keepalive));

  const io: ConnectIo = {
    status: (message) => sendControl(socket, { op: 'status', message }),
    prompt: async (info) => {
      sendControl(socket, { op: 'auth-prompt', ...info });
      const reply = await control.next();
      if (reply.op !== 'auth-response') throw new Error('authentication cancelled');
      return reply.answers;
    },
    hostKey: async (challenge) => {
      sendControl(socket, { op: 'host-key', ...challenge });
      const reply = await control.next();
      return reply.op === 'host-key-response' && reply.accept;
    },
  };

  if (connectMsg.op === 'dial') {
    // Shell-less transport (`ssh -N`): the socket holds a dial lease so the
    // client can start forwards on the connId; once those hold their own
    // leases the socket closes and the transport lives on with them.
    const dialLease = await ctx.connections.connect(connectMsg.profile, io, 'dial');
    if (!socketOpen) {
      dialLease.release();
      return;
    }
    const conn = dialLease.connection;
    socket.once('close', () => dialLease.release());
    const unsubscribeDialClose = conn.onClose(() => {
      sendControl(socket, { op: 'exit', message: 'connection closed' });
      socket.close();
    });
    socket.once('close', () => unsubscribeDialClose());
    app.log.info({ target: connectMsg.profile.target, host: conn.host, user: conn.user, connId: conn.id }, 'ssh transport dialed');
    if (conn.metadataAlias) {
      try {
        ctx.database.recordOpenSshConnection(conn.metadataAlias);
      } catch (err) {
        app.log.warn({ err, target: conn.metadataAlias }, 'could not record recent connection');
      }
    }
    sendControl(socket, { op: 'ready', connId: conn.id, host: conn.host, user: conn.user });
    return;
  }

  const { profile, cols, rows } = connectMsg;
  if (profile.kind === 'local') {
    const { pty } = spawnLocalPty(profile, cols, rows);
    writeInput = (data) => pty.write(data.toString('utf8'));
    control.onMessage = (msg) => {
      if (msg.op === 'resize') pty.resize(msg.cols, msg.rows);
    };
    pty.onData((data) => {
      if (socket.readyState === socket.OPEN) socket.send(Buffer.from(data, 'utf8'), { binary: true });
    });
    pty.onExit(({ exitCode }) => {
      sendControl(socket, { op: 'exit', code: exitCode });
      socket.close();
    });
    socket.on('close', () => pty.kill());
    sendControl(socket, { op: 'ready', connId: `local-${process.pid}` });
    return;
  }

  // --- SSH ---
  const terminalLease = await ctx.connections.connect(profile, io);
  const conn = terminalLease.connection;

  // Forwards declared on the host in ssh config start with the session,
  // exactly like `ssh` honoring LocalForward/RemoteForward/DynamicForward.
  const configForwardIds: string[] = [];
  for (const fwd of conn.configForwards) {
    if (!socketOpen) break;
    try {
      const started = await ctx.forwards.start(
        {
          connId: conn.id,
          type: fwd.type,
          bindPort: fwd.bindPort,
          targetHost: fwd.targetHost,
          targetPort: fwd.targetPort,
        },
        'config',
      );
      configForwardIds.push(started.id);
    } catch (err) {
      sendControl(socket, { op: 'status', message: `forward -${fwd.type[0]?.toUpperCase()} ${fwd.bindPort} failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (!socketOpen) {
    // The tab disappeared before setup reached `ready`; do not leave
    // half-created config forwards running with no visible owning session.
    for (const id of configForwardIds) ctx.forwards.stop(id);
    terminalLease.release();
    return;
  }
  socket.once('close', () => terminalLease.release());

  const term = profile.term?.trim() || DEFAULT_TERM;
  const stream = await conn.shell(cols, rows, term);
  writeInput = (data) => stream.write(data);
  control.onMessage = (msg) => {
    if (msg.op === 'resize') stream.setWindow(msg.rows, msg.cols, 0, 0);
  };

  // Flow control: a runaway `cat hugefile` must not balloon the ws buffer.
  let paused = false;
  const resumeTimer = setInterval(() => {
    if (paused && socket.bufferedAmount < BACKPRESSURE_HIGH / 2) {
      paused = false;
      stream.resume();
    }
  }, BACKPRESSURE_POLL_MS);

  stream.on('data', (chunk: Buffer) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(chunk, { binary: true });
    if (!paused && socket.bufferedAmount > BACKPRESSURE_HIGH) {
      paused = true;
      stream.pause();
    }
  });
  let exitCode: number | undefined;
  stream.on('exit', (code: number | null) => {
    exitCode = code ?? undefined;
  });
  stream.on('close', () => {
    sendControl(socket, { op: 'exit', code: exitCode });
    socket.close();
  });
  const unsubscribeClose = conn.onClose(() => {
    sendControl(socket, { op: 'exit', message: 'connection closed' });
    socket.close();
  });
  socket.on('close', () => {
    clearInterval(resumeTimer);
    unsubscribeClose();
  });

  app.log.info({ target: profile.target, host: conn.host, user: conn.user, connId: conn.id }, 'ssh session established');
  if (conn.metadataAlias) {
    try {
      ctx.database.recordOpenSshConnection(conn.metadataAlias);
    } catch (err) {
      app.log.warn({ err, target: conn.metadataAlias }, 'could not record recent connection');
    }
  }
  sendControl(socket, { op: 'ready', connId: conn.id, host: conn.host, user: conn.user });
}

function sendControl(socket: WebSocket, msg: TerminalServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}
