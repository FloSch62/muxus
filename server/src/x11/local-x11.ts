import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import type { Client, ClientChannel, X11Details, X11Options } from 'ssh2';
import type { X11Availability } from '@muxus/shared';
import { connectX11Endpoint, parseDisplay, type ParsedDisplay } from './display.js';
import { BundledXServer, type BundledXServerOptions } from './vcxsrv.js';
import { spliceX11Connection } from './x11-proxy.js';
import { MIT_MAGIC_COOKIE, readXauthCookie, xauthorityPath, type X11Auth } from './xauthority.js';

export interface LocalX11Options {
  log: FastifyBaseLogger;
  /** Directory of the X server bundled with the Windows app (vcxsrv.exe). */
  bundledServerDirectory?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam for the bundled server. */
  bundled?: BundledXServerOptions;
}

type Source =
  | { kind: 'bundled'; server: BundledXServer }
  | { kind: 'display'; display: string; parsed: ParsedDisplay }
  | { kind: 'none' };

/**
 * The local X server that forwarded X11 connections land on.
 *
 * On Windows that is the bundled VcXsrv: a dedicated server that only shows
 * forwarded windows, so forwarding is on by default like MobaXterm. Elsewhere
 * it is the user's own display from $DISPLAY (XQuartz's launchd socket on
 * macOS); a remote client there can see that whole desktop, so forwarding
 * stays opt-in per host, as with OpenSSH's ForwardX11.
 */
export class LocalX11 {
  private readonly log: FastifyBaseLogger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly bundled?: BundledXServer;
  private launchdDisplay?: string | null;

  constructor(options: LocalX11Options) {
    this.log = options.log;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    if (options.bundledServerDirectory) {
      this.bundled = new BundledXServer(options.bundledServerDirectory, options.log, options.bundled);
    }
  }

  availability(): X11Availability {
    const source = this.source();
    switch (source.kind) {
      case 'bundled':
        return { source: 'bundled', defaultEnabled: true };
      case 'display':
        return { source: 'display', defaultEnabled: false, display: source.display };
      default:
        return { source: 'none', defaultEnabled: false };
    }
  }

  /** Whether a session should ask for X11: the host's ForwardX11, else the platform default. */
  wanted(forwardX11: boolean | undefined): boolean {
    const availability = this.availability();
    if (availability.source === 'none') return false;
    return forwardX11 ?? availability.defaultEnabled;
  }

  /** Screen number sent in x11-req; remote DISPLAY becomes localhost:N.<screen>. */
  screen(): number {
    const source = this.source();
    return source.kind === 'display' ? source.parsed.screen : 0;
  }

  /** Open a connection to the local X server and the credentials it expects. */
  async connect(): Promise<{ socket: Socket; auth?: X11Auth }> {
    const source = this.source();
    if (source.kind === 'bundled') {
      const running = await source.server.ensureRunning();
      const socket = await connectX11Endpoint({ kind: 'tcp', host: '127.0.0.1', port: running.port });
      return { socket, auth: running.auth };
    }
    if (source.kind === 'display') {
      const socket = await connectX11Endpoint(source.parsed.endpoint);
      const auth = readXauthCookie(source.parsed.number, source.parsed.xauth, xauthorityPath(this.env));
      return { socket, auth };
    }
    throw new Error('no local X server is available');
  }

  /** Shown when a host asks for ForwardX11 but there is nothing local to forward to. */
  missingServerMessage(): string {
    const prefix = 'X11 forwarding is on for this host, but no local X server was found.';
    switch (this.platform) {
      case 'darwin':
        return `${prefix} Install XQuartz from https://www.xquartz.org, log out and back in, then reconnect.`;
      case 'win32':
        return `${prefix} This Muxus build has no bundled X server; set DISPLAY to point at your own X server.`;
      default:
        return `${prefix} Start Muxus from a graphical session so that DISPLAY is set.`;
    }
  }

  close(): void {
    this.bundled?.close();
  }

  private source(): Source {
    // Windows prefers its dedicated server over a $DISPLAY some other tool left behind.
    if (this.bundled?.installed()) return { kind: 'bundled', server: this.bundled };
    const display = this.displayVariable();
    const parsed = display ? parseDisplay(display, this.platform) : undefined;
    if (display && parsed) return { kind: 'display', display, parsed };
    return { kind: 'none' };
  }

  private displayVariable(): string | undefined {
    if (this.env.DISPLAY) return this.env.DISPLAY;
    if (this.platform !== 'darwin') return undefined;
    // Apps started from Finder may miss XQuartz's DISPLAY, but launchd has it.
    if (this.launchdDisplay === undefined) {
      try {
        this.launchdDisplay =
          execFileSync('launchctl', ['getenv', 'DISPLAY'], { encoding: 'utf8', timeout: 2000 }).trim() || null;
      } catch {
        this.launchdDisplay = null;
      }
    }
    return this.launchdDisplay ?? undefined;
  }

  /** Per-transport state: one fake cookie and the handler for incoming X11 channels. */
  attach(client: Client): X11Transport {
    return new X11Transport(this, client, this.log);
  }
}

/**
 * X11 forwarding for one SSH transport. The server only ever sees a random
 * fake cookie; the real local credentials never leave this machine.
 */
export class X11Transport {
  private readonly cookie = randomBytes(16);
  private refusedByServer = false;

  constructor(
    private readonly local: LocalX11,
    client: Client,
    private readonly log: FastifyBaseLogger,
  ) {
    client.on('x11', (info, accept, reject) => this.onChannel(info, accept, reject));
  }

  /** x11-req options for a new session channel, or undefined when X11 should not be requested. */
  request(forwardX11: boolean | undefined): X11Options | undefined {
    if (this.refusedByServer || !this.local.wanted(forwardX11)) return undefined;
    return {
      single: false,
      screen: this.local.screen(),
      protocol: MIT_MAGIC_COOKIE,
      cookie: this.cookie.toString('hex'),
    };
  }

  /** The server answered x11-req with failure; stop asking on this transport. */
  markRefused(): void {
    this.refusedByServer = true;
  }

  get refused(): boolean {
    return this.refusedByServer;
  }

  private onChannel(info: X11Details, accept: () => ClientChannel, reject: () => void): void {
    this.local.connect().then(
      ({ socket, auth }) => {
        let channel: ClientChannel;
        try {
          channel = accept();
        } catch (err) {
          socket.destroy();
          this.log.warn({ err }, 'could not accept a forwarded X11 connection');
          return;
        }
        spliceX11Connection(channel, socket, {
          cookie: this.cookie,
          auth,
          onRejected: (reason) =>
            this.log.warn({ from: `${info.srcIP}:${info.srcPort}`, reason }, 'rejected a forwarded X11 connection'),
        });
      },
      (err: unknown) => {
        reject();
        this.log.warn({ err }, 'forwarded X11 connection refused: the local X server is unavailable');
      },
    );
  }
}

/** ssh2's error when the server answers x11-req with failure. */
export function isX11Rejection(err: unknown): boolean {
  return err instanceof Error && /Unable to request X11/.test(err.message);
}
