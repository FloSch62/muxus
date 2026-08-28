import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import type { TerminalServerMessage } from '@muxus/shared';
import {
  TERMINAL_SESSION_CLOSE_REASON,
  terminalClientMessageSchema,
  type TerminalClientMessage,
} from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import type { ConnectIo } from '../ssh/connection-manager.js';
import {
  localShellPromptReady,
  localStartupInput,
  spawnLocalPty,
  DEFAULT_TERM,
} from '../local/pty-manager.js';
import { SerialTransport } from '../serial/serial-transport.js';
import { TelnetTransport } from '../telnet/telnet-transport.js';
import type { TerminalTransport } from '../transports/terminal-transport.js';
import {
  SessionRecorder,
  type SessionLoggingState,
} from '../session-logging/session-recorder.js';

const CONNECT_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 30_000;
/** Time for a renderer WebSocket to return after sleep or a network handoff. */
export const TERMINAL_REATTACH_GRACE_MS = 15_000;
/** Pause the upstream when the browser socket buffers more than this. */
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 50;

const REPLAYED_CONTROL_OPS = [
  'session',
  'status',
  'auth-prompt',
  'host-key',
  'ready',
  'logging-state',
  'connection-health',
] as const;
const replayedControlOps = new Set<string>(REPLAYED_CONTROL_OPS);

/**
 * Stable socket facade whose underlying browser socket can be replaced. The
 * terminal lifecycle listens to this facade's `close`, so swapping renderers
 * does not tear down the PTY, serial port, Telnet stream, or SSH channel.
 */
export class TransferableTerminalSocket extends EventEmitter {
  readonly OPEN = 1;
  private current: WebSocket;
  private closed = false;
  private detached = false;
  private detachTimer: NodeJS.Timeout | undefined;
  private readonly controls = new Map<string, string>();
  private bufferingTransfer = false;
  private bufferedTransferBytes = 0;
  private readonly transferBuffer: Buffer[] = [];

  constructor(
    readonly terminalId: string,
    socket: WebSocket,
    private readonly reattachGraceMs = TERMINAL_REATTACH_GRACE_MS,
  ) {
    super();
    this.current = socket;
    this.bind(socket);
  }

  get readyState(): number {
    // The facade remains writable while its renderer is detached. Binary
    // output is buffered below and control frames are replayed on attach.
    return this.closed ? 3 : this.OPEN;
  }

  get bufferedAmount(): number {
    return this.current.bufferedAmount + this.bufferedTransferBytes;
  }

  /** Feed the already-consumed first frame into the normal session handler. */
  push(data: Buffer, isBinary: boolean): void {
    this.handleMessage(data, isBinary);
  }

