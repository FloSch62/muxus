import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { X11_TCP_PORT_BASE } from './display.js';
import { FAMILY_WILD, MIT_MAGIC_COOKIE, serializeXauthority, type X11Auth } from './xauthority.js';

export const VCXSRV_EXECUTABLE = 'vcxsrv.exe';

/** Display numbers tried in order; :0 is left to any X server the user runs. */
const FIRST_DISPLAY = 10;
const LAST_DISPLAY = 99;
const START_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;

export interface RunningXServer {
  display: number;
  port: number;
  auth: X11Auth;
}

export interface BundledXServerOptions {
  /** Test seams; production spawns VcXsrv and probes loopback TCP. */
  spawnServer?: (executable: string, args: string[], cwd: string) => ChildProcess;
  portInUse?: (port: number) => Promise<boolean>;
  authDirectory?: string;
}

/**
 * The VcXsrv build shipped with the Windows app, started on first use.
 *
 * It gets its own display number and a fresh MIT-MAGIC-COOKIE-1 in a private
 * auth file, so only Muxus (and nothing else on the machine) can open windows
 * on it. One server is shared by every SSH session and stops with Muxus.
 */
export class BundledXServer {
  private starting?: Promise<RunningXServer>;
  private child?: ChildProcess;
  private authFile?: string;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly log: FastifyBaseLogger,
    private readonly options: BundledXServerOptions = {},
  ) {}

  get executable(): string {
    return path.join(this.directory, VCXSRV_EXECUTABLE);
  }

  installed(): boolean {
    return fs.existsSync(this.executable);
  }

  /** Start the server if it is not running; concurrent callers share one start. */
  ensureRunning(): Promise<RunningXServer> {
    if (this.closed) return Promise.reject(new Error('the X server is shutting down'));
    this.starting ??= this.start().catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  close(): void {
    this.closed = true;
    this.starting = undefined;
    this.child?.kill();
    this.child = undefined;
    if (this.authFile) fs.rmSync(this.authFile, { force: true });
  }

  private async start(): Promise<RunningXServer> {
    const portInUse = this.options.portInUse ?? loopbackPortInUse;
    let display: number | undefined;
    for (let candidate = FIRST_DISPLAY; candidate <= LAST_DISPLAY; candidate++) {
      if (!(await portInUse(X11_TCP_PORT_BASE + candidate))) {
        display = candidate;
        break;
      }
    }
    if (display === undefined) throw new Error('no free X display number for the bundled X server');

    const auth: X11Auth = { name: MIT_MAGIC_COOKIE, data: randomBytes(16) };
    const authDirectory = this.options.authDirectory ?? os.tmpdir();
    const authFile = path.join(authDirectory, `muxus-x11-${process.pid}.Xauthority`);
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
      '-clipboard',
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
    child.once('error', (err) => {
      exited = err.message;
    });
    child.once('exit', (code, signal) => {
      exited ??= `exited with ${signal ?? `code ${code}`}`;
      if (this.child === child) {
        this.child = undefined;
        // A later X11 channel starts a fresh server.
        this.starting = undefined;
        if (!this.closed) this.log.warn({ display, reason: exited }, 'bundled X server stopped');
      }
    });

    const port = X11_TCP_PORT_BASE + display;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await portInUse(port))) {
      if (exited) throw new Error(`the bundled X server failed to start (${exited})`);
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('the bundled X server did not start in time');
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    this.log.info({ display }, 'bundled X server started');
    return { display, port, auth };
  }
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
