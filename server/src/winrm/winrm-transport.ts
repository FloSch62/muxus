import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import type { WinrmProfile } from '@muxus/shared';
import { WINRM_HTTP_PORT } from '@muxus/shared/ws-protocol';
import type { ConnectIo, MuxedConnectionLease, SshConnectionManager } from '../ssh/connection-manager.js';
import { connectGateway, gatewayCandidates } from '../ssh/gateways.js';
import { DesktopPasswords, type VaultPasswordRef } from '../remote-desktop/desktop-passwords.js';
import {
  desktopPasswordAccount,
  desktopPasswordLabel,
  type PasswordVault,
} from '../security/password-vault.js';
import type { TerminalTransport } from '../transports/terminal-transport.js';
import { connectTcp, connectThroughGateway } from '../util/dial.js';
import { SIGNAL, WinrmAuthError, WinrmChannel, WinrmShell, type WinrmEndpoint } from './winrm-client.js';
import { LineEditor } from './line-editor.js';

export interface WinrmDeps {
  connections: Pick<SshConnectionManager, 'connect'>;
  vault: PasswordVault | undefined;
  io: ConnectIo;
  log: FastifyBaseLogger;
  /** True once the tab has gone away, to stop asking questions. */
  closed(): boolean;
}

const LOGIN_ATTEMPTS = 3;

/**
 * A remote Windows shell over WinRM as a terminal transport. WinRS gives the
 * command plain pipes, not a console, so this side edits the line the way
 * `winrs` does: typed text is echoed and edited locally and sent on Enter;
 * Ctrl+C is sent as a signal. One connection waits for output while another
 * carries input, so typing never queues behind a pending read.
 */
export class WinrmTransport implements TerminalTransport {
  private readonly dataListeners = new Set<(data: Buffer) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly editor: LineEditor;
  private sending: Promise<void> = Promise.resolve();
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private closed = false;
  private lastByte = 0;

  private constructor(
    private readonly shell: WinrmShell,
    private readonly receiver: WinrmChannel,
    private readonly sender: WinrmChannel,
    private readonly gateway: MuxedConnectionLease | undefined,
    private readonly log: FastifyBaseLogger,
  ) {
    this.editor = new LineEditor({
      echo: (text) => this.emit(Buffer.from(text, 'utf8')),
      line: (text) => this.queueSend(Buffer.from(`${text}\r\n`, 'utf8')),
      interrupt: () => this.queueSignal(SIGNAL.ctrlC),
    });
    gateway?.connection.onClose(() => this.finish(new Error('The SSH gateway disconnected.')));
    void this.receiveLoop();
  }