  /** Move this terminal to a new renderer without emitting lifecycle close. */
  attach(socket: WebSocket, cols: number, rows: number): boolean {
    if (this.closed) return false;
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = undefined;
    this.detached = false;
    const previous = this.current;
    this.unbind(previous);
    this.current = socket;
    this.bind(socket);
    if (previous.readyState === previous.OPEN) previous.close(1000, 'terminal transferred');
    for (const op of REPLAYED_CONTROL_OPS) {
      const frame = this.controls.get(op);
      if (frame && socket.readyState === socket.OPEN) socket.send(frame);
    }
    this.bufferingTransfer = false;
    this.flushTransferBuffer(socket);
    this.handleMessage(
      Buffer.from(JSON.stringify({ op: 'resize', cols, rows })),
      false,
    );
    return true;
  }

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data) as { op?: string };
        if (message.op && replayedControlOps.has(message.op)) {
          this.controls.set(message.op, data);
          if (message.op === 'ready') {
            this.controls.delete('status');
            this.controls.delete('auth-prompt');
            this.controls.delete('host-key');
          }
        }
      } catch {
        /* ordinary text frame */
      }
    }
    if (
      Buffer.isBuffer(data) &&
      options?.binary &&
      (this.bufferingTransfer || this.detached || this.current.readyState !== this.current.OPEN)
    ) {
      this.bufferTransferData(data);
      return;
    }
    if (this.current.readyState === this.current.OPEN) {
      if (options) this.current.send(data, options);
      else this.current.send(data);
    }
  }

  ping(): void {
    if (this.current.readyState === this.current.OPEN) this.current.ping();
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    const socket = this.current;
    this.finish();
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  }

  private readonly handleMessage = (data: Buffer, isBinary: boolean): void => {
    if (!isBinary) {
      try {
        const message = JSON.parse(data.toString('utf8')) as { op?: string };
        if (message.op === 'prepare-transfer') {
          this.bufferingTransfer = true;
          if (this.current.readyState === this.current.OPEN) {
            this.current.send(JSON.stringify({ op: 'transfer-ready' }));
          }
          return;
        }
        if (message.op === 'cancel-transfer') {
          this.bufferingTransfer = false;
          this.flushTransferBuffer(this.current);
          return;
        }
        if (message.op === 'auth-response') this.controls.delete('auth-prompt');
        if (message.op === 'host-key-response') this.controls.delete('host-key');
      } catch {
        /* terminal text input */
      }
    }
    this.emit('message', data, isBinary);
  };

  private readonly handleClose = (code: number, reason: Buffer): void => {
    if (this.closed || this.detached) return;
    if (code === 1000 && reason.toString('utf8') === TERMINAL_SESSION_CLOSE_REASON) {
      this.finish();
      return;
    }
    this.detached = true;
    if (this.reattachGraceMs <= 0) {
      this.finish();
      return;
    }
    this.detachTimer = setTimeout(() => {
      this.detachTimer = undefined;
      this.finish();
    }, this.reattachGraceMs);
    this.detachTimer.unref?.();
  };

  private bind(socket: WebSocket): void {
    socket.on('message', this.handleMessage);
    socket.once('close', this.handleClose);
  }

  private unbind(socket: WebSocket): void {
    socket.removeListener('message', this.handleMessage);
    socket.removeListener('close', this.handleClose);
  }

  private flushTransferBuffer(socket: WebSocket): void {
    const buffered = this.transferBuffer.splice(0);
    this.bufferedTransferBytes = 0;
    if (socket.readyState !== socket.OPEN) return;
    for (const data of buffered) socket.send(data, { binary: true });
  }

  /** Keep the newest bounded tail while no renderer can apply backpressure. */
  private bufferTransferData(data: Buffer): void {
    let buffered = Buffer.from(data);
    if (buffered.byteLength >= BACKPRESSURE_HIGH) {
      this.transferBuffer.length = 0;
      buffered = buffered.subarray(buffered.byteLength - BACKPRESSURE_HIGH);
      this.bufferedTransferBytes = 0;
    }
    while (
      this.transferBuffer.length > 0 &&
      this.bufferedTransferBytes + buffered.byteLength > BACKPRESSURE_HIGH
    ) {
      const removed = this.transferBuffer.shift()!;
      this.bufferedTransferBytes -= removed.byteLength;
    }
    this.transferBuffer.push(buffered);
    this.bufferedTransferBytes += buffered.byteLength;
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.detached = false;
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = undefined;
    this.transferBuffer.length = 0;
    this.bufferedTransferBytes = 0;
    this.unbind(this.current);
    this.emit('close');
  }
}

/**
 * /ws/terminal — one socket per terminal tab. Binary frames are terminal
 * bytes both ways; text frames are JSON control (see shared/ws-protocol).
 * The first client frame must be `connect` (shell session) or `dial`
 * (shell-less SSH transport for tunnels); SSH connections may interleave
 * `auth-prompt`/`host-key` round-trips before `ready`.
 */
export function registerTerminalSocket(
  app: FastifyInstance,
  ctx: AppContext,
  options: { reattachGraceMs?: number } = {},
): void {
  const sessions = new Map<string, TransferableTerminalSocket>();
  app.get('/ws/terminal', { websocket: true }, (socket) => {
    const timer = setTimeout(() => socket.close(1008, 'timed out waiting for connect'), CONNECT_TIMEOUT_MS);
    const firstMessage = (data: Buffer, isBinary: boolean): void => {
      clearTimeout(timer);
      socket.removeListener('message', firstMessage);
      if (isBinary) {
        socket.close(1008, 'expected connect or attach');
        return;
      }
      let first: TerminalClientMessage | undefined;
      try {
        const parsed = terminalClientMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
        if (parsed.success) first = parsed.data;
      } catch {
        /* rejected below */
      }
      if (!first || !['connect', 'dial', 'attach'].includes(first.op)) {
        socket.close(1008, 'expected connect or attach');
        return;
      }
      if (first.op === 'attach') {
        const session = sessions.get(first.terminalId);
        if (!session?.attach(socket, first.cols, first.rows)) {
          sendControl(socket, {
            op: 'exit',
            code: 1,
            message: 'The terminal session is no longer available.',
            reason: 'disconnected',
          });
          socket.close();
        }
        return;
      }

      const terminalId = `terminal-${nanoid(16)}`;
      const transferable = new TransferableTerminalSocket(
        terminalId,
        socket,
        options.reattachGraceMs,
      );
      sessions.set(terminalId, transferable);
      transferable.once('close', () => sessions.delete(terminalId));
      const stableSocket = transferable as unknown as WebSocket;
      void handleSession(stableSocket, ctx, app).catch((err) => {
        app.log.warn({ err }, 'terminal session failed');
        sendControl(stableSocket, {
          op: 'exit',
          code: 1,
          message: err instanceof Error ? err.message : String(err),
          reason: 'failed',
        });
        stableSocket.close();
      });
      transferable.push(data, false);
      sendControl(stableSocket, { op: 'session', terminalId });
    };
    socket.once('close', () => clearTimeout(timer));
    socket.on('message', firstMessage);
  });
}

