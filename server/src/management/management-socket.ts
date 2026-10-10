import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type {
  AuthPromptInfo,
  AuthPromptResponse,
  GnmiEncoding,
  GnmiNotification,
  GnmiProfile,
  GnmiSessionInfo,
  ManagementClientMessage,
  ManagementError,
  ManagementProfile,
  ManagementRequest,
  ManagementResult,
  ManagementServerMessage,
  NetconfProfile,
  NetconfSessionInfo,
  SshProfile,
} from '@muxus/shared';
import { GnmiPathError, savedHostHop } from '@muxus/shared';
import { managementClientMessageSchema } from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import type { ConnectIo, MuxedConnectionLease } from '../ssh/connection-manager.js';
import { certificateChallenge, type PresentedCertificate } from '../remote-desktop/certificates.js';
import { DesktopPasswords, type VaultPasswordRef } from '../remote-desktop/desktop-passwords.js';
import { desktopPasswordAccount, desktopPasswordLabel } from '../security/password-vault.js';
import { connectFailureMessage, connectTcp, connectThroughGateway } from '../util/dial.js';
import { GnmiClient, type GnmiSubscription } from './gnmi/client.js';
import { GrpcCode, GrpcError, type GrpcCall } from './gnmi/grpc.js';
import { decodeMessage, encodeMessage } from './gnmi/protobuf.js';
import { jsonToProto, protoToJson, ProtoJsonError } from './services/json.js';
import { methodDef, type MethodDef } from './services/registry.js';
import { downloadFile, FileUpload, listServices } from './services/transfer.js';
import { pickEncoding } from './gnmi/values.js';
import { NetconfClient, NetconfError } from './netconf/client.js';
import { upgradeGnmiTls } from './tls.js';

const CONNECT_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 30_000;
const MAX_LOGIN_ATTEMPTS = 3;
/** Subscription updates are forwarded in batches at most this often. */
const NOTIFICATION_FLUSH_MS = 100;
const NOTIFICATION_BATCH_LIMIT = 2000;

type ClientReply<Op extends ManagementClientMessage['op']> = Extract<ManagementClientMessage, { op: Op }>;
type ResponseOp = 'auth-response' | 'host-key-response' | 'certificate-response';

