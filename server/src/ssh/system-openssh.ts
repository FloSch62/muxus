import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import pty from 'node-pty';
import type { SFTPWrapper } from 'ssh2';
import {
  environmentCommandLine,
  savedHostHopId,
  withoutAppImagePaths,
  type SshProfile,
} from '@muxus/shared';
import { DEFAULT_TERM, ptyEnvironment } from '../local/pty-manager.js';
import type { TerminalTransport } from '../transports/terminal-transport.js';
import { sftpOverStdio } from './sftp-over-stdio.js';
import { parseHostSpec } from './ssh-config.js';

/**
 * A host set to "Use system OpenSSH" connects through the `ssh` program of the
 * computer rather than ssh2. The terminal is `ssh` under a PTY, so every prompt
 * and error is OpenSSH's own and all authentication it knows works, GSSAPI
 * included.
 *
 * The file browser, status bar and container discovery share that login over a
 * private control socket. Windows OpenSSH has no connection sharing, so sessions
 * there are terminal only.
 */

/** Keeps the shared connection alive through a crash; a normal close ends it at once. */
const CONTROL_PERSIST_SECONDS = 60;
/** How long a file request waits for the login happening in the terminal. */
const LOGIN_WAIT_MS = 30_000;
const LOGIN_POLL_MS = 200;
const SFTP_START_TIMEOUT_MS = 20_000;
const CONTROL_EXIT_TIMEOUT_MS = 5_000;
/** `ssh` exits with this for its own failures; otherwise it passes on the remote status. */
const SSH_OWN_FAILURE = 255;
/** Longest a script run over the shared login may take, and how much it may print. */
const SCRIPT_TIMEOUT_MS = 60_000;
const SCRIPT_MAX_OUTPUT = 16 * 1024 * 1024;
const COMMAND_PROBE_TIMEOUT_MS = 20_000;
/** A shell prints the sum; a device CLI that echoes what it was sent does not. */
const COMMAND_PROBE = 'echo "muxus$((40+2))"';
const COMMAND_PROBE_ANSWER = 'muxus42';

type Env = Record<string, string | undefined>;

