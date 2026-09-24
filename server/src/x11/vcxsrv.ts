import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { X11_TCP_PORT_BASE } from './display.js';
import { rewriteX11Setup } from './x11-proxy.js';
import { FAMILY_WILD, MIT_MAGIC_COOKIE, serializeXauthority, type X11Auth } from './xauthority.js';

export const VCXSRV_EXECUTABLE = 'vcxsrv.exe';

/** Display numbers tried in order; :0 is left to any X server the user runs. */
const FIRST_DISPLAY = 10;
const LAST_DISPLAY = 99;
const START_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const MAX_START_ATTEMPTS = 3;

export interface RunningXServer {
  display: number;
  port: number;
  auth: X11Auth;
  /** Whether VcXsrv bridges X selections to the Windows clipboard. */
  clipboard: boolean;
}

export interface BundledXServerOptions {
  /** Test seams; production spawns VcXsrv and probes loopback TCP. */
  spawnServer?: (executable: string, args: string[], cwd: string) => ChildProcess;
  portInUse?: (port: number) => Promise<boolean>;
  probeServer?: (port: number, auth: X11Auth) => Promise<XServerProbe>;
  authDirectory?: string;
  /** Display numbers held by sibling servers in this process, shared between them. */
  claimedDisplays?: Set<number>;
}

/**
 * One VcXsrv display from the build shipped with the Windows app, started
 * on first use. LocalX11 runs one per SSH transport.
 *
 * It gets its own display number and a fresh MIT-MAGIC-COOKIE-1 in a private
 * auth file, so only Muxus (and nothing else on the machine) can open windows
 * on it, and it stops with its transport or with Muxus.
 *
 * Clipboard integration is off unless asked for: with it, any forwarding
 * server could read and replace the Windows clipboard.
 */
