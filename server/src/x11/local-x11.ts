import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Client, ClientChannel, X11Details, X11Options } from 'ssh2';
import type { X11SettingsUpdate, X11Status } from '@muxus/shared';
import { connectX11Endpoint, parseDisplay, xauthTarget, type ParsedDisplay } from './display.js';
import {
  BundledXServer,
  VCXSRV_EXECUTABLE,
  type BundledXServerOptions,
  type RunningXServer,
} from './vcxsrv.js';
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

/** How long a macOS `launchctl getenv DISPLAY` answer is reused. */
const LAUNCHD_DISPLAY_TTL_MS = 5_000;

type Source =
  | { kind: 'bundled'; directory: string }
  | { kind: 'display'; display: string; parsed: ParsedDisplay }
  | { kind: 'none' };

/** A bundled X server serving one SSH transport, and its open X connections. */
interface BundledDisplay {
  server: BundledXServer;
  open: number;
}

/**
 * The local X server that forwarded X11 connections land on.
 *
 * On Windows that is the bundled VcXsrv, run as one display per SSH
 * transport: programs from one host cannot see, capture or drive windows
 * from another, and unless the user opts in no display is bridged to the
 * Windows clipboard. That isolation is what makes forwarding safe to turn
 * on by default, like MobaXterm. Elsewhere it is the user's own display from
 * $DISPLAY (XQuartz's launchd socket on macOS); a remote client there can
 * see that whole desktop, so forwarding stays opt-in per host, as with
 * OpenSSH's ForwardX11. On macOS the whole feature starts switched off, since
 * it needs XQuartz first.
 */
export class LocalX11 {
  private readonly log: FastifyBaseLogger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly bundledDirectory?: string;
  private readonly bundledOptions: BundledXServerOptions;
  private readonly bundledDisplays = new Map<object, BundledDisplay>();
  /** Display numbers held by this process's bundled servers. */
  private readonly claimedDisplays = new Set<number>();
  private launchdDisplay?: { value: string | undefined; checkedAt: number };
  /** User choices; unset switches follow the platform default. */
  private settings: X11SettingsUpdate = { clipboard: false };

  constructor(options: LocalX11Options) {
    this.log = options.log;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.bundledDirectory = options.bundledServerDirectory;
    this.bundledOptions = { ...options.bundled, claimedDisplays: this.claimedDisplays };
  }

  /**
   * Apply the application's X11 settings. A clipboard change reaches a
   * running bundled display once it shows no windows, so it never closes them.
   */
  applySettings(settings: X11SettingsUpdate): void {
    this.settings = settings;
  }

  status(): X11Status {
    const source = this.source();
    const defaults = {
      enabled: this.enabledByDefault(),
      forwardByDefault: source.kind === 'bundled',
    };
    return {
      source: source.kind,
      ...(source.kind === 'display' ? { display: source.display } : {}),
      enabled: this.enabled(),
      forwardByDefault: this.settings.forwardByDefault ?? defaults.forwardByDefault,
      clipboard: this.settings.clipboard,
      defaults,
    };
  }

  /** Whether X11 forwarding is switched on at all. */
  enabled(): boolean {
    return this.settings.enabled ?? this.enabledByDefault();
  }

  /**
   * macOS needs XQuartz installed first, so nothing about X11 appears there
   * until the user turns it on.
   */
  private enabledByDefault(): boolean {
    return this.platform !== 'darwin';
  }

  /** Whether a session should ask for X11: the host's ForwardX11, else the app default. */
  wanted(forwardX11: boolean | undefined): boolean {
    if (!this.enabled()) return false;
    const status = this.status();
    if (status.source === 'none') return false;
    return forwardX11 ?? status.forwardByDefault;
  }

  /** Screen number sent in x11-req; remote DISPLAY becomes localhost:N.<screen>. */
  screen(): number {
    const source = this.source();
    return source.kind === 'display' ? source.parsed.screen : 0;
  }

  /**
   * Open a connection to the local X server and the credentials it expects.
   * `domain` (the SSH transport) selects its own bundled display.
   */
  async connect(domain: object = this): Promise<{ socket: Socket; auth?: X11Auth }> {
    const source = this.source();
    if (source.kind === 'display') {
      const socket = await connectX11Endpoint(source.parsed.endpoint);
      const target = xauthTarget(source.parsed.endpoint, socket);
      return { socket, auth: readXauthCookie(source.parsed.number, target, xauthorityPath(this.env)) };
    }
    if (source.kind === 'none') throw new Error('no local X server is available');

    const bundled = this.bundledDisplay(domain, source.directory);
    const running = await this.bundledServer(domain);
    const socket = await connectX11Endpoint({ kind: 'tcp', host: '127.0.0.1', port: running.port });
    bundled.open += 1;
    socket.once('close', () => {
      bundled.open -= 1;
    });
    return { socket, auth: running.auth };
  }

  /** The bundled X server for `domain`, started when needed. */
  bundledServer(domain: object): Promise<RunningXServer> {
    const source = this.source();
    if (source.kind !== 'bundled') return Promise.reject(new Error('no bundled X server is installed'));
    const bundled = this.bundledDisplay(domain, source.directory);
    // A clipboard change restarts the display only while it shows no windows.
    return bundled.server.ensureRunning(this.settings.clipboard, bundled.open === 0);
  }

  /** Stop the bundled display of an SSH transport that has closed. */
  release(domain: object): void {
    const bundled = this.bundledDisplays.get(domain);
    if (!bundled) return;
    this.bundledDisplays.delete(domain);
    bundled.server.close();
  }

  private bundledDisplay(domain: object, directory: string): BundledDisplay {
    let bundled = this.bundledDisplays.get(domain);
    if (!bundled) {
      bundled = { server: new BundledXServer(directory, this.log, this.bundledOptions), open: 0 };
      this.bundledDisplays.set(domain, bundled);
    }
    return bundled;
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
    for (const bundled of this.bundledDisplays.values()) bundled.server.close();
    this.bundledDisplays.clear();
  }

  private source(): Source {
    // Windows prefers its dedicated server over a $DISPLAY some other tool left behind.
    if (this.bundledDirectory && fs.existsSync(path.join(this.bundledDirectory, VCXSRV_EXECUTABLE))) {
      return { kind: 'bundled', directory: this.bundledDirectory };
    }
    const display = this.displayVariable();
    const parsed = display ? parseDisplay(display, this.platform) : undefined;
    if (display && parsed) return { kind: 'display', display, parsed };
    return { kind: 'none' };
  }

  private displayVariable(): string | undefined {
    if (this.env.DISPLAY) return this.env.DISPLAY;
    if (this.platform !== 'darwin') return undefined;
    // Apps started from Finder may miss XQuartz's DISPLAY, but launchd has
    // it. Ask again after a while, so installing XQuartz needs no restart.
    const now = Date.now();
    if (!this.launchdDisplay || now - this.launchdDisplay.checkedAt > LAUNCHD_DISPLAY_TTL_MS) {
      let value: string | undefined;
      try {
        value = execFileSync('launchctl', ['getenv', 'DISPLAY'], { encoding: 'utf8', timeout: 2000 }).trim() || undefined;
      } catch {
        value = undefined;
      }
      this.launchdDisplay = { value, checkedAt: now };
    }
    return this.launchdDisplay.value;
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
    // Its X clients are gone with the transport; so is their display.
    client.once('close', () => this.local.release(this));
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
    this.local.connect(this).then(
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
