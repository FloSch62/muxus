import { Duplex, Readable, Writable } from 'node:stream';
import native from '@muxus/ssh-engine';
import type {
  AuthOutcome,
  ClientOptions,
  ForwardListener,
  Handshake,
  IncomingChannel,
  KeyboardPrompt,
  LocalStream,
  PtyRequest,
  RemoteForward,
  SftpAttrs,
  SftpSession,
  SshChannel as NativeChannel,
  SshClient as NativeClient,
  SshPrivateKey,
  SshTunnel,
  X11Request,
} from '@muxus/ssh-engine';

/**
 * The SSH engine as the rest of the server uses it. The engine itself is a
 * native addon on russh (see `engine/`): it speaks the protocol and carries
 * the bytes. What to trust, which login method to try and what to ask the
 * user is decided by the callers of this module.
 */

export type {
  AuthOutcome,
  ForwardListener,
  Handshake,
  IncomingChannel,
  KeyboardPrompt,
  LocalStream,
  PtyRequest,
  RemoteForward,
  SshPrivateKey,
  SshTunnel,
  X11Request,
};

/** Everything the engine reports by code rather than by wording. */
export type SshErrorCode =
  | 'ABORTED'
  | 'AGENT_CLOSED'
  | 'AGENT_FAILURE'
  | 'AGENT_PROTOCOL'
  | 'AGENT_TIMEOUT'
  | 'AGENT_UNAVAILABLE'
  | 'CHANNEL_CLOSED'
  | 'CHANNEL_OPEN_FAILED'
  | 'DISCONNECTED'
  | 'EXEC_REFUSED'
  | 'HOST_KEY_REJECTED'
  | 'KEEPALIVE_TIMEOUT'
  | 'KEY_ENCRYPTED'
  | 'KEY_INVALID'
  | 'NO_MATCHING_ALGORITHM'
  | 'PROXY_COMMAND'
  | 'PTY_REFUSED'
  | 'REMOTE_BIND_REFUSED'
  | 'SFTP_CLOSED'
  | 'SFTP_PROTOCOL'
  | 'SFTP_STATUS'
  | 'SFTP_UNSUPPORTED'
  | 'SHELL_REFUSED'
  | 'SIGN_FAILED'
  | 'SUBSYSTEM_REFUSED'
  | (string & {});

/**
 * A failure reported by the engine. `code` names it; `detail` is the number
 * that belongs to it: the SFTP status, or the server's reason for refusing a
 * channel.
 */
export class SshError extends Error {
  constructor(
    message: string,
    readonly code: SshErrorCode,
    readonly detail?: number,
  ) {
    super(message);
    this.name = 'SshError';
  }
}