function send(socket: WebSocket, message: ManagementServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function describeError(err: unknown): ManagementError {
  if (err instanceof GrpcError) {
    return { message: err.message, code: err.codeName, ...(err.code === GrpcCode.CANCELLED ? { cancelled: true } : {}) };
  }
  if (err instanceof NetconfError) return { message: err.message, ...(err.cancelled ? { cancelled: true } : {}) };
  if (err instanceof GnmiPathError) return { message: `Invalid path: ${err.message}`, code: 'INVALID_ARGUMENT' };
  if (err instanceof ProtoJsonError) return { message: `Invalid request: ${err.message}`, code: 'INVALID_ARGUMENT' };
  return { message: err instanceof Error ? err.message : String(err) };
}

interface RunningRequest {
  abort: AbortController;
  subscription?: GnmiSubscription;
  /** An open streaming gNOI/gNSI call. */
  call?: GrpcCall;
  method?: MethodDef;
  upload?: FileUpload;
}

/** Messages of a streaming call, like subscription updates, go out in batches. */
const GRPC_BATCH_LIMIT = 500;
/** Size of the base64 chunks a download is sent to the renderer in. */
const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

/**
 * One NETCONF or gNMI tab: owns the control socket, the SSH lease (NETCONF's
 * transport, or a gNMI gateway), the protocol client, and every request
 * still in flight.
 */
export class ManagementSession {
  closed = false;
  private profile: ManagementProfile | undefined;
  private lease: MuxedConnectionLease | undefined;
  private gnmi: GnmiClient | undefined;
  private gnmiInfo: GnmiSessionInfo | undefined;
  private encoding: GnmiEncoding = 'json_ietf';
  private netconf: NetconfClient | undefined;
  private readonly running = new Map<string, RunningRequest>();
  private readonly waiters = new Map<ResponseOp, { resolve: (msg: ManagementClientMessage) => void; reject: (err: Error) => void }>();
  private readonly cleanups = new Set<() => void>();
  private readonly passwords: DesktopPasswords;
  private connecting: Promise<void> | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
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
      let message: ManagementClientMessage;
      try {
        const parsed = managementClientMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
        if (!parsed.success) {
          const id = (JSON.parse(data.toString('utf8')) as { id?: unknown }).id;
          if (typeof id === 'string') {
            send(this.socket, {
              op: 'error',
              id,
              error: { message: parsed.error.issues[0]?.message ?? 'Invalid request.' },
              durationMs: 0,
            });
          }
          return;
        }
        message = parsed.data;
      } catch {
        return;
      }
      this.dispatch(message);
    });
    this.socket.once('close', () => {
      clearTimeout(connectTimer);
      clearInterval(keepalive);
      this.close();
    });
  }

  private dispatch(message: ManagementClientMessage): void {
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
        this.connecting = this.connect(message.profile).catch((err: unknown) => this.fail(err));
        return;
      case 'cancel': {
        const running = this.running.get(message.id);
        running?.abort.abort();
        running?.subscription?.cancel();
        running?.call?.cancel();
        running?.upload?.cancel();
        return;
      }
      case 'gnmi-poll':
        this.running.get(message.id)?.subscription?.poll();
        return;
      case 'grpc-send':
        this.sendOnCall(message.id, message.message);
        return;
      case 'grpc-close-send':
        this.running.get(message.id)?.call?.end();
        return;
      case 'gnoi-file-chunk':
        this.uploadChunk(message.id, message.data, message.last === true);
        return;
      default:
        void this.request(message);
    }
  }

  private expect<Op extends ResponseOp>(op: Op): Promise<ClientReply<Op>> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    this.waiters.get(op)?.reject(new Error('superseded'));
    return new Promise((resolve, reject) => {
      this.waiters.set(op, { resolve: resolve as (msg: ManagementClientMessage) => void, reject });
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

  private connectIo(): ConnectIo {
    return {
      status: (message, options) => this.status(message, options?.transient),
      prompt: (info) => this.prompt(info),
      hostKey: async (challenge) => {
        const reply = this.expect('host-key-response');
        send(this.socket, { op: 'host-key', ...challenge });
        return (await reply).accept;
      },
    };
  }

  private fail(err: unknown): void {
    if (this.closed) return;
    const message = connectFailureMessage(err);
    this.log.warn({ err: message, host: this.profile?.host, kind: this.profile?.kind }, 'management session failed');
    send(this.socket, { op: 'exit', message, reason: 'failed' });
    this.socket.close();
  }

  /** The transport went away under a live session. */
  private lost(message: string): void {
    if (this.closed) return;
    send(this.socket, { op: 'exit', message, reason: 'disconnected' });
    this.socket.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.values()) waiter.reject(new Error('connection closed'));
    this.waiters.clear();
    for (const running of this.running.values()) {
      running.abort.abort();
      running.subscription?.cancel();
      running.call?.cancel();
      running.upload?.cancel();
    }
    this.running.clear();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
    this.gnmi?.close();
    this.gnmi = undefined;
    const netconf = this.netconf;
    this.netconf = undefined;
    const lease = this.lease;
    this.lease = undefined;
    if (netconf) void netconf.close().finally(() => lease?.release());
    else lease?.release();
  }

  /** Saved hosts connect with their stored settings, not whatever a renderer sent. */
  private resolveProfile(profile: ManagementProfile): ManagementProfile {
    if (!profile.profileId) return profile;
    const saved = this.ctx.database.savedHostProfile(profile.profileId)?.profile;
    if (!saved || saved.kind !== profile.kind) throw new Error('This saved host no longer exists.');
    return saved;
  }

  private async connect(requested: ManagementProfile): Promise<void> {
    const profile = this.resolveProfile(requested);
    this.profile = profile;
    if (profile.kind === 'gnmi') await this.connectGnmi(profile);
    else await this.connectNetconf(profile);
    if (this.closed) return;
    if (profile.profileId) {
      try {
        this.ctx.database.recordSavedHostConnection(profile.profileId);
      } catch (err) {
        this.log.warn({ err }, 'could not record recent connection');
      }
    }
  }

  private gatewayKey(): string {
    const gateway = this.profile?.sshGateway;
    if (!gateway) return '';
    return gateway.profileId ? `profile:${gateway.profileId}` : `ssh:${gateway.target}`;
  }

  private watchLease(lease: MuxedConnectionLease, what: string): void {
    const unsubscribe = lease.connection.onClose((reason) => {
      this.lost(`${what} disconnected${reason ? `: ${reason}` : '.'}`);
    });
    this.cleanups.add(unsubscribe);
  }

  // gNMI

  private async connectGnmi(profile: GnmiProfile): Promise<void> {
    const gateway = profile.sshGateway;
    if (gateway) {
      this.status(`Connecting to the SSH gateway ${gateway.target} …`, true);
      const sshProfile: SshProfile = {
        kind: 'ssh',
        target: gateway.target,
        ...(gateway.profileId ? { profileId: gateway.profileId } : {}),
      };
      const lease = await this.ctx.connections.connect(sshProfile, this.connectIo(), 'management');
      if (this.closed) {
        lease.release();
        return;
      }
      this.lease = lease;
      this.watchLease(lease, `The SSH gateway ${gateway.target}`);
      await lease.connection.waitForPostAuth();
      if (this.closed) return;
    }

    // Reach the device first: an unreachable host or an untrusted
    // certificate should surface before anyone types a password.
    const client = await this.openGnmi(profile);
    if (this.closed) {
      client.client.close();
      return;
    }
    this.gnmi = client.client;
    this.cleanups.add(client.client.onClose((reason) => this.lost(reason)));

    let username = profile.username?.trim() || undefined;
    let password: string | undefined;
    let usedSaved = false;
    let remember: (VaultPasswordRef & { password: string }) | undefined;
    if (username) {
      const saved = await this.passwords.read(this.passwordRef(username));
      if (saved !== undefined) {
        password = saved;
        usedSaved = true;
        this.status(`Using the saved password for ${this.passwordRef(username).label}.`, true);
      }
    }
    const ask = async (rejected: boolean) => {
      const answer = await this.askLogin(username, rejected, usedSaved);
      username = answer.username;
      password = answer.password;
      usedSaved = false;
      remember = answer.remember ? { ...this.passwordRef(username ?? ''), password: answer.password ?? '' } : undefined;
    };
    if (password === undefined) await ask(false);
    if (this.closed) return;

    for (let attempt = 1; ; attempt++) {
      client.client.setCredentials(username, password);
      try {
        this.status('Asking the device for its capabilities …', true);
        const capabilities = await client.client.capabilities();
        this.encoding = pickEncoding(capabilities.encodings, profile.encoding);
        // Which gNOI and gNSI services share this server, when it says.
        const services = await listServices(client.client).catch(() => undefined);
        this.gnmiInfo = {
          protocol: 'gnmi',
          version: capabilities.version,
          encodings: capabilities.encodings,
          models: capabilities.models,
          tls: client.tls,
          address: `${username ? `${username}@` : ''}${profile.host}:${profile.port}`,
          ...(gateway ? { via: gateway.target } : {}),
          ...(services ? { services } : {}),
          connectedAt: new Date().toISOString(),
        };
        break;
      } catch (err) {
        if (!(err instanceof GrpcError) || err.code !== GrpcCode.UNAUTHENTICATED || attempt >= MAX_LOGIN_ATTEMPTS) {
          throw err instanceof GrpcError ? new Error(`${err.codeName}: ${err.message}`) : err;
        }
        await ask(true);
        if (this.closed) return;
      }
    }
    if (remember) {
      const candidate = remember;
      remember = undefined;
      try {
        await this.passwords.remember(candidate, candidate.password);
      } catch (err) {
        this.status(`The password could not be remembered: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.closed || !this.gnmiInfo) return;
    send(this.socket, { op: 'ready', info: this.gnmiInfo, profile });
    this.log.info({ host: profile.host, port: profile.port }, 'gnmi session established');
  }

  private passwordRef(username: string): VaultPasswordRef {
    const profile = this.profile as GnmiProfile;
    const target = {
      protocol: 'gnmi' as const,
      user: username,
      host: profile.host,
      port: profile.port,
      gateway: this.gatewayKey(),
      gatewayLabel: profile.sshGateway?.target,
      domain: '',
    };
    return { account: desktopPasswordAccount(target), label: desktopPasswordLabel(target) };
  }

  private async askLogin(
    known: string | undefined,
    rejected: boolean,
    usedSaved: boolean,
  ): Promise<{ username?: string; password?: string; remember: boolean }> {
    const profile = this.profile as GnmiProfile;
    const askUsername = !known;
    const ref = known ? this.passwordRef(known) : undefined;
    const response = await this.prompt({
      name: 'gNMI login',
      host: `${profile.host}:${profile.port}`,
      purpose: 'authentication',
      instructions: rejected
        ? usedSaved
          ? 'The saved password was not accepted. Enter the current password.'
          : 'The device rejected the login.'
        : askUsername
          ? 'gNMI devices take the user name and password with every request.'
          : undefined,
      prompts: [...(askUsername ? [{ prompt: 'User name', echo: true }] : []), { prompt: 'Password', echo: false }],
      ...(this.passwords.available
        ? {
            rememberPassword: {
              label: ref?.label ?? `gNMI ${profile.host}:${profile.port}`,
              existing: ref ? this.passwords.has(ref) : false,
            },
          }
        : {}),
      ...(askUsername && !rejected ? { skipLabel: 'Connect without a login' } : {}),
    });
    if (response.skipped) return { remember: false };
    const username = askUsername ? (response.answers[0] ?? '').trim() || undefined : known;
    const password = response.answers[askUsername ? 1 : 0] ?? '';
    return { username, password, remember: response.rememberPassword === true && !!username };
  }

  private async openGnmi(profile: GnmiProfile): Promise<{ client: GnmiClient; tls: GnmiSessionInfo['tls'] }> {
    const target = `${profile.host}:${profile.port}`;
    let stream: Duplex;
    if (this.lease) {
      this.status(`Connecting to ${target} through ${profile.sshGateway?.target} …`, true);
      stream = await connectThroughGateway(this.lease.connection.client, profile.host, profile.port);
    } else {
      this.status(`Connecting to ${target} …`, true);
      stream = await connectTcp(profile.host, profile.port);
    }
    const mode = profile.tls ?? 'verify';
    let tlsInfo: GnmiSessionInfo['tls'] = { mode };
    if (mode !== 'plaintext') {
      this.status('Starting TLS …', true);
      const { socket, certificate } = await upgradeGnmiTls(stream, profile);
      stream = socket;
      tlsInfo = {
        mode,
        protocol: socket.getProtocol() ?? undefined,
        ...(certificate
          ? {
              fingerprint: certificate.fingerprint,
              subject: certificate.subject,
              issuer: certificate.issuer,
              validTo: certificate.validTo,
              verified: !certificate.verificationError,
            }
          : {}),
      };
      if (mode === 'verify') {
        if (!certificate) {
          socket.destroy();
          throw new Error('The device presented no certificate.');
        }
        const verdict = await this.acceptCertificate(profile, certificate);
        if (!verdict.accepted) {
          socket.destroy();
          throw new Error('The certificate was not trusted.');
        }
        tlsInfo.pinned = verdict.pinned;
      }
      if (this.closed) {
        socket.destroy();
        throw new Error('connection closed');
      }
    }
    const client = await GnmiClient.connect({
      socket: stream,
      authority: `${profile.tlsServerName ?? profile.host}:${profile.port}`,
      secure: mode !== 'plaintext',
    });
    return { client, tls: tlsInfo };
  }

  private async acceptCertificate(
    profile: GnmiProfile,
    certificate: PresentedCertificate,
  ): Promise<{ accepted: boolean; pinned: boolean }> {
    const gateway = this.gatewayKey();
    const pinned = this.ctx.database.trustedDesktopIdentity(profile.host, profile.port, gateway);
    const challenge = certificateChallenge(certificate, profile.host, profile.port, pinned);
    if (!challenge) return { accepted: true, pinned: !!certificate.verificationError };
    const reply = this.expect('certificate-response');
    send(this.socket, { op: 'certificate', ...challenge });
    const { accept } = await reply;
    if (accept) {
      this.ctx.database.trustDesktopIdentity({
        host: profile.host,
        port: profile.port,
        gateway,
        fingerprint: certificate.fingerprint,
        subject: certificate.subject,
      });
    }
    return { accepted: accept, pinned: accept };
  }

  // NETCONF

  private async connectNetconf(profile: NetconfProfile): Promise<void> {
    const gateway = profile.sshGateway;
    const sshProfile: SshProfile = {
      kind: 'ssh',
      target: profile.host,
      port: profile.port,
      ...(profile.username?.trim() ? { user: profile.username.trim() } : {}),
      ...(gateway ? { proxyJump: [gateway.profileId ? savedHostHop(gateway.profileId) : gateway.target] } : {}),
    };
    this.status(`Connecting to ${profile.host}:${profile.port} …`, true);
    const lease = await this.ctx.connections.connect(sshProfile, this.connectIo(), 'management');
    if (this.closed) {
      lease.release();
      return;
    }
    this.lease = lease;
    this.watchLease(lease, 'The SSH connection');
    await lease.connection.waitForPostAuth();
    if (this.closed) return;
    this.status('Opening the NETCONF subsystem …', true);
    const channel = await new Promise<Duplex>((resolve, reject) => {
      lease.connection.client.subsys('netconf', (err, stream) => (err ? reject(subsystemError(err)) : resolve(stream)));
    });
    if (this.closed) {
      channel.destroy();
      return;
    }
    const client = await NetconfClient.open(channel);
    if (this.closed) {
      void client.close();
      return;
    }
    this.netconf = client;
    this.cleanups.add(client.onClose((reason) => this.lost(reason)));
    this.cleanups.add(
      client.onNotification((notification) =>
        send(this.socket, {
          op: 'netconf-notification',
          xml: notification.xml,
          ...(notification.eventTime ? { eventTime: notification.eventTime } : {}),
          receivedAt: new Date().toISOString(),
        }),
      ),
    );
    const info: NetconfSessionInfo = {
      protocol: 'netconf',
      sessionId: client.sessionId,
      base: client.base,
      capabilities: client.capabilities,
      address: `${lease.target.user}@${lease.target.resolved.hostname}:${lease.target.port}`,
      ...(gateway ? { via: gateway.target } : {}),
      connectedAt: new Date().toISOString(),
    };
    send(this.socket, { op: 'ready', info, profile });
    this.log.info({ host: profile.host, port: profile.port }, 'netconf session established');
  }

  // Requests

  private async request(message: ManagementRequest): Promise<void> {
    const id = message.id;
    if (this.running.has(id)) {
      send(this.socket, { op: 'error', id, error: { message: 'A request with this id is still running.' }, durationMs: 0 });
      return;
    }
    // Requests sent while the session is still connecting wait for it.
    await this.connecting?.catch(() => undefined);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const abort = new AbortController();
    const running: RunningRequest = { abort };
    this.running.set(id, running);
    try {
      if (message.op === 'gnmi-subscribe') {
        this.subscribe(message, running);
        return;
      }
      if (message.op === 'grpc-stream') {
        this.openGrpcStream(message, running, elapsed);
        return;
      }
      if (message.op === 'gnoi-file-put') {
        running.upload = new FileUpload(this.requireGnmi(), message.remoteFile, message.permissions, abort.signal);
        send(this.socket, { op: 'gnoi-file-ack', id, bytes: 0 });
        return;
      }
      const { result, bytes } = await this.execute(message, abort.signal);
      send(this.socket, { op: 'result', id, result, durationMs: elapsed(), bytes });
    } catch (err) {
      send(this.socket, { op: 'error', id, error: describeError(err), durationMs: elapsed() });
      running.call = undefined;
      running.upload = undefined;
    } finally {
      // Live subscriptions, streams and uploads stay registered until they end.
      if (!running.subscription && !running.call && !running.upload) this.running.delete(id);
    }
  }

  private requireGnmi(): GnmiClient {
    if (!this.gnmi || !this.gnmiInfo) throw new Error('This is not a connected gNMI session.');
    return this.gnmi;
  }

  private async execute(
    message: Exclude<ManagementRequest, { op: 'gnmi-subscribe' | 'grpc-stream' | 'gnoi-file-put' }>,
    signal: AbortSignal,
  ): Promise<{ result: ManagementResult; bytes: number }> {
    switch (message.op) {
      case 'grpc-call': {
        const method = this.allowedMethod(message.method, 'unary');
        const request = encodeMessage(method.request, jsonToProto(method.request, message.request ?? {}));
        const { message: reply, bytes } = await this.requireGnmi().unaryCall(method.path, request, signal);
        return {
          result: {
            op: 'grpc-call',
            method: method.path,
            response: protoToJson(method.response, decodeMessage(method.response, reply)),
          },
          bytes,
        };
      }
      case 'tls-probe': {
        const profile = this.profile;
        if (profile?.kind !== 'gnmi' || (profile.tls ?? 'verify') === 'plaintext') {
          throw new Error('This session does not use TLS.');
        }
        const stream = this.lease
          ? await connectThroughGateway(this.lease.connection.client, profile.host, profile.port)
          : await connectTcp(profile.host, profile.port);
        const { socket, certificate } = await upgradeGnmiTls(stream, profile);
        socket.destroy();
        if (!certificate) throw new Error('The device presented no certificate.');
        return {
          result: {
            op: 'tls-probe',
            certificate: {
              fingerprint: certificate.fingerprint,
              subject: certificate.subject,
              issuer: certificate.issuer,
              validFrom: certificate.validFrom,
              validTo: certificate.validTo,
              ...(certificate.verificationError ? { verificationError: certificate.verificationError } : {}),
            },
          },
          bytes: 0,
        };
      }
      case 'gnoi-file-get': {
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        const flush = () => {
          if (!pendingBytes) return;
          send(this.socket, { op: 'gnoi-file-data', id: message.id, data: Buffer.concat(pending).toString('base64') });
          pending = [];
          pendingBytes = 0;
        };
        const download = await downloadFile(
          this.requireGnmi(),
          message.remoteFile,
          (chunk) => {
            pending.push(chunk);
            pendingBytes += chunk.length;
            if (pendingBytes >= DOWNLOAD_CHUNK_BYTES) flush();
          },
          signal,
        );
        flush();
        return { result: { op: 'gnoi-file-get', ...download }, bytes: download.size };
      }
      case 'gnmi-capabilities': {
        const capabilities = await this.requireGnmi().capabilities(signal);
        this.gnmiInfo = { ...this.gnmiInfo!, ...capabilities };
        return { result: { op: 'gnmi-capabilities', info: this.gnmiInfo }, bytes: capabilities.bytes };
      }
      case 'gnmi-get': {
        const { notifications, bytes } = await this.requireGnmi().get(
          message,
          message.encoding ?? this.encoding,
          signal,
        );
        return { result: { op: 'gnmi-get', notifications }, bytes };
      }
      case 'gnmi-set': {
        const { timestamp, results, bytes } = await this.requireGnmi().set(message, signal);
        return { result: { op: 'gnmi-set', timestamp, results }, bytes };
      }
      case 'netconf-rpc': {
        if (!this.netconf) throw new Error('This is not a connected NETCONF session.');
        const reply = await this.netconf.rpc(message.xml, { timeoutMs: message.timeoutMs, signal });
        return { result: { op: 'netconf-rpc', xml: reply.xml, messageId: reply.messageId }, bytes: reply.bytes };
      }
    }
  }

  private allowedMethod(path: string, ...kinds: MethodDef['kind'][]): MethodDef {
    const method = methodDef(path);
    if (!method) throw new Error(`Muxus does not call ${path}.`);
    if (!kinds.includes(method.kind)) throw new Error(`${path} is a ${method.kind} call.`);
    return method;
  }

  /** Server-streaming and bidirectional gNOI/gNSI calls: messages go to the renderer in batches. */
  private openGrpcStream(
    message: Extract<ManagementRequest, { op: 'grpc-stream' }>,
    running: RunningRequest,
    elapsed: () => number,
  ): void {
    const id = message.id;
    const method = this.allowedMethod(message.method, 'server-stream', 'bidi', 'client-stream');
    const call = this.requireGnmi().openCall(method.path);
    running.call = call;
    running.method = method;
    let batch: Array<Record<string, unknown>> = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!batch.length) return;
      send(this.socket, { op: 'grpc-messages', id, messages: batch });
      batch = [];
    };
    call.on('message', (reply: Buffer) => {
      try {
        batch.push(protoToJson(method.response, decodeMessage(method.response, reply)));
      } catch (err) {
        call.cancel(new GrpcError(GrpcCode.INTERNAL, `Could not decode a reply: ${(err as Error).message}`));
        return;
      }
      if (batch.length >= GRPC_BATCH_LIMIT) flush();
      else timer ??= setTimeout(flush, NOTIFICATION_FLUSH_MS);
    });
    call.once('end', (error: GrpcError | undefined) => {
      flush();
      this.running.delete(id);
      const ended = error && error.code !== GrpcCode.CANCELLED ? describeError(error) : undefined;
      send(this.socket, { op: 'stream-end', id, ...(ended ? { error: ended } : {}) });
      this.log.debug({ method: method.path, durationMs: elapsed() }, 'grpc stream ended');
    });
    if (message.request) call.write(encodeMessage(method.request, jsonToProto(method.request, message.request)));
    if (method.kind === 'server-stream') call.end();
  }

  private sendOnCall(id: string, payload: Record<string, unknown>): void {
    const running = this.running.get(id);
    if (!running?.call || !running.method) return;
    try {
      running.call.write(encodeMessage(running.method.request, jsonToProto(running.method.request, payload)));
    } catch (err) {
      running.call.cancel(new GrpcError(GrpcCode.INVALID_ARGUMENT, err instanceof Error ? err.message : String(err)));
    }
  }

  private uploadChunk(id: string, data: string, last: boolean): void {
    const running = this.running.get(id);
    const upload = running?.upload;
    if (!running || !upload) return;
    const started = performance.now();
    void (async () => {
      try {
        if (data) await upload.write(Buffer.from(data, 'base64'));
        if (!last) {
          send(this.socket, { op: 'gnoi-file-ack', id, bytes: upload.bytes });
          return;
        }
        const size = await upload.finish();
        this.running.delete(id);
        send(this.socket, {
          op: 'result',
          id,
          result: { op: 'gnoi-file-put', size },
          durationMs: Math.round(performance.now() - started),
          bytes: size,
        });
      } catch (err) {
        this.running.delete(id);
        upload.cancel();
        send(this.socket, { op: 'error', id, error: describeError(err), durationMs: 0 });
      }
    })();
  }

  private subscribe(message: Extract<ManagementRequest, { op: 'gnmi-subscribe' }>, running: RunningRequest): void {
    const id = message.id;
    let batch: GnmiNotification[] = [];
    let batchBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!batch.length) return;
      send(this.socket, { op: 'gnmi-notifications', id, notifications: batch, bytes: batchBytes });
      batch = [];
      batchBytes = 0;
    };
    running.subscription = this.requireGnmi().subscribe(message, message.encoding ?? this.encoding, {
      notification: (notification, bytes) => {
        batch.push(notification);
        batchBytes += bytes;
        if (batch.length >= NOTIFICATION_BATCH_LIMIT) flush();
        else timer ??= setTimeout(flush, NOTIFICATION_FLUSH_MS);
      },
      sync: () => {
        flush();
        send(this.socket, { op: 'gnmi-sync', id });
      },
      end: (error) => {
        flush();
        this.running.delete(id);
        const ended = error && error.code !== GrpcCode.CANCELLED ? describeError(error) : undefined;
        send(this.socket, { op: 'stream-end', id, ...(ended ? { error: ended } : {}) });
      },
    });
  }
}

function subsystemError(err: Error): Error {
  return new Error(
    /unknown|not supported|fail/i.test(err.message)
      ? 'The SSH server has no NETCONF subsystem. Check that NETCONF is enabled on the device and the port is right (usually 830).'
      : `Could not open the NETCONF subsystem: ${err.message}`,
  );
}

export function registerManagementSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/management', { websocket: true }, (socket) => {
    new ManagementSession(socket, ctx, app.log).start();
  });
}