export class BundledXServer {
  private starting?: Promise<RunningXServer>;
  private running?: RunningXServer;
  private child?: ChildProcess;
  private authFile?: string;
  /** Display number this server holds in the shared claim set. */
  private claimed?: number;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly log: FastifyBaseLogger,
    private readonly options: BundledXServerOptions = {},
  ) {}

  get executable(): string {
    return path.join(this.directory, VCXSRV_EXECUTABLE);
  }

  /**
   * Start the server if it is not running; concurrent callers share one
   * start. A running server with a different clipboard mode is restarted
   * only when `idle` (no forwarded connections would lose their windows).
   */
  ensureRunning(clipboard = false, idle = true): Promise<RunningXServer> {
    if (this.closed) return Promise.reject(new Error('the X server is shutting down'));
    if (this.running && this.running.clipboard !== clipboard && idle) {
      this.log.info({ clipboard }, 'restarting the bundled X server for the clipboard setting');
      this.stop();
    }
    this.starting ??= this.start(clipboard).then(
      (running) => {
        this.running = running;
        return running;
      },
      (err: unknown) => {
        this.starting = undefined;
        throw err;
      },
    );
    return this.starting;
  }

  close(): void {
    this.closed = true;
    this.stop();
    if (this.authFile) fs.rmSync(this.authFile, { force: true });
  }

  private stop(): void {
    this.starting = undefined;
    this.running = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.unclaim();
  }

  private unclaim(): void {
    if (this.claimed !== undefined) this.options.claimedDisplays?.delete(this.claimed);
    this.claimed = undefined;
  }

  private async start(clipboard: boolean): Promise<RunningXServer> {
    const portInUse = this.options.portInUse ?? loopbackPortInUse;
    const claimed = this.options.claimedDisplays ?? new Set<number>();
    let first = FIRST_DISPLAY;
    for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
      let display: number | undefined;
      for (let candidate = first; candidate <= LAST_DISPLAY; candidate++) {
        if (claimed.has(candidate) || (await portInUse(X11_TCP_PORT_BASE + candidate))) continue;
        // A sibling may have claimed it while the port was probed.
        if (claimed.has(candidate)) continue;
        display = candidate;
        claimed.add(display);
        this.claimed = display;
        break;
      }
      if (display === undefined) throw new Error('no free X display number for the bundled X server');
      let running: RunningXServer | undefined;
      try {
        running = await this.launch(display, clipboard);
      } catch (err) {
        this.unclaim();
        throw err;
      }
      if (running) return running;
      // Another X server took the display between the scan and VcXsrv's bind.
      this.unclaim();
      first = display + 1;
    }
    throw new Error('other programs kept taking the display numbers the bundled X server tried');
  }

  /** Start VcXsrv on `display`; undefined when a different server answers there. */
  private async launch(display: number, clipboard: boolean): Promise<RunningXServer | undefined> {
    const auth: X11Auth = { name: MIT_MAGIC_COOKIE, data: randomBytes(16) };
    const authDirectory = this.options.authDirectory ?? os.tmpdir();
    const authFile = path.join(authDirectory, `muxus-x11-${process.pid}-${display}.Xauthority`);
    if (this.authFile && this.authFile !== authFile) fs.rmSync(this.authFile, { force: true });
    fs.writeFileSync(
      authFile,
      serializeXauthority([
        { family: FAMILY_WILD, address: Buffer.alloc(0), number: String(display), ...auth },
      ]),
      { mode: 0o600 },
    );
    this.authFile = authFile;

    const args = [
      `:${display}`,
      '-multiwindow',
      clipboard ? '-clipboard' : '-noclipboard',
      '-wgl',
      '-auth',
      authFile,
      // A race for the display number must not pop up a modal error box.
      '-silent-dup-error',
      '-notrayicon',
    ];
    const spawnServer =
      this.options.spawnServer ??
      ((executable, argv, cwd) => spawn(executable, argv, { cwd, stdio: 'ignore', windowsHide: true }));
    const child = spawnServer(this.executable, args, this.directory);
    this.child = child;
    let exited: string | undefined;
    let ready = false;
    child.once('error', (err) => {
      exited = err.message;
    });
    child.once('exit', (code, signal) => {
      exited ??= `exited with ${signal ?? `code ${code}`}`;
      if (this.child === child) {
        this.child = undefined;
        // A later X11 channel starts a fresh server; a start in progress
        // reports the failure itself.
        if (ready) {
          this.starting = undefined;
          this.running = undefined;
          this.unclaim();
        }
        if (!this.closed) this.log.warn({ display, reason: exited }, 'bundled X server stopped');
      }
    });

    // Readiness is a connection setup with this server's cookie: only the
    // VcXsrv just started can accept it, whatever else listens on the port.
    const probe = this.options.probeServer ?? probeX11Server;
    const port = X11_TCP_PORT_BASE + display;
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const state = await probe(port, auth);
      if (state === 'ours') break;
      if (state === 'foreign') {
        this.child = undefined;
        child.kill();
        this.log.warn({ display }, 'another X server took the display; trying the next one');
        return undefined;
      }
      if (exited) throw new Error(`the bundled X server failed to start (${exited})`);
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('the bundled X server did not start in time');
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    ready = true;
    this.log.info({ display, clipboard }, 'bundled X server started');
    return { display, port, auth, clipboard };
  }
}

/** 'ours' accepted the cookie, 'foreign' is an X server that refused it, 'down' did not answer. */
export type XServerProbe = 'ours' | 'foreign' | 'down';

/** Little-endian X11 protocol 11.0 connection setup header. */
const SETUP_HEADER = Buffer.from([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Attempt an X11 connection setup on 127.0.0.1:port with `auth`. */
export function probeX11Server(port: number, auth: X11Auth): Promise<XServerProbe> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, noDelay: true });
    const done = (state: XServerProbe) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(2000, () => done('down'));
    socket.once('error', () => done('down'));
    socket.once('close', () => done('down'));
    socket.once('connect', () => socket.write(rewriteX11Setup(SETUP_HEADER, true, auth)));
    // Status byte: 1 Success; 0 Failed and 2 Authenticate mean the cookie was refused.
    socket.once('data', (reply: Buffer) => done(reply[0] === 1 ? 'ours' : 'foreign'));
  });
}

/** True when something accepts connections on 127.0.0.1:port. */
export function loopbackPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
