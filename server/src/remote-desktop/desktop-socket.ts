import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createWebSocketStream, type WebSocket } from 'ws';
import type {
  AuthPromptInfo,
  AuthPromptResponse,
  DesktopClientMessage,
  DesktopCredentials,
  DesktopProfile,
  DesktopServerMessage,
  SshProfile,
} from '@muxus/shared';
import {
  DESKTOP_RDP_WS_PATH,
  DESKTOP_TICKET_PROTOCOL_PREFIX,
  DESKTOP_VNC_WS_PATH,
  desktopClientMessageSchema,
} from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import type { ConnectIo, MuxedConnectionLease } from '../ssh/connection-manager.js';
import {
  desktopPasswordAccount,
  desktopPasswordLabel,
  type DesktopPasswordTarget,
} from '../security/password-vault.js';
import { certificateChallenge, type PresentedCertificate } from './certificates.js';
import { DesktopPasswords, type VaultPasswordRef } from './desktop-passwords.js';
import { serveRdpCleanPath, type RdpStreamTarget } from './rdp-proxy.js';

const CONNECT_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 30_000;
const TICKET_TTL_MS = 60_000;
const TCP_CONNECT_TIMEOUT_MS = 15_000;

type ClientReply<Op extends DesktopClientMessage['op']> = Extract<DesktopClientMessage, { op: Op }>;
type ResponseOp = 'auth-response' | 'host-key-response' | 'certificate-response';

function send(socket: WebSocket, message: DesktopServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/** Single-use, short-lived capabilities that bind a stream socket to its tab's session. */
export class DesktopTickets {
  private readonly tickets = new Map<
    string,
    { session: DesktopSession; protocol: DesktopProfile['kind']; expires: number }
  >();

  constructor(private readonly ttlMs = TICKET_TTL_MS) {}

  issue(session: DesktopSession, protocol: DesktopProfile['kind']): string {
    const now = Date.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
    const id = nanoid(32);
    this.tickets.set(id, { session, protocol, expires: now + this.ttlMs });
    return id;
  }

  redeem(id: string, protocol: DesktopProfile['kind']): DesktopSession | undefined {
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);
    if (!ticket || ticket.protocol !== protocol || ticket.expires <= Date.now()) return undefined;
    return ticket.session.closed ? undefined : ticket.session;
  }
}

/** Give an SSH channel-open failure the errno a direct socket would have reported. */
function channelOpenError(err: Error): Error {
  const reason = (err as { reason?: number }).reason;
  const code =
    /refused/i.test(err.message) ? 'ECONNREFUSED'
    : /timed? ?out/i.test(err.message) ? 'ETIMEDOUT'
    : /resolve|not known|no such host/i.test(err.message) ? 'ENOTFOUND'
    : reason === 1 ? 'EACCES'
    : undefined;
  return Object.assign(new Error(`The SSH gateway could not open the connection: ${err.message}`), {
    code,
  });
}

/** A connect failure as one sentence (WebSocket close reasons cap at 123 bytes). */
export function connectFailureMessage(err: unknown): string {
  switch ((err as NodeJS.ErrnoException | undefined)?.code) {
    case 'ECONNREFUSED':
      return 'The remote computer refused the connection. Check the port and that the server runs.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The host name could not be resolved.';
    case 'ETIMEDOUT':
      return 'The connection timed out.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'The remote computer is unreachable.';
    case 'EACCES':
      return 'The SSH gateway is not allowed to open this connection.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`Timed out connecting to ${host}:${port}`), { code: 'ETIMEDOUT' }));
    }, TCP_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      // Pointer and key events are tiny; do not let Nagle hold them back.
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      resolve(socket);
    });
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once('error', onError);
  });
}

/**
 * One RDP or VNC tab. Owns the control socket, the optional SSH gateway lease,
 * the credentials in use, and every stream socket its tickets opened.
 */
export class DesktopSession {
  closed = false;
  private profile: DesktopProfile | undefined;
  private gateway: MuxedConnectionLease | undefined;
  private credentials: DesktopCredentials = {};
  /** The password in use came from the vault (so a rejection means it is stale). */
  private usedSavedPassword = false;
  /** A VNC server rejected the last credentials; ask instead of using the vault. */
  private vncRejected = false;
  private rememberCandidate: (VaultPasswordRef & { password: string; username?: string }) | undefined;
  private recorded = false;
  private readonly waiters = new Map<ResponseOp, { resolve: (msg: DesktopClientMessage) => void; reject: (err: Error) => void }>();
  private readonly aborts = new Set<(reason: string) => void>();
  private queue: Promise<void> = Promise.resolve();
  private readonly passwords: DesktopPasswords;