export function findSshBinary(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  // Windows spells it Path, and a copied environment is case-sensitive.
  const pathKey = Object.keys(env).find((key) => (windows ? key.toUpperCase() === 'PATH' : key === 'PATH'));
  const directories = (pathKey ? (env[pathKey] ?? '') : '').split(paths.delimiter).filter(Boolean);
  const candidates = directories.map((directory) => paths.join(directory, windows ? 'ssh.exe' : 'ssh'));
  if (windows) {
    if (env.SystemRoot) candidates.push(paths.join(env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe'));
  } else {
    candidates.push('/usr/bin/ssh');
  }
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function option(keyword: string, value: string | number): string[] {
  return ['-o', `${keyword}=${value}`];
}

/** Quote a value for options ssh splits into words, such as paths with spaces. */
function quotedOption(keyword: string, value: string): string[] {
  const quoted = /[\s"\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
  return option(keyword, quoted);
}

/** The destination `ssh` is given, with the user and port that override its config. */
export function sshDestination(profile: SshProfile): { options: string[]; destination: string } {
  // A saved host's target may carry its own user and port; an alias is passed as is.
  const spec =
    profile.useConfig === false ? parseHostSpec(profile.target) : { host: profile.target };
  const user = profile.user ?? ('user' in spec ? spec.user : undefined);
  const port = profile.port ?? ('port' in spec ? spec.port : undefined);
  return {
    options: [...(user ? ['-l', user] : []), ...(port ? ['-p', String(port)] : [])],
    destination: spec.host,
  };
}

function forwardTarget(host: string | undefined, port: number | undefined): string {
  const name = host?.includes(':') ? `[${host}]` : (host ?? 'localhost');
  return `${name}:${port ?? 0}`;
}

/**
 * Options for a saved host's own settings. It has no ssh_config block, so they
 * go on the command line, where they outrank anything a `Host *` block says.
 * GSSAPI is requested too, since a saved host has nowhere else to ask for it.
 */
export function savedHostOptions(profile: SshProfile): string[] {
  if (profile.useConfig !== false) return [];
  const args: string[] = [];
  for (const file of profile.identityFiles ?? []) args.push('-i', file);
  for (const file of profile.certificateFiles ?? []) args.push(...quotedOption('CertificateFile', file));
  if (profile.identitiesOnly !== undefined) {
    args.push(...option('IdentitiesOnly', profile.identitiesOnly ? 'yes' : 'no'));
  }
  if (profile.identityAgent) args.push(...quotedOption('IdentityAgent', profile.identityAgent));
  if (profile.forwardAgent !== undefined) {
    args.push(...option('ForwardAgent', profile.forwardAgent ? 'yes' : 'no'));
  }
  if (profile.forwardX11 !== undefined) {
    args.push(...option('ForwardX11', profile.forwardX11 ? 'yes' : 'no'));
  }
  if (profile.proxyJump?.length) args.push('-J', profile.proxyJump.join(','));
  // These two take the rest of the line, so quotes would become part of the command.
  if (profile.proxyCommand) args.push(...option('ProxyCommand', profile.proxyCommand));
  if (profile.remoteCommand) {
    args.push(...option('RemoteCommand', profile.remoteCommand.replace(/%/g, '%%')));
  }
  if (profile.requestTty) args.push(...option('RequestTTY', profile.requestTty));
  if (profile.keepaliveIntervalSeconds) {
    args.push(...option('ServerAliveInterval', profile.keepaliveIntervalSeconds));
  }
  for (const forward of profile.forwards ?? []) {
    if (forward.type === 'dynamic') args.push('-D', String(forward.bindPort));
    else {
      args.push(
        forward.type === 'local' ? '-L' : '-R',
        `${forward.bindPort}:${forwardTarget(forward.targetHost, forward.targetPort)}`,
      );
    }
  }
  if (profile.passwordOnly) {
    args.push(
      ...option('PubkeyAuthentication', 'no'),
      ...option('PreferredAuthentications', 'keyboard-interactive,password'),
    );
  } else {
    args.push(...option('GSSAPIAuthentication', 'yes'));
  }
  return args;
}

/** Everything but the program name for the terminal's `ssh`. */
export function terminalSshArgs(profile: SshProfile, controlPath: string | undefined): string[] {
  const { options, destination } = sshDestination(profile);
  const sharing = controlPath
    ? [
        ...option('ControlMaster', 'yes'),
        ...option('ControlPath', controlPath),
        // Backgrounds the master after login, so the terminal's `ssh` ends with
        // the remote shell instead of waiting for the file browser to leave.
        ...option('ControlPersist', CONTROL_PERSIST_SECONDS),
      ]
    : // A config shared with another computer must not turn on what this one lacks.
      [...option('ControlMaster', 'no'), ...option('ControlPath', 'none')];
  const environment = profile.environment ? environmentCommandLine(profile.environment) : undefined;
  return [
    // Pasted text must never be read as an `~.` disconnect.
    ...option('EscapeChar', 'none'),
    ...sharing,
    // The first value wins, so these go before anything the host's settings add.
    ...(environment ? [...option('RemoteCommand', 'none'), ...option('RequestTTY', 'force')] : []),
    ...savedHostOptions(profile),
    ...options,
    '--',
    destination,
    ...(environment ? [environment] : []),
  ];
}

/** Options of an `ssh` that runs one background job rather than the user's session. */
function backgroundJobOptions(): string[] {
  return [
    '-T',
    ...option('BatchMode', 'yes'),
    ...option('LogLevel', 'ERROR'),
    // A config's values for these belong to the terminal, and would clash with a command.
    ...option('RemoteCommand', 'none'),
    ...option('RequestTTY', 'no'),
    ...option('ClearAllForwardings', 'yes'),
    ...option('ForwardAgent', 'no'),
    ...option('ForwardX11', 'no'),
    ...option('PermitLocalCommand', 'no'),
  ];
}

function sharedLoginArgs(profile: SshProfile, controlPath: string, command: readonly string[]): string[] {
  const { options, destination } = sshDestination(profile);
  return [
    ...backgroundJobOptions(),
    ...option('ControlMaster', 'no'),
    ...option('ControlPath', controlPath),
    ...options,
    '--',
    destination,
    ...command,
  ];
}

/** Everything but the program name for the `ssh` that carries SFTP over the shared login. */
export function sftpSshArgs(profile: SshProfile, controlPath: string): string[] {
  return ['-s', ...sharedLoginArgs(profile, controlPath, ['sftp'])];
}

/** Everything but the program name for the `ssh` that feeds a script to the host's sh. */
export function scriptSshArgs(profile: SshProfile, controlPath: string): string[] {
  return sharedLoginArgs(profile, controlPath, ['sh -s']);
}

/**
 * Everything but the program name for the `ssh` that asks whether the host runs
 * commands. This one logs in on its own connection: some devices drop the whole
 * connection when asked to exec (issue #267), which must not take the terminal
 * with it. BatchMode means a host that needs a person to log in just answers no.
 */
export function commandProbeArgs(profile: SshProfile): string[] {
  const { options, destination } = sshDestination(profile);
  return [
    ...backgroundJobOptions(),
    ...option('ControlMaster', 'no'),
    ...option('ControlPath', 'none'),
    ...option('ConnectTimeout', 10),
    ...savedHostOptions(profile),
    ...options,
    '--',
    destination,
    COMMAND_PROBE,
  ];
}

/** What the file routes use of a connection; the ssh2 kind has the same members. */
export interface SftpConnection {
  id: string;
  sftp(): Promise<SFTPWrapper>;
  onClose(listener: (reason?: string) => void): () => void;
}

export interface SystemOpenSshConnection extends SftpConnection {
  /** Whether scripts may run here; automatic readings ask first, as they do on ssh2. */
  runsCommands(): Promise<boolean>;
  /** Feed a script to the host's sh over the shared login and return what it prints. */
  runScript: (script: string) => Promise<string>;
}

export interface SystemOpenSshLease {
  connection: SystemOpenSshConnection;
  release: () => void;
}

interface SessionTools {
  /** The `ssh` program; found on PATH when absent. */
  binary?: string;
  /** Put before every other argument. */
  extraArgs?: readonly string[];
}

export class SystemOpenSshSession implements TerminalTransport {
  readonly id = `system-ssh-${nanoid(10)}`;
  readonly sftpAvailable: boolean;
  private readonly binary: string;
  private readonly extraArgs: readonly string[];
  private readonly env: Env;
  private readonly terminal: pty.IPty;
  private readonly controlDir: string | undefined;
  private readonly controlPath: string | undefined;
  private readonly dataListeners = new Set<(data: Buffer) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly connectionListeners = new Set<(reason?: string) => void>();
  private readonly children = new Set<ChildProcess>();
  private sftpPromise: Promise<SFTPWrapper> | undefined;
  private commandProbe: Promise<boolean> | undefined;
  private terminalRunning = true;
  private leases = 0;
  private finished = false;

  readonly connection: SystemOpenSshConnection = {
    id: this.id,
    sftp: () => this.sftp(),
    runsCommands: () => this.runsCommands(),
    runScript: (script) => this.runScript(script),
    onClose: (listener) => {
      if (this.finished) {
        queueMicrotask(() => listener());
        return () => undefined;
      }
      this.connectionListeners.add(listener);
      return () => this.connectionListeners.delete(listener);
    },
  };

  constructor(
    private readonly profile: SshProfile,
    cols: number,
    rows: number,
    sharing: boolean,
    tools: SessionTools,
    private readonly onFinished: (session: SystemOpenSshSession) => void,
  ) {
    this.env = withoutAppImagePaths(ptyEnvironment());
    const binary = tools.binary ?? findSshBinary(this.env);
    if (!binary) {
      throw new Error(
        'This host uses system OpenSSH, but no ssh program was found. Install the OpenSSH client or turn the option off in the host settings.',
      );
    }
    this.binary = binary;
    this.extraArgs = tools.extraArgs ?? [];
    this.sftpAvailable = sharing && process.platform !== 'win32';
    if (this.sftpAvailable) {
      // Socket paths are limited to about 100 bytes and a TMPDIR can use most
      // of that, so this stays in /tmp. mkdtemp makes the directory private.
      this.controlDir = mkdtempSync('/tmp/muxus-ssh-');
      this.controlPath = path.join(this.controlDir, 'c');
    }
    this.terminal = pty.spawn(
      binary,
      [...this.extraArgs, ...terminalSshArgs(profile, this.controlPath)],
      { name: DEFAULT_TERM, cols, rows, cwd: os.homedir(), env: this.env },
    );
    this.terminal.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      for (const listener of this.dataListeners) listener(chunk);
    });
    this.terminal.onExit(({ exitCode }) => {
      this.terminalRunning = false;
      if (exitCode === SSH_OWN_FAILURE) {
        const error = new Error(
          'ssh could not connect, or lost the connection. Its own message is in the terminal above.',
        );
        for (const listener of this.errorListeners) listener(error);
      } else {
        for (const listener of this.closeListeners) listener();
      }
      this.finishIfUnused();
    });
  }

  write(data: Buffer): void {
    if (this.terminalRunning) this.terminal.write(data.toString('utf8'));
  }

  async drain(): Promise<void> {
    /* The PTY takes what it is given. */
  }

  resize(cols: number, rows: number): void {
    if (this.terminalRunning) this.terminal.resize(cols, rows);
  }

  sendBreak(): Promise<void> {
    return Promise.reject(new Error('BREAK is not available with system OpenSSH.'));
  }

  pause(): void {
    this.terminal.pause();
  }

  resume(): void {
    this.terminal.resume();
  }

  /** End the terminal. File transfers still holding a lease finish first. */
  close(): void {
    if (this.terminalRunning) this.terminal.kill();
    this.finishIfUnused();
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

  acquire(): SystemOpenSshLease | undefined {
    if (this.finished) return undefined;
    this.leases += 1;
    let released = false;
    return {
      connection: this.connection,
      release: () => {
        if (released) return;
        released = true;
        this.leases -= 1;
        this.finishIfUnused();
      },
    };
  }

  /** End everything before returning, leases or not: the server is shutting down. */
  destroy(): void {
    if (this.terminalRunning) this.terminal.kill();
    this.terminalRunning = false;
    this.finish(true);
  }

  private finishIfUnused(): void {
    if (!this.terminalRunning && this.leases === 0) this.finish();
  }

  private finish(waitForStop = false): void {
    if (this.finished) return;
    this.finished = true;
    for (const child of this.children) child.kill();
    for (const listener of this.connectionListeners) listener();
    this.connectionListeners.clear();
    this.onFinished(this);
    this.stopSharedConnection(waitForStop);
  }

  private stopSharedConnection(wait: boolean): void {
    const { controlDir, controlPath } = this;
    if (!controlDir || !controlPath) return;
    const removeDir = () => rmSync(controlDir, { recursive: true, force: true });
    if (!existsSync(controlPath)) {
      removeDir();
      return;
    }
    const { options, destination } = sshDestination(this.profile);
    const args = [
      ...this.extraArgs,
      ...option('ControlPath', controlPath),
      ...option('LogLevel', 'ERROR'),
      '-O',
      'exit',
      ...options,
      '--',
      destination,
    ];
    if (wait) {
      spawnSync(this.binary, args, {
        stdio: 'ignore',
        env: this.env,
        timeout: CONTROL_EXIT_TIMEOUT_MS,
      });
      removeDir();
      return;
    }
    const stop = spawn(this.binary, args, { stdio: 'ignore', env: this.env });
    const timer = setTimeout(() => stop.kill(), CONTROL_EXIT_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      removeDir();
    };
    stop.once('error', done);
    stop.once('close', done);
  }

  private sftp(): Promise<SFTPWrapper> {
    if (!this.sftpAvailable || !this.controlPath) {
      return Promise.reject(new Error('The file browser is not available for this session.'));
    }
    if (this.sftpPromise) return this.sftpPromise;
    const pending = this.openSftp(this.controlPath);
    this.sftpPromise = pending;
    const forget = () => {
      if (this.sftpPromise === pending) this.sftpPromise = undefined;
    };
    pending.then((sftp) => sftp.once('close', forget), forget);
    return pending;
  }

  private spawnJob(args: readonly string[]) {
    const child = spawn(this.binary, [...this.extraArgs, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    // A job that exits early must not fail on what is still being written to it.
    child.stdin.on('error', () => undefined);
    return child;
  }

  /** Run one job to its end, for its output and exit status. */
  private runJob(
    args: readonly string[],
    input: string,
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnJob(args);
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        if (size + data.length > SCRIPT_MAX_OUTPUT) return;
        size += data.length;
        chunks.push(data);
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr = `${stderr}${data.toString('utf8')}`.slice(-2048);
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: stderr.trim() });
      });
      child.stdin.end(input);
    });
  }

  private runsCommands(): Promise<boolean> {
    const { controlPath } = this;
    if (!controlPath) return Promise.resolve(false);
    if (this.commandProbe) return this.commandProbe;
    const pending = this.waitForLogin(controlPath).then(async () => {
      const { code, stdout } = await this.runJob(
        commandProbeArgs(this.profile),
        '',
        COMMAND_PROBE_TIMEOUT_MS,
      );
      return code === 0 && stdout.includes(COMMAND_PROBE_ANSWER);
    });
    this.commandProbe = pending;
    // Not logged in yet says nothing about the host, so that one is asked again.
    pending.catch(() => {
      if (this.commandProbe === pending) this.commandProbe = undefined;
    });
    return pending;
  }

  private async runScript(script: string): Promise<string> {
    const { controlPath } = this;
    if (!controlPath) throw new Error('Commands are not available for this session.');
    await this.waitForLogin(controlPath);
    const { code, stdout, stderr } = await this.runJob(
      scriptSshArgs(this.profile, controlPath),
      script,
      SCRIPT_TIMEOUT_MS,
    );
    if (code === SSH_OWN_FAILURE) throw new Error(stderr || 'ssh could not run the command.');
    return stdout;
  }

  /** The socket appears once the login in the terminal has succeeded. */
  private async waitForLogin(controlPath: string): Promise<void> {
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (!existsSync(controlPath)) {
      if (!this.terminalRunning) throw new Error('The terminal session has ended.');
      if (Date.now() >= deadline) {
        throw new Error('Finish logging in in the terminal, then open the files again.');
      }
      await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
    }
  }

  private async openSftp(controlPath: string): Promise<SFTPWrapper> {
    await this.waitForLogin(controlPath);
    if (this.finished) throw new Error('The terminal session has ended.');
    const child = this.spawnJob(sftpSshArgs(this.profile, controlPath));
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr = `${stderr}${data.toString('utf8')}`.slice(-2048);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        sftpOverStdio(child.stdin, child.stdout),
        new Promise<never>((_resolve, reject) => {
          child.once('error', reject);
          timer = setTimeout(
            () => reject(new Error('The SFTP session did not start in time.')),
            SFTP_START_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      child.kill();
      throw new Error(stderr.trim() || (err instanceof Error ? err.message : String(err)));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The live sessions by the connId their tabs were given. */
export class SystemOpenSshSessions {
  private readonly sessions = new Map<string, SystemOpenSshSession>();

  constructor(private readonly tools: SessionTools = {}) {}

  start(
    profile: SshProfile,
    cols: number,
    rows: number,
    sftpEnabled: boolean,
  ): SystemOpenSshSession {
    // `ssh` cannot pin a host key for one connection, and failing beats
    // quietly skipping the check the link asked for.
    if (profile.hostKeyFingerprint) {
      throw new Error('This link pins a host key, which system OpenSSH sessions cannot verify.');
    }
    // A hop to a saved host only means something inside Muxus.
    if (profile.proxyJump?.some((hop) => savedHostHopId(hop) !== undefined)) {
      throw new Error(
        'This host jumps through a host saved in Muxus, which the ssh program cannot reach. Use a jump host from your SSH config, or turn system OpenSSH off.',
      );
    }
    // A container's tab has no use for the host's login being shared.
    const sharing = sftpEnabled && !profile.environment;
    const session = new SystemOpenSshSession(profile, cols, rows, sharing, this.tools, (done) =>
      this.sessions.delete(done.id),
    );
    this.sessions.set(session.id, session);
    return session;
  }

  acquire(connId: string): SystemOpenSshLease | undefined {
    return this.sessions.get(connId)?.acquire();
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.destroy();
  }
}