const CODED = /^\[([A-Z0-9_]+)(?:#(\d+))?\] ([\s\S]*)$/;

/** The engine's `[CODE#detail] message` errors as {@link SshError}s. */
export function sshError(err: unknown): Error {
  if (err instanceof SshError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const match = CODED.exec(message);
  if (!match) return err instanceof Error ? err : new Error(message);
  return new SshError(match[3] ?? '', match[1] ?? '', match[2] === undefined ? undefined : Number(match[2]));
}

export function isSshError(err: unknown, ...codes: SshErrorCode[]): err is SshError {
  return err instanceof SshError && (codes.length === 0 || codes.includes(err.code));
}

async function coded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw sshError(err);
  }
}

/** SFTP status codes worth a name. */
export const SFTP_NO_SUCH_FILE = 2;
export const SFTP_OP_UNSUPPORTED = 8;

// ---------------------------------------------------------------------------
// Keys and agents
// ---------------------------------------------------------------------------

/**
 * Parse a private key file (OpenSSH, PEM or PuTTY). A protected key without
 * its passphrase fails with `KEY_ENCRYPTED`; anything else that cannot be
 * read, a wrong passphrase included, with `KEY_INVALID`.
 */
export function parsePrivateKey(content: Buffer, passphrase?: string): SshPrivateKey {
  try {
    return native.SshPrivateKey.parse(content, passphrase);
  } catch (err) {
    throw sshError(err);
  }
}

/** One identity an agent holds: a public key or certificate in SSH wire format. */
export interface AgentIdentity {
  blob: Buffer;
  comment: string;
}

/** Ask the agent at `endpoint` for its identities; `timeoutMs` 0 waits as long as it does. */
export function agentIdentities(endpoint: string, timeoutMs: number): Promise<AgentIdentity[]> {
  return coded(native.agentIdentities(endpoint, timeoutMs));
}

/** Ask the agent to sign; `flags` are the agent protocol's. Resolves with the SSH signature blob. */
export function agentSign(
  endpoint: string,
  blob: Buffer,
  data: Buffer,
  flags: number,
  timeoutMs: number,
): Promise<Buffer> {
  return coded(native.agentSign(endpoint, blob, data, flags, timeoutMs));
}

/** The engine's algorithm tables: offered by default, and negotiable on request. */
export function algorithmSupport() {
  return native.algorithmSupport();
}

/** A TCP connection on this computer's side that a channel can be joined to. */
export function connectLocalTcp(host: string, port: number, timeoutMs: number): Promise<LocalStream> {
  return coded(native.connectLocalTcp(host, port, timeoutMs));
}

/** A Unix socket (a leading NUL names a Linux abstract socket) or Windows pipe. */
export function connectLocalSocket(path: string, timeoutMs: number): Promise<LocalStream> {
  return coded(native.connectLocalSocket(path, timeoutMs));
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * A session or tunnel channel as a stream. Output is `data`, standard error
 * is on {@link stderr}, and `exit` carries the exit status (or `null` and the
 * signal name). `close` follows once the output has been read to its end.
 */
export class SshChannel extends Duplex {
  readonly stderr = new Readable({ read: () => this.wake() });
  private reading = false;
  private waiting = false;
  private remoteClosed = false;

  constructor(private readonly channel: NativeChannel) {
    super({ allowHalfOpen: true });
    this.pump();
  }

  /** Whether the server accepted X11 forwarding for this session. */
  get x11Forwarded(): boolean {
    return this.channel.x11Forwarded;
  }

  /** Tell the remote terminal its new size. */
  resize(cols: number, rows: number): void {
    this.channel.resize(cols, rows, 0, 0).catch(() => undefined);
  }

  /** Deliver a signal by name (`TERM`, `INT`, ...); not every server takes them. */
  signal(name: string): void {
    this.channel.signal(name).catch(() => undefined);
  }

  /** Close the channel. `close` is emitted once the server has confirmed it. */
  close(): void {
    this.channel.close().catch(() => undefined);
  }

  override _read(): void {
    this.wake();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.channel.write(chunk).then(
      () => callback(),
      (err: unknown) => callback(sshError(err)),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    // After the channel has closed there is nobody to tell.
    this.channel.eof().then(
      () => callback(),
      () => callback(),
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stderr.destroy();
    if (!this.remoteClosed) this.close();
    callback(error);
  }

  private wake(): void {
    if (!this.waiting) return;
    this.waiting = false;
    this.pump();
  }

  /** Hand the server's output to the streams, pausing while a reader is behind. */
  private pump(): void {
    if (this.reading) return;
    this.reading = true;
    void (async () => {
      try {
        for (;;) {
          const event = await this.channel.read();
          if (event.kind === 'data') {
            if (!this.push(event.data)) {
              this.waiting = true;
              return;
            }
          } else if (event.kind === 'stderr') {
            if (!this.stderr.push(event.data)) {
              this.waiting = true;
              return;
            }
          } else if (event.kind === 'exit') {
            this.emit('exit', event.code ?? null, event.signal);
          } else if (event.kind === 'close') {
            this.remoteClosed = true;
            this.stderr.push(null);
            this.push(null);
            if (!this.writableEnded) this.end();
            return;
          }
          // `eof` only says no more output follows; `close` ends the streams.
        }
      } catch (err) {
        this.destroy(sshError(err));
      } finally {
        this.reading = false;
      }
    })();
  }
}

export interface SessionOptions {
  pty?: PtyRequest;
  env?: Record<string, string>;
  x11?: X11Request;
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

/** File attributes as the server reports them, with the usual type tests. */
export interface SftpStats extends SftpAttrs {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SftpDirEntry {
  filename: string;
  longname: string;
  attrs: SftpStats;
}

const S_IFMT = 0o170000;

function stats(attrs: SftpAttrs): SftpStats {
  const type = (attrs.mode ?? 0) & S_IFMT;
  return {
    ...attrs,
    isDirectory: () => type === 0o040000,
    isFile: () => type === 0o100000,
    isSymbolicLink: () => type === 0o120000,
  };
}

/** How a file is opened, as in `fs.open`. */
export type SftpOpenFlags = 'r' | 'r+' | 'w' | 'wx' | 'a';

const OPEN_FLAGS: Record<SftpOpenFlags, number> = {
  r: 0x01,
  'r+': 0x01 | 0x02,
  w: 0x02 | 0x08 | 0x10,
  wx: 0x02 | 0x08 | 0x10 | 0x20,
  a: 0x02 | 0x04 | 0x08,
};

/**
 * An SFTP session over an SSH connection, or over the standard streams of a
 * program (see {@link spawnSftp}). Failures carry the `SFTP_STATUS` code and
 * the server's status number in `detail`.
 */
export class SftpClient {
  constructor(private readonly session: SftpSession) {}

  get closed(): boolean {
    return this.session.closed;
  }

  /** Call `listener` once when the session ends. */
  onClose(listener: () => void): void {
    this.session.onClose(listener);
  }

  close(): void {
    this.session.close();
  }

  realpath(path: string): Promise<string> {
    return coded(this.session.realpath(path));
  }

  async stat(path: string): Promise<SftpStats> {
    return stats(await coded(this.session.stat(path)));
  }

  async lstat(path: string): Promise<SftpStats> {
    return stats(await coded(this.session.lstat(path)));
  }

  async fstat(handle: Buffer): Promise<SftpStats> {
    return stats(await coded(this.session.fstat(handle)));
  }

  /** `mode` is asked of the server, whose umask may narrow it. */
  open(path: string, flags: SftpOpenFlags, mode?: number): Promise<Buffer> {
    return coded(this.session.open(path, OPEN_FLAGS[flags], mode === undefined ? undefined : { mode }));
  }

  closeHandle(handle: Buffer): Promise<void> {
    return coded(this.session.closeHandle(handle));
  }

  /** Give an open file exactly these permission bits, whatever the umask. */
  fchmod(handle: Buffer, mode: number): Promise<void> {
    return coded(this.session.fsetstat(handle, { mode }));
  }

  /** Up to `length` bytes at `offset`; `undefined` at the end of the file. */
  async read(handle: Buffer, offset: number, length: number): Promise<Buffer | undefined> {
    return (await coded(this.session.read(handle, offset, length))) ?? undefined;
  }

  async readdir(path: string): Promise<SftpDirEntry[]> {
    const entries = await coded(this.session.readdir(path));
    return entries.map((entry) => ({
      filename: entry.name,
      longname: entry.longname,
      attrs: stats(entry.attrs),
    }));
  }

  mkdir(path: string, mode?: number): Promise<void> {
    return coded(this.session.mkdir(path, mode === undefined ? undefined : { mode }));
  }

  rmdir(path: string): Promise<void> {
    return coded(this.session.rmdir(path));
  }

  unlink(path: string): Promise<void> {
    return coded(this.session.remove(path));
  }

  /** The protocol's own rename, which most servers refuse onto an existing name. */
  rename(from: string, to: string): Promise<void> {
    return coded(this.session.rename(from, to));
  }

  /**
   * OpenSSH's atomic rename over an existing name; `SFTP_UNSUPPORTED` on a
   * server without it.
   */
  posixRename(from: string, to: string): Promise<void> {
    return coded(this.session.posixRename(from, to));
  }

  /** Replace a file's content, creating it with `mode` when it is new. */
  async writeFile(path: string, content: string | Buffer, mode?: number): Promise<void> {
    const handle = await this.open(path, 'w', mode);
    try {
      const writer = this.session.writer(handle, 0);
      await coded(writer.write(Buffer.isBuffer(content) ? content : Buffer.from(content)));
      await coded(writer.finish());
    } finally {
      await this.closeHandle(handle).catch(() => undefined);
    }
  }

  /**
   * Read an open file from `start` to its end. The reads travel ahead of
   * their replies. The handle is closed with the stream unless `autoClose`
   * is false.
   */
  createReadStream(handle: Buffer, options: { start?: number; autoClose?: boolean } = {}): Readable {
    const reader = this.session.reader(handle, options.start ?? 0);
    const autoClose = options.autoClose ?? true;
    let reading = false;
    return new Readable({
      read() {
        if (reading) return;
        reading = true;
        reader.read().then(
          (chunk) => {
            reading = false;
            this.push(chunk);
          },
          (err: unknown) => {
            reading = false;
            this.destroy(sshError(err));
          },
        );
      },
      destroy: (error, callback) => {
        if (!autoClose) return callback(error);
        this.closeHandle(handle).then(
          () => callback(error),
          () => callback(error),
        );
      },
    });
  }

  /**
   * Write an open file from `start` on. The writes travel ahead of their
   * replies; the stream finishes once the server has taken all of them. The
   * handle is closed with the stream unless `autoClose` is false.
   */
  createWriteStream(handle: Buffer, options: { start?: number; autoClose?: boolean } = {}): Writable {
    const writer = this.session.writer(handle, options.start ?? 0);
    const autoClose = options.autoClose ?? true;
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writer.write(chunk).then(
          () => callback(),
          (err: unknown) => callback(sshError(err)),
        );
      },
      final(callback) {
        writer.finish().then(
          () => callback(),
          (err: unknown) => callback(sshError(err)),
        );
      },
      destroy: (error, callback) => {
        if (!autoClose) return callback(error);
        this.closeHandle(handle).then(
          () => callback(error),
          () => callback(error),
        );
      },
    });
  }
}

/**
 * Run a program and speak SFTP over its standard streams, as `ssh -s host
 * sftp` offers. The program is ended with the session; when it ends before
 * the session is ready, what it said on stderr is the error.
 */
export async function spawnSftp(
  file: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  startTimeoutMs: number,
): Promise<SftpClient> {
  const variables = Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [{ name, value }]));
  return new SftpClient(await coded(native.spawnSftp(file, [...args], variables, startTimeoutMs)));
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type TransportHealth = 'healthy' | 'suspect';

export interface TransportOptions extends ClientOptions {
  /** Decide whether the server's host key (SSH wire format) is trusted. */
  verifyHostKey(key: Buffer): Promise<boolean>;
  /** The server's banner, shown before the login. */
  onBanner?(message: string): void;
  /** A hop of another connection to run over, instead of dialing the host. */
  tunnel?: SshTunnel;
}

/** One answer of a keyboard-interactive exchange. */
export type KeyboardResponder = (
  name: string,
  instructions: string,
  prompts: KeyboardPrompt[],
) => Promise<string[]>;

/**
 * One SSH connection: reach the host, log in step by step, then open
 * channels on it. Every step that can fail rejects with an {@link SshError}.
 */
export class SshTransport {
  private readonly client: NativeClient;
  private readonly closeListeners = new Set<(reason?: string) => void>();
  private readonly healthListeners = new Set<(state: TransportHealth) => void>();
  private readonly forwardErrorListeners = new Set<(port: number, message: string) => void>();
  private state: 'open' | 'closing' | 'closed' = 'open';
  private closeReason: string | undefined;
  private health: TransportHealth = 'healthy';
  /** What the key exchange settled on; set once {@link connect} resolves. */
  handshake: Handshake = {};

  constructor(options: TransportOptions) {
    const clientOptions: ClientOptions = { ...options };
    for (const key of ['verifyHostKey', 'onBanner', 'tunnel'] as const) {
      delete (clientOptions as Partial<TransportOptions>)[key];
    }
    this.client = new native.SshClient(
      clientOptions,
      // A verdict that fails is a "no".
      (key) => options.verifyHostKey(key).catch(() => false),
      (event) => {
        if (event.kind === 'banner') options.onBanner?.(event.message ?? '');
        else if (event.kind === 'health') this.setHealth(event.suspect ? 'suspect' : 'healthy');
        else if (event.kind === 'forward-error') {
          for (const listener of this.forwardErrorListeners) listener(event.port ?? 0, sshError(new Error(event.message)).message);
        } else if (event.kind === 'close') this.finish(event.message);
      },
    );
    if (options.tunnel) this.client.useTunnel(options.tunnel);
  }

  /** Reach the host and exchange keys. {@link close} gives the attempt up. */
  async connect(): Promise<Handshake> {
    this.handshake = await coded(this.client.connect());
    return this.handshake;
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  /** Current passive keepalive health. */
  healthState(): TransportHealth {
    return this.health;
  }

  /** End the connection, or the attempt to make it. */
  close(): void {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.client.close().catch(() => undefined);
  }

  /** Hear when the connection ends, with the reason when one is known. */
  onClose(listener: (reason?: string) => void): () => void {
    if (this.state === 'closed') {
      queueMicrotask(() => listener(this.closeReason));
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onHealth(listener: (state: TransportHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /** Hear about connections to a local forward that the server refused to carry. */
  onForwardError(listener: (port: number, message: string) => void): () => void {
    this.forwardErrorListeners.add(listener);
    return () => this.forwardErrorListeners.delete(listener);
  }

  // --- login -------------------------------------------------------------

  authNone(user: string): Promise<AuthOutcome> {
    return coded(this.client.authNone(user));
  }

  authPassword(user: string, password: string): Promise<AuthOutcome> {
    return coded(this.client.authPassword(user, password));
  }

  /**
   * The RSA signature hash to use: the best the server said it takes, and
   * SHA-1 (plain ssh-rsa) for a server that said nothing, as old devices do.
   */
  async rsaHash(): Promise<'sha512' | 'sha256' | 'sha1'> {
    const hash = await coded(this.client.rsaHash());
    return hash === 'sha512' || hash === 'sha256' ? hash : 'sha1';
  }

  authPublicKey(user: string, key: SshPrivateKey, rsaHash?: string): Promise<AuthOutcome> {
    return coded(this.client.authPublicKey(user, key, rsaHash));
  }

  /** Log in with an OpenSSH certificate (SSH wire format) and the key it certifies. */
  authCertificate(user: string, key: SshPrivateKey, certificate: Buffer, rsaHash?: string): Promise<AuthOutcome> {
    return coded(this.client.authCertificate(user, key, certificate, rsaHash));
  }

  /**
   * Log in with an identity whose private half signs elsewhere (an agent, a
   * security key). `sign` runs once the server accepts the identity; when it
   * rejects, this rejects with `SIGN_FAILED` and the connection is ready for
   * the next method.
   */
  authSigner(
    user: string,
    identity: Buffer,
    rsaHash: string | undefined,
    sign: (data: Buffer) => Promise<Buffer>,
  ): Promise<AuthOutcome> {
    return coded(this.client.authSigner(user, identity, rsaHash, sign));
  }

  /** Keyboard-interactive: `respond` answers each round of questions. */
  async authKeyboardInteractive(user: string, respond: KeyboardResponder): Promise<AuthOutcome> {
    let step = await coded(this.client.authKeyboardStart(user));
    while (!step.outcome) {
      const prompts = step.prompts ?? [];
      // A round without questions (PAM ends a password login with one) has nothing to ask.
      const answers = prompts.length === 0 ? [] : await respond(step.name ?? '', step.instructions ?? '', prompts);
      step = await coded(this.client.authKeyboardRespond(answers));
    }
    return step.outcome;
  }

  // --- channels ----------------------------------------------------------

  /** Run a command. Fails with `EXEC_REFUSED` when the server will not. */
  async exec(command: string, options: SessionOptions = {}): Promise<SshChannel> {
    return this.session({ ...options, command });
  }

  /** Start the login shell. */
  async shell(options: SessionOptions = {}): Promise<SshChannel> {
    return this.session(options);
  }

  /** Start a subsystem such as `netconf`. */
  async subsystem(name: string): Promise<SshChannel> {
    return this.session({ subsystem: name });
  }

  private async session(
    request: SessionOptions & { command?: string; subsystem?: string },
  ): Promise<SshChannel> {
    const { env, ...rest } = request;
    const channel = await coded(
      this.client.openSession({
        ...rest,
        ...(env ? { env: Object.entries(env).map(([name, value]) => ({ name, value })) } : {}),
      }),
    );
    return new SshChannel(channel);
  }

  /** A channel to `host:port`, resolved and dialed on the server's side. */
  async openTcp(host: string, port: number, origin: { host: string; port: number } = { host: '127.0.0.1', port: 0 }): Promise<SshChannel> {
    return new SshChannel(await coded(this.client.openDirectTcpip(host, port, origin.host, origin.port)));
  }

  /** A channel to `host:port` for another connection to run over (`ssh -W`). */
  openTunnel(host: string, port: number): Promise<SshTunnel> {
    return coded(this.client.openTunnel(host, port));
  }

  async sftp(): Promise<SftpClient> {
    return new SftpClient(await coded(this.client.openSftp()));
  }

  /** Hear about X11 connections the server forwards; without a handler they are refused. */
  onX11(handler: (incoming: IncomingChannel) => void): void {
    this.client.onX11(handler);
  }

  // --- forwards ----------------------------------------------------------

  /** Listen locally and carry each connection to `targetHost:targetPort` from the server. */
  forwardLocal(bindHost: string, bindPort: number, targetHost: string, targetPort: number): Promise<ForwardListener> {
    return coded(this.client.forwardLocal(bindHost, bindPort, targetHost, targetPort));
  }

  /** Listen locally as a SOCKS5 proxy whose connections leave from the server. */
  forwardDynamic(bindHost: string, bindPort: number): Promise<ForwardListener> {
    return coded(this.client.forwardDynamic(bindHost, bindPort));
  }

  /** Have the server listen and carry each connection to `targetHost:targetPort` on this side. */
  forwardRemote(bindHost: string, bindPort: number, targetHost: string, targetPort: number): Promise<RemoteForward> {
    return coded(this.client.forwardRemote(bindHost, bindPort, targetHost, targetPort));
  }

  private setHealth(state: TransportHealth): void {
    if (state === this.health) return;
    this.health = state;
    for (const listener of this.healthListeners) listener(state);
  }

  private finish(reason?: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeReason = reason || undefined;
    for (const listener of this.closeListeners) listener(this.closeReason);
    this.closeListeners.clear();
    this.healthListeners.clear();
    this.forwardErrorListeners.clear();
  }
}

/** Accept a connection the server opened towards us as a native channel. */
export async function acceptIncoming(incoming: IncomingChannel): Promise<NativeChannel> {
  return coded(incoming.accept());
}

/** Read from a native channel until `enough` says so; `undefined` when it closes first. */
export async function readUntil(
  channel: NativeChannel,
  enough: (received: Buffer) => boolean,
): Promise<Buffer | undefined> {
  let received: Buffer = Buffer.alloc(0);
  for (;;) {
    const event = await coded(channel.read());
    if (event.kind === 'close' || event.kind === 'eof') return undefined;
    if (event.kind !== 'data' || !event.data) continue;
    received = received.length ? Buffer.concat([received, event.data]) : event.data;
    if (enough(received)) return received;
  }
}

/** Join a native channel to a local stream until either ends; `head` goes to the local side first. */
export function splice(channel: NativeChannel, local: LocalStream, head?: Buffer): Promise<void> {
  return coded(channel.splice(local, head));
}

export type { NativeChannel };