  constructor(
    private readonly socket: WebSocket,
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
    private readonly tickets: DesktopTickets,
  ) {
    this.passwords = new DesktopPasswords(ctx.vault, {
      status: (message, options) => this.status(message, options?.transient),
      prompt: (info) => this.prompt(info),
    });
  }

  start(): void {
    const connectTimer = setTimeout(() => {
      if (!this.profile) this.socket.close(1008, 'timed out waiting for connect');
    }, CONNECT_TIMEOUT_MS);
    const keepalive = setInterval(() => {
      if (this.socket.readyState === this.socket.OPEN) this.socket.ping();
    }, KEEPALIVE_MS);
    this.socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let message: DesktopClientMessage;
      try {
        const parsed = desktopClientMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
        if (!parsed.success) return;
        message = parsed.data;
      } catch {
        return;
      }
      this.dispatch(message);
    });
    this.socket.once('close', () => {
      clearTimeout(connectTimer);
      clearInterval(keepalive);
      this.close('the tab was closed');
    });
  }

  private dispatch(message: DesktopClientMessage): void {
    switch (message.op) {
      case 'auth-response':
      case 'host-key-response':
      case 'certificate-response': {
        const waiter = this.waiters.get(message.op);
        this.waiters.delete(message.op);
        waiter?.resolve(message);
        return;
      }
      case 'connect':
        if (this.profile) return;
        this.profile = message.profile;
        this.enqueue(() => this.connect(message.profile));
        return;
      case 'retry':
        this.enqueue(() => this.retry(message.rejected === true));
        return;
      case 'credentials-request':
        this.enqueue(() => this.provideVncCredentials(message.types));
        return;
      case 'connected':
        this.enqueue(() => this.loginSucceeded());
        return;
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => this.fail(err));
  }

  private expect<Op extends ResponseOp>(op: Op): Promise<ClientReply<Op>> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    this.waiters.get(op)?.reject(new Error('superseded'));
    return new Promise((resolve, reject) => {
      this.waiters.set(op, { resolve: resolve as (msg: DesktopClientMessage) => void, reject });
    });
  }

  private status(message: string, transient?: boolean): void {
    send(this.socket, { op: 'status', message, transient });
  }

  private async prompt(info: AuthPromptInfo): Promise<AuthPromptResponse> {
    const reply = this.expect('auth-response');
    send(this.socket, { op: 'auth-prompt', ...info });
    const { answers, rememberPassword, skipped } = await reply;
    return { answers, rememberPassword, skipped };
  }

  private fail(err: unknown): void {
    if (this.closed) return;
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn({ err: message, host: this.profile?.host }, 'remote desktop session failed');
    send(this.socket, { op: 'exit', message, reason: 'failed' });
    this.socket.close();
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.values()) waiter.reject(new Error('connection closed'));
    this.waiters.clear();
    for (const abort of this.aborts) abort(reason);
    this.aborts.clear();
    this.gateway?.release();
    this.gateway = undefined;
    this.rememberCandidate = undefined;
    this.credentials = {};
  }

  /** Saved hosts connect with their stored settings, not whatever a renderer sent. */
  private resolveProfile(profile: DesktopProfile): DesktopProfile {
    if (!profile.profileId) return profile;
    const saved = this.ctx.database.savedHostProfile(profile.profileId)?.profile;
    if (!saved || saved.kind !== profile.kind) {
      throw new Error('This saved host no longer exists.');
    }
    return saved;
  }

  private async connect(requested: DesktopProfile): Promise<void> {
    const profile = this.resolveProfile(requested);
    this.profile = profile;
    if (profile.sshGateway) await this.dialGateway(profile);
    if (this.closed) return;
    if (profile.kind === 'rdp') await this.loadRdpCredentials(false);
    if (this.closed) return;
    this.issueTicket();
  }

  private async retry(rejected: boolean): Promise<void> {
    const profile = this.profile;
    if (!profile || this.closed) return;
    this.rememberCandidate = undefined;
    if (profile.kind === 'rdp') {
      if (rejected) await this.loadRdpCredentials(true);
    } else {
      this.vncRejected = rejected;
    }
    if (!this.closed) this.issueTicket();
  }

  private issueTicket(): void {
    const profile = this.profile!;
    const ticket = this.tickets.issue(this, profile.kind);
    send(this.socket, {
      op: 'ready',
      ticket,
      ...(profile.kind === 'rdp' ? { credentials: this.credentials } : {}),
    });
  }

  private async dialGateway(profile: DesktopProfile): Promise<void> {
    const gateway = profile.sshGateway!;
    const sshProfile: SshProfile = {
      kind: 'ssh',
      target: gateway.target,
      ...(gateway.profileId ? { profileId: gateway.profileId } : {}),
    };
    this.status(`Connecting to the SSH gateway ${gateway.target} …`, true);
    const io: ConnectIo = {
      status: (message, options) => this.status(message, options?.transient),
      prompt: (info) => this.prompt(info),
      hostKey: async (challenge) => {
        const reply = this.expect('host-key-response');
        send(this.socket, { op: 'host-key', ...challenge });
        return (await reply).accept;
      },
    };
    const lease = await this.ctx.connections.connect(sshProfile, io, 'desktop');
    if (this.closed) {
      lease.release();
      return;
    }
    this.gateway = lease;
    const unsubscribe = lease.connection.onClose((reason) => {
      if (this.closed) return;
      send(this.socket, {
        op: 'exit',
        message: `The SSH gateway ${gateway.target} disconnected${reason ? `: ${reason}` : '.'}`,
        reason: 'disconnected',
      });
      this.socket.close();
    });
    this.aborts.add(() => unsubscribe());
    await lease.connection.waitForPostAuth();
  }

  private gatewayKey(): string {
    const gateway = this.profile?.sshGateway;
    if (!gateway) return '';
    return gateway.profileId ? `profile:${gateway.profileId}` : `ssh:${gateway.target}`;
  }

  private passwordRef(username: string): VaultPasswordRef {
    const profile = this.profile!;
    const target: DesktopPasswordTarget = {
      protocol: profile.kind,
      user: username,
      host: profile.host,
      port: profile.port,
      gateway: this.gatewayKey(),
      gatewayLabel: profile.sshGateway?.target,
      domain: profile.kind === 'rdp' ? (profile.domain ?? '') : '',
    };
    return { account: desktopPasswordAccount(target), label: desktopPasswordLabel(target) };
  }

  /**
   * RDP needs the whole logon before it connects: NLA runs CredSSP in the
   * client, and TLS-only servers take it in the Client Info PDU.
   */
  private async loadRdpCredentials(rejected: boolean): Promise<void> {
    const profile = this.profile as Extract<DesktopProfile, { kind: 'rdp' }>;
    const username = profile.username?.trim() || undefined;
    if (!rejected && username) {
      const ref = this.passwordRef(username);
      const saved = await this.passwords.read(ref);
      if (saved !== undefined) {
        this.status(`Using the saved password for ${ref.label}.`, true);
        this.credentials = { username, password: saved, domain: profile.domain || undefined };
        this.usedSavedPassword = true;
        return;
      }
    }
    const answer = await this.askLogin({
      username,
      askUsername: !username,
      rejected,
      name: 'Remote Desktop logon',
    });
    this.credentials = { username: answer.username, password: answer.password, domain: profile.domain || undefined };
  }

  /**
   * Ask for a password, and for the user name too when the host does not
   * store one. A password marked to remember is held until the login works.
   */
  private async askLogin(options: {
    /** Known user name; the vault files the password under it ('' when none applies). */
    username: string | undefined;
    askUsername: boolean;
    rejected: boolean;
    name: string;
  }): Promise<{ username: string; password: string }> {
    const profile = this.profile!;
    const passwordOnly = !options.askUsername && !options.username;
    const instructions = options.rejected
      ? this.usedSavedPassword
        ? 'The saved password was not accepted. Enter the current password.'
        : passwordOnly
          ? 'The password was not accepted.'
          : 'The user name or password was not accepted.'
      : undefined;
    const known = options.askUsername ? undefined : this.passwordRef(options.username ?? '');
    const response = await this.prompt({
      name: options.name,
      host: `${profile.host}:${profile.port}`,
      purpose: 'authentication',
      instructions,
      prompts: [
        ...(options.askUsername ? [{ prompt: 'User name', echo: true }] : []),
        { prompt: 'Password', echo: false },
      ],
      ...(this.passwords.available
        ? {
            rememberPassword: {
              label: known?.label ?? `${profile.kind.toUpperCase()} ${profile.host}:${profile.port}`,
              existing: known ? this.passwords.has(known) : false,
            },
          }
        : {}),
    });
    if (response.skipped) throw new Error('Logon cancelled.');
    const username = options.askUsername
      ? (response.answers[0] ?? '').trim()
      : (options.username ?? '');
    const password = response.answers[options.askUsername ? 1 : 0] ?? '';
    this.usedSavedPassword = false;
    this.rememberCandidate = response.rememberPassword
      ? {
          ...this.passwordRef(username),
          password,
          ...(options.askUsername && username ? { username } : {}),
        }
      : undefined;
    return { username, password };
  }

  /** noVNC asked for credentials in the middle of the RFB security handshake. */
  private async provideVncCredentials(types: Array<'username' | 'password'>): Promise<void> {
    const profile = this.profile;
    if (!profile || profile.kind !== 'vnc' || this.closed) return;
    const username = profile.username?.trim() || undefined;
    const needsUser = types.includes('username');
    if (!this.vncRejected && (username || !needsUser)) {
      const ref = this.passwordRef(needsUser ? username! : '');
      const saved = await this.passwords.read(ref);
      if (saved !== undefined) {
        this.status(`Using the saved password for ${ref.label}.`, true);
        this.usedSavedPassword = true;
        send(this.socket, { op: 'credentials', credentials: { username, password: saved } });
        return;
      }
    }
    const answer = await this.askLogin({
      username: needsUser ? username : '',
      askUsername: needsUser && !username,
      rejected: this.vncRejected,
      name: 'VNC authentication',
    });
    this.vncRejected = false;
    send(this.socket, {
      op: 'credentials',
      credentials: { username: needsUser ? answer.username : undefined, password: answer.password },
    });
  }

  private async loginSucceeded(): Promise<void> {
    const profile = this.profile;
    if (!profile || this.closed) return;
    if (!this.recorded && profile.profileId) {
      this.recorded = true;
      try {
        this.ctx.database.recordSavedHostConnection(profile.profileId);
      } catch (err) {
        this.log.warn({ err }, 'could not record recent connection');
      }
    }
    const candidate = this.rememberCandidate;
    this.rememberCandidate = undefined;
    if (!candidate) return;
    // The desktop is already up: failing to save must never tear it down.
    try {
      await this.passwords.remember(candidate, candidate.password);
      // A name typed at the prompt is what the saved password is filed under;
      // keep it on the host so the next connect finds the password.
      if (candidate.username && profile.profileId) {
        const saved = this.ctx.database.savedHostProfile(profile.profileId);
        if (saved && (saved.profile.kind === 'rdp' || saved.profile.kind === 'vnc') && !saved.profile.username) {
          const { profileId: _profileId, ...connection } = saved.profile;
          this.ctx.database.saveSavedHostProfile({
            id: saved.id,
            name: saved.name,
            profile: { ...connection, username: candidate.username },
          });
        }
      }
    } catch (err) {
      if (this.closed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: message }, 'could not remember the desktop password');
      this.status(`The password could not be remembered: ${message}`);
    }
  }

  /** The stream half of this session: TCP to the desktop, direct or through the gateway. */
  streamTarget(): RdpStreamTarget {
    const profile = this.profile!;
    return {
      host: profile.host,
      port: profile.port,
      open: () => this.openStream(),
      acceptCertificate: (certificate) => this.acceptCertificate(certificate),
      onAbort: (abort) => {
        this.aborts.add(abort);
        return () => this.aborts.delete(abort);
      },
    };
  }

  private async openStream(): Promise<Duplex> {
    const profile = this.profile!;
    const target = `${profile.host}:${profile.port}`;
    const gateway = this.gateway;
    if (!gateway) {
      this.status(`Connecting to ${target} …`, true);
      return connectTcp(profile.host, profile.port);
    }
    this.status(`Connecting to ${target} through ${profile.sshGateway!.target} …`, true);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(Object.assign(new Error(`Timed out connecting to ${target} through the SSH gateway`), { code: 'ETIMEDOUT' }));
      }, TCP_CONNECT_TIMEOUT_MS);
      gateway.connection.client.forwardOut('127.0.0.1', 0, profile.host, profile.port, (err, channel) => {
        clearTimeout(timer);
        // A channel that opens after the caller gave up must not linger.
        if (settled) {
          channel?.destroy();
          return;
        }
        settled = true;
        if (err) reject(channelOpenError(err));
        else resolve(channel);
      });
    });
  }

  private async acceptCertificate(certificate: PresentedCertificate): Promise<boolean> {
    const profile = this.profile!;
    const gateway = this.gatewayKey();
    const pinned = this.ctx.database.trustedDesktopCertificate(profile.host, profile.port, gateway);
    const challenge = certificateChallenge(certificate, profile.host, profile.port, pinned);
    if (!challenge) return true;
    const reply = this.expect('certificate-response');
    send(this.socket, { op: 'certificate', ...challenge });
    const { accept } = await reply;
    if (accept) {
      this.ctx.database.trustDesktopCertificate({
        host: profile.host,
        port: profile.port,
        gateway,
        fingerprint: certificate.fingerprint,
        subject: certificate.subject,
      });
    }
    return accept;
  }

  /** Relay one noVNC socket to the VNC server for as long as both ends stay open. */
  async serveVnc(socket: WebSocket): Promise<void> {
    let upstream: Duplex;
    try {
      upstream = await this.openStream();
    } catch (err) {
      this.log.warn({ err, host: this.profile?.host }, 'vnc connection failed');
      const reason = Buffer.from(connectFailureMessage(err)).subarray(0, 123).toString('utf8');
      socket.close(1011, reason.replace(/\uFFFD$/, ''));
      return;
    }
    if (socket.readyState !== socket.OPEN || this.closed) {
      upstream.destroy();
      return;
    }
    const client = createWebSocketStream(socket);
    const abort = () => {
      client.destroy();
      upstream.destroy();
    };
    this.aborts.add(abort);
    const finish = () => {
      this.aborts.delete(abort);
      abort();
    };
    client.once('close', finish);
    upstream.once('close', finish);
    client.on('error', finish);
    upstream.on('error', (err) => {
      this.log.debug({ err, host: this.profile?.host }, 'vnc server stream failed');
      finish();
    });
    client.pipe(upstream);
    upstream.pipe(client);
    this.log.info({ host: this.profile?.host, port: this.profile?.port }, 'vnc session established');
  }
}