/** Control frames split from the binary stream, with a waiter for the auth round-trips. */
class ControlChannel {
  private waiters: Array<{
    resolve: (msg: TerminalClientMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  intercept: ((msg: TerminalClientMessage) => boolean) | undefined;
  onMessage: ((msg: TerminalClientMessage) => void) | undefined;

  push(msg: TerminalClientMessage): void {
    if (this.intercept?.(msg)) return;
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
  let recorder: SessionRecorder | undefined;
  let socketOpen = true;

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (writeInput) recorder?.input(data);
      writeInput?.(data);
      return;
    }
    try {
      const parsed = terminalClientMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
      if (parsed.success) control.push(parsed.data);
    } catch {
      // Non-JSON text frames are treated as input (some clients send text).
      const input = Buffer.from(data.toString('utf8'), 'utf8');
      if (writeInput) recorder?.input(input);
      writeInput?.(input);
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
    status: (message, options) => {
      recorder?.system(message);
      sendControl(socket, { op: 'status', message, transient: options?.transient });
    },
    prompt: async (info) => {
      sendControl(socket, { op: 'auth-prompt', ...info });
      const reply = await control.next();
      if (reply.op !== 'auth-response') throw new Error('authentication cancelled');
      return {
        answers: reply.answers,
        rememberPassword: reply.rememberPassword,
        skipped: reply.skipped,
      };
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
    const profile = ctx.connections.resolveProfile(connectMsg.profile);
    const dialLease = await ctx.connections.connect(profile, io, 'dial');
    if (!socketOpen) {
      dialLease.release();
      return;
    }
    const conn = dialLease.connection;
    socket.once('close', () => dialLease.release());
    const unsubscribeDialClose = conn.onClose((reason) => {
      sendControl(socket, {
        op: 'exit',
        message: reason ?? 'The SSH transport closed unexpectedly.',
        reason: 'disconnected',
      });
      socket.close();
    });
    socket.once('close', () => unsubscribeDialClose());
    app.log.info({ target: profile.target, host: conn.host, user: conn.user, connId: conn.id, reused: dialLease.reused }, 'ssh transport dialed');
    if (conn.metadataAlias) {
      try {
        ctx.database.recordOpenSshConnection(conn.metadataAlias);
      } catch (err) {
        app.log.warn({ err, target: conn.metadataAlias }, 'could not record recent connection');
      }
    }
    // A dial client closes this socket as soon as it has handed the connection
    // to a forward. Finish any post-auth vault prompt first so closing the dial
    // lease cannot reject the prompt before the password is saved.
    await conn.waitForPostAuth();
    if (!socketOpen) {
      dialLease.release();
      return;
    }
    sendControl(socket, {
      op: 'ready',
      connId: conn.id,
      host: conn.host,
      user: conn.user,
      sftpAvailable: conn.sftpAvailable,
    });
    return;
  }

  const { cols, rows } = connectMsg;
  const profile =
    connectMsg.profile.kind === 'ssh'
      ? ctx.connections.resolveProfile(connectMsg.profile)
      : connectMsg.profile;
  recorder = SessionRecorder.start(
    ctx.database,
    ctx.history,
    app.log,
    profile,
    connectMsg.title,
  );
  const sendLoggingState = (state: SessionLoggingState = recorder.state) =>
    sendControl(socket, { op: 'logging-state', ...state });
  recorder.onStateChange(sendLoggingState);
  const handleLoggingControl = (msg: TerminalClientMessage): boolean => {
    if (msg.op !== 'set-logging') return false;
    sendLoggingState(
      recorder!.setState({
        enabled: msg.enabled,
        paused: msg.paused,
        captureInput: msg.captureInput,
      }),
    );
    return true;
  };
  control.intercept = handleLoggingControl;
  sendLoggingState();
  socket.once('close', () => recorder?.end('disconnected'));

  if (profile.kind === 'local') {
    const { pty } = spawnLocalPty(profile, cols, rows);
    let startupInput = localStartupInput(profile.startupCommand);
    let startupOutput = '';
    writeInput = (data) => pty.write(data.toString('utf8'));
    control.onMessage = (msg) => {
      if (handleLoggingControl(msg)) return;
      if (msg.op === 'resize') pty.resize(msg.cols, msg.rows);
    };
    pty.onData((data) => {
      recorder?.output(data);
      if (socket.readyState === socket.OPEN) socket.send(Buffer.from(data, 'utf8'), { binary: true });
      if (startupInput) {
        startupOutput = `${startupOutput}${data}`.slice(-8192);
        if (localShellPromptReady(startupOutput)) {
          const input = startupInput;
          startupInput = undefined;
          startupOutput = '';
          pty.write(input);
        }
      }
    });
    pty.onExit(({ exitCode }) => {
      recorder?.end('completed');
      sendControl(socket, { op: 'exit', code: exitCode, reason: 'completed' });
      socket.close();
    });
    socket.on('close', () => pty.kill());
    sendControl(socket, { op: 'ready', connId: `local-${process.pid}` });
    return;
  }

  if (profile.kind === 'serial') {
    io.status(`Opening ${profile.path} at ${profile.baudRate} baud …`, {
      transient: true,
    });
    const transport = await SerialTransport.connect(profile);
    if (!socketOpen) {
      transport.close();
      return;
    }
    attachTerminalTransport(
      socket,
      control,
      transport,
      (writer) => {
        writeInput = writer;
      },
      `serial-${nanoid(10)}`,
      recorder,
      handleLoggingControl,
    );
    app.log.info(
      { path: profile.path, baudRate: profile.baudRate },
      'serial session established',
    );
    if (profile.profileId) ctx.database.recordSavedHostConnection(profile.profileId);
    return;
  }

  if (profile.kind === 'telnet') {
    io.status(`Connecting to ${profile.host}:${profile.port} over Telnet …`, {
      transient: true,
    });
    const transport = await TelnetTransport.connect(profile, cols, rows);
    if (!socketOpen) {
      transport.close();
      return;
    }
    attachTerminalTransport(
      socket,
      control,
      transport,
      (writer) => {
        writeInput = writer;
      },
      `telnet-${nanoid(10)}`,
      recorder,
      handleLoggingControl,
    );
    app.log.info({ host: profile.host, port: profile.port }, 'telnet session established');
    if (profile.profileId) ctx.database.recordSavedHostConnection(profile.profileId);
    return;
  }

  // --- SSH ---
  const { lease: terminalLease, stream, transport } = await ctx.connections.connectShell(
    profile,
    io,
    cols,
    rows,
    DEFAULT_TERM,
    { freshTransport: connectMsg.freshTransport },
  );
  const conn = terminalLease.connection;
  // Session forwards belong to the terminal sessions using this transport;
  // stop them when the last terminal/dial lease leaves. Saved/manual tunnels
  // are marked independent and keep their own leases.
  const releaseSession = () => {
    // On a shared transport the connection (and the remote shell with it)
    // outlives this tab, so the channel must be closed explicitly.
    stream.close();
    terminalLease.release();
    if (ctx.connections.leaseCount(conn.id, ['terminal', 'dial']) === 0) {
      ctx.forwards.stopSessionForConnection(conn.id);
    }
  };
  if (!socketOpen) {
    releaseSession();
    return;
  }
  socket.once('close', releaseSession);
  const unsubscribeHealth = conn.onHealth((state) =>
    sendControl(socket, { op: 'connection-health', state }),
  );
  socket.once('close', () => unsubscribeHealth());

  // Every multiplexed alias contributes its resolved *Forward rules to the
  // shared transport. startConfig deduplicates rules already started by a
  // sibling session and collapses concurrent attempts for the same listener.
  const configForwardIds: string[] = [];
  for (const fwd of conn.configForwards) {
    if (!socketOpen) break;
    try {
      const started = await ctx.forwards.startConfig({
        connId: conn.id,
        type: fwd.type,
        bindPort: fwd.bindPort,
        targetHost: fwd.targetHost,
        targetPort: fwd.targetPort,
      });
      if (started.started) configForwardIds.push(started.info.id);
    } catch (err) {
      sendControl(socket, { op: 'status', message: `forward -${fwd.type[0]?.toUpperCase()} ${fwd.bindPort} failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (!socketOpen) {
    // The tab disappeared before setup reached `ready`; do not leave
    // half-created config forwards running with no visible owning session.
    // releaseSession already ran via the close handler.
    if (ctx.connections.leaseCount(conn.id, ['terminal', 'dial']) === 0) {
      for (const id of configForwardIds) ctx.forwards.stop(id);
    }
    return;
  }

  writeInput = (data) => stream.write(data);
  control.onMessage = (msg) => {
    if (handleLoggingControl(msg)) return;
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
    recorder?.output(chunk);
    if (socket.readyState !== socket.OPEN) return;
    socket.send(chunk, { binary: true });
    if (!paused && socket.bufferedAmount > BACKPRESSURE_HIGH) {
      paused = true;
      stream.pause();
    }
  });
  let exitCode: number | undefined;
  let receivedExit = false;
  stream.on('exit', (code: number | null) => {
    receivedExit = true;
    exitCode = code ?? undefined;
  });
  let finished = false;
  const finish = (
    reason: 'completed' | 'failed' | 'disconnected',
    message?: string,
  ) => {
    if (finished) return;
    finished = true;
    recorder?.end(
      reason === 'failed'
        ? 'failed'
        : reason === 'disconnected'
          ? 'disconnected'
          : 'completed',
    );
    sendControl(socket, { op: 'exit', code: exitCode, message, reason });
    socket.close();
  };
  stream.on('error', (error: Error) => finish('failed', error.message));
  stream.on('close', () =>
    receivedExit
      ? finish('completed')
      : finish('disconnected', 'The SSH channel closed without an exit status.'),
  );
  const unsubscribeClose = conn.onClose((reason) =>
    finish('disconnected', reason ?? 'The SSH transport closed unexpectedly.'),
  );
  socket.on('close', () => {
    clearInterval(resumeTimer);
    unsubscribeClose();
  });

  app.log.info({ target: profile.target, host: conn.host, user: conn.user, connId: conn.id, transport }, 'ssh session established');
  if (profile.profileId) {
    try {
      ctx.database.recordSavedHostConnection(profile.profileId);
    } catch (err) {
      app.log.warn({ err, profileId: profile.profileId }, 'could not record recent connection');
    }
  }
  if (conn.metadataAlias) {
    try {
      ctx.database.recordOpenSshConnection(conn.metadataAlias);
    } catch (err) {
      app.log.warn({ err, target: conn.metadataAlias }, 'could not record recent connection');
    }
  }
  sendControl(socket, {
    op: 'ready',
    connId: conn.id,
    host: conn.host,
    user: conn.user,
    sftpAvailable: conn.sftpAvailable,
  });
}

/** Attach a byte transport to the terminal socket with shared flow control. */
function attachTerminalTransport(
  socket: WebSocket,
  control: ControlChannel,
  transport: TerminalTransport,
  setWriteInput: (writer: (data: Buffer) => void) => void,
  connId: string,
  recorder: SessionRecorder,
  handleLoggingControl: (msg: TerminalClientMessage) => boolean,
): void {
  setWriteInput((data) => transport.write(data));
  control.onMessage = (msg) => {
    if (handleLoggingControl(msg)) return;
    if (msg.op === 'resize') transport.resize(msg.cols, msg.rows);
  };

  let paused = false;
  let closed = false;
  const resumeTimer = setInterval(() => {
    if (paused && socket.bufferedAmount < BACKPRESSURE_HIGH / 2) {
      paused = false;
      transport.resume();
    }
  }, BACKPRESSURE_POLL_MS);

  const unsubscribeData = transport.onData((data) => {
    recorder.output(data);
    if (socket.readyState !== socket.OPEN) return;
    socket.send(data, { binary: true });
    if (!paused && socket.bufferedAmount > BACKPRESSURE_HIGH) {
      paused = true;
      transport.pause();
    }
  });
  let finished = false;
  const finish = (
    reason: 'completed' | 'failed' | 'disconnected',
    message?: string,
  ) => {
    if (finished) return;
    finished = true;
    recorder.end(reason === 'failed' ? 'failed' : reason === 'disconnected' ? 'disconnected' : 'completed');
    sendControl(socket, { op: 'exit', message, reason });
    socket.close();
  };
  const unsubscribeError = transport.onError((error) => finish('failed', error.message));
  const unsubscribeClose = transport.onClose(() => finish('completed'));

  socket.once('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(resumeTimer);
    unsubscribeData();
    unsubscribeError();
    unsubscribeClose();
    transport.close();
  });
  sendControl(socket, { op: 'ready', connId });
}

function sendControl(socket: WebSocket, msg: TerminalServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}
