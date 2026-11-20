import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { PasswordManagerError } from './provider.js';

/** Long enough for a listing of a large vault on a slow machine. */
export const LIST_TIMEOUT_MS = 60_000;
/** A read can sit behind a fingerprint or pinentry prompt the person has to answer. */
export const APPROVAL_TIMEOUT_MS = 120_000;
export const STATUS_TIMEOUT_MS = 15_000;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  /** Added to the environment for this run; undefined removes a variable. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Written to stdin, which is then closed. Stdin is closed at once without it. */
  input?: string;
}

/**
 * Run a password manager's command-line program and collect what it prints.
 * Nothing goes through a shell, stdin is never a terminal, and a run that
 * outlives its timeout is killed, so a program waiting for input cannot hang
 * a connection attempt for good.
 */
export async function runCli(
  program: string,
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const resolved = await resolveProgram(program);
  if (!resolved) {
    throw new PasswordManagerError('unavailable', `${program} was not found on this computer.`);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name];
  }
  // Batch files only run through cmd.exe, whose quoting cannot carry every
  // argument safely; refuse the ones it would reinterpret.
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  if (batch && args.some((arg) => /["%!^&|<>\r\n]/.test(arg))) {
    throw new PasswordManagerError('failed', `${program} cannot be given this value on Windows.`);
  }

  return new Promise<CliResult>((resolve, reject) => {
    const child = batch
      ? spawn(`"${resolved}" ${args.map((arg) => `"${arg}"`).join(' ')}`, {
          env,
          shell: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn(resolved, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new PasswordManagerError(
            'timeout',
            `${path.basename(program)} did not answer in time. If it is waiting for you to approve or unlock, do that and try again.`,
          ),
        ),
      );
    }, options.timeoutMs ?? LIST_TIMEOUT_MS);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new PasswordManagerError('failed', `${program} printed too much output.`)));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (err) =>
      finish(() => reject(new PasswordManagerError('unavailable', `${program} could not be started: ${err.message}`))),
    );
    child.on('close', (code) =>
      finish(() =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      ),
    );
    // A program that exits before reading its input closes the pipe first.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

/** Whether a program can be found, for the "installed" hint in the settings. */
export async function programInstalled(program: string): Promise<boolean> {
  return (await resolveProgram(program)) !== undefined;
}

/**
 * The file a program name stands for: a path as given, otherwise the first
 * match on PATH, trying the Windows executable extensions there.
 */
export async function resolveProgram(program: string): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  const directories =
    program.includes('/') || program.includes(path.sep)
      ? ['']
      : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? path.join(directory, program + extension) : program + extension;
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Try the next place.
      }
    }
  }
  return undefined;
}

/** Color codes, which lpass and op print even to a pipe. */
// oxlint-disable-next-line no-control-regex
const ANSI_COLORS = /\u001b\[[0-9;]*m/g;

/** The last thing a program said on stderr, without log prefixes or colors. */
export function cliMessage(result: CliResult, fallback: string): string {
  const text = (result.stderr.trim() || result.stdout.trim())
    .replace(ANSI_COLORS, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!text) return fallback;
  // "[ERROR] 2024/01/01 12:00:00 message", as op prints it.
  return text.replace(/^\[ERROR\]\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/, '').slice(0, 400);
}

/** Parse a program's JSON output, or say that it printed something else. */
export function parseJson<T>(program: string, output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new PasswordManagerError('failed', `${program} printed something Muxus could not read.`);
  }
}