  static async connect(profile: WinrmProfile, deps: WinrmDeps): Promise<WinrmTransport> {
    const https = profile.https === true;
    const port = profile.port ?? WINRM_HTTP_PORT;
    const auth = profile.auth ?? 'negotiate';
    if (auth === 'basic' && !https) {
      throw new Error('Basic authentication needs HTTPS; it would send the password in the clear.');
    }

    let gateway: MuxedConnectionLease | undefined;
    let gatewayKey = '';
    let gatewayLabel: string | undefined;
    const candidates = gatewayCandidates(profile);
    if (candidates.length > 0) {
      const connected = await connectGateway(deps.connections, candidates, deps.io, 'terminal', () => deps.closed());
      gateway = connected.lease;
      const primary = candidates[0]!;
      gatewayKey = primary.profileId ? `profile:${primary.profileId}` : `ssh:${primary.target}`;
      gatewayLabel = connected.gateway.target;
    }

    const openStream = async (): Promise<Duplex> => {
      const raw: Duplex = gateway
        ? await connectThroughGateway(gateway.connection.client, profile.host, port)
        : await connectTcp(profile.host, port);
      if (!https) return raw;
      return new Promise((resolve, reject) => {
        const socket = tls.connect({
          socket: raw,
          servername: /^[\d.:]+$/.test(profile.host) ? undefined : profile.host,
          rejectUnauthorized: profile.tlsVerify !== 'skip-verify',
        });
        socket.once('secureConnect', () => resolve(socket));
        socket.once('error', (err) =>
          reject(
            /certificate|self.signed|unable to verify/i.test(err.message)
              ? new Error(
                  `The WinRM server's certificate is not trusted (${err.message}). Choose “Do not check the certificate” for a self-signed one.`,
                )
              : err,
          ),
        );
      });
    };

    const passwords = new DesktopPasswords(deps.vault, deps.io);
    const target = (user: string): VaultPasswordRef => {
      const input = {
        protocol: 'winrm' as const,
        user,
        host: profile.host,
        port,
        gateway: gatewayKey,
        gatewayLabel,
        domain: '',
      };
      return { account: desktopPasswordAccount(input), label: desktopPasswordLabel(input) };
    };

    try {
      let username = profile.username?.trim() ?? '';
      let rejected = false;
      for (let attempt = 0; attempt < LOGIN_ATTEMPTS; attempt++) {
        let password: string | undefined;
        let remember = false;
        if (!rejected && username) {
          password = await passwords.read(target(username));
          if (password !== undefined) deps.io.status(`Using the saved password for ${target(username).label}.`, { transient: true });
        }
        if (password === undefined) {
          const askUser = !username;
          const ref = username ? target(username) : undefined;
          const response = await deps.io.prompt({
            name: 'WinRM logon',
            host: profile.host,
            instructions: rejected
              ? 'The server rejected the user name or password. Try again.'
              : `Sign in to ${profile.host}. Use DOMAIN\\user or user@domain for a domain account.`,
            prompts: [
              ...(askUser ? [{ prompt: 'User name', echo: true }] : []),
              { prompt: 'Password', echo: false },
            ],
            ...(passwords.available
              ? { rememberPassword: { label: ref?.label ?? `WinRM ${profile.host}:${port}`, existing: ref ? passwords.has(ref) : false } }
              : {}),
          });
          if (response.skipped) throw new Error('Logon cancelled.');
          if (askUser) username = (response.answers[0] ?? '').trim();
          password = response.answers[askUser ? 1 : 0] ?? '';
          remember = response.rememberPassword === true;
        }
        if (deps.closed()) throw new Error('connection closed');

        const endpoint: WinrmEndpoint = {
          host: profile.host,
          port,
          https,
          auth,
          username,
          password,
          openStream,
        };
        deps.io.status(`Connecting to ${profile.host}:${port} over WinRM …`, { transient: true });
        let receiver: WinrmChannel | undefined;
        let sender: WinrmChannel | undefined;
        try {
          receiver = await WinrmChannel.open(endpoint);
          const command = profile.shell === 'powershell' ? 'powershell.exe -NoLogo' : 'cmd.exe';
          const shell = await WinrmShell.start(receiver, endpoint, command);
          sender = await WinrmChannel.open(endpoint);
          if (remember && username) {
            // The shell is up: failing to save must never tear it down.
            await passwords.remember(target(username), password).catch((err: unknown) => {
              deps.io.status(`The password could not be remembered: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          return new WinrmTransport(shell, receiver, sender, gateway, deps.log);
        } catch (err) {
          receiver?.close();
          sender?.close();
          if (err instanceof WinrmAuthError) {
            rejected = true;
            continue;
          }
          throw err;
        }
      }
      throw new WinrmAuthError('The WinRM server rejected the user name or password.');
    } catch (err) {
      gateway?.release();
      throw err;
    }
  }

  // --- TerminalTransport ---

  write(data: Buffer): void {
    if (!this.closed) this.editor.input(data.toString('utf8'));
  }

  drain(): Promise<void> {
    return this.sending;
  }

  resize(): void {
    // Pipes have no window size.
  }

  async sendBreak(): Promise<void> {
    await this.queueSignal(SIGNAL.ctrlBreak);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const waiter of this.resumeWaiters.splice(0)) waiter();
  }

  close(): void {
    if (this.closed) return;
    // Ask the server to end the shell, then drop both connections.
    const sender = this.sender;
    void this.shell
      .signal(sender, SIGNAL.terminate)
      .catch(() => undefined)
      .then(() => this.shell.delete(sender))
      .catch(() => undefined)
      .finally(() => sender.close());
    this.finish(undefined, true);
  }

  onData(listener: (data: Buffer) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // --- internals ---

  private emit(data: Buffer): void {
    for (const listener of this.dataListeners) listener(data);
  }

  /** Output as a terminal expects it: a bare LF also returns the cursor. */
  private emitOutput(data: Buffer): void {
    const out: number[] = [];
    for (const byte of data) {
      if (byte === 0x0a && this.lastByte !== 0x0d) out.push(0x0d);
      out.push(byte);
      this.lastByte = byte;
    }
    this.emit(Buffer.from(out));
  }

  private queueSend(data: Buffer): Promise<void> {
    this.sending = this.sending
      .then(() => this.shell.send(this.sender, data))
      .then(
        () => undefined,
        (err: unknown) => this.fail(err),
      );
    return this.sending;
  }

  private queueSignal(code: string): Promise<void> {
    this.sending = this.sending
      .then(() => this.shell.signal(this.sender, code))
      .then(
        () => undefined,
        (err: unknown) => this.fail(err),
      );
    return this.sending;
  }

  private async receiveLoop(): Promise<void> {
    while (!this.closed) {
      if (this.paused) await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
      try {
        const result = await this.shell.receive(this.receiver);
        for (const chunk of result.chunks) this.emitOutput(chunk.data);
        if (result.done) {
          this.log.info({ exitCode: result.exitCode }, 'winrm shell ended');
          this.finish();
          return;
        }
      } catch (err) {
        if (!this.closed) this.fail(err);
        return;
      }
    }
  }

  private fail(err: unknown): void {
    if (this.closed) return;
    const error = err instanceof Error ? err : new Error(String(err));
    this.log.warn({ err: error }, 'winrm session failed');
    for (const listener of this.errorListeners) listener(error);
    this.finish();
  }

  /** `keepSender` while close() still uses it to end the remote shell. */
  private finish(error?: Error, keepSender = false): void {
    if (this.closed) return;
    if (error) for (const listener of this.errorListeners) listener(error);
    this.closed = true;
    this.receiver.close();
    if (!keepSender) this.sender.close();
    this.gateway?.release();
    for (const waiter of this.resumeWaiters.splice(0)) waiter();
    for (const listener of this.closeListeners) listener();
  }
}