function ticketFromProtocols(header: unknown): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : '';
  return raw
    .split(',')
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith(DESKTOP_TICKET_PROTOCOL_PREFIX))
    ?.slice(DESKTOP_TICKET_PROTOCOL_PREFIX.length);
}

/**
 * /ws/desktop (control), /ws/desktop/vnc (noVNC's RFB stream) and
 * /ws/desktop/rdp (IronRDP's RDCleanPath stream). The RDP socket cannot carry
 * the bearer-token subprotocol (IronRDP opens it itself), so it authenticates
 * with the ticket inside its first PDU instead.
 */
export function registerDesktopSockets(
  app: FastifyInstance,
  ctx: AppContext,
  tickets = new DesktopTickets(),
): void {
  app.get('/ws/desktop', { websocket: true }, (socket) => {
    new DesktopSession(socket, ctx, app.log, tickets).start();
  });

  app.get(DESKTOP_VNC_WS_PATH, { websocket: true }, (socket, req) => {
    const ticket = ticketFromProtocols(req.headers['sec-websocket-protocol']);
    const session = ticket ? tickets.redeem(ticket, 'vnc') : undefined;
    if (!session) {
      socket.close(1008, 'unknown or expired ticket');
      return;
    }
    void session.serveVnc(socket);
  });

  app.get(DESKTOP_RDP_WS_PATH, { websocket: true }, (socket) => {
    void serveRdpCleanPath(
      socket,
      (ticket) => tickets.redeem(ticket, 'rdp')?.streamTarget(),
      app.log,
    );
  });
}
