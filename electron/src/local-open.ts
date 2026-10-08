import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

// Remote files opened with a local program are written to a private folder
// first. Each copy gets a folder of its own so the program sees the remote
// file's real name, and copies nothing has touched for a day are removed.

type Environment = Record<string, string | undefined>;

export const LOCAL_COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOCAL_COPY_PREFIX = 'open-';
const MAX_FILE_NAME_LENGTH = 180;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

export interface LocalCopy {
  directory: string;
  file: string;
  handle: FileHandle;
}

/** A remote file name that is safe to create on every desktop platform. */
export function localCopyFileName(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? '';
  let safe = '';
  for (const char of base) {
    safe += char < ' ' || char === '\u007f' || '<>:"|?*'.includes(char) ? '_' : char;
  }
  // Windows drops trailing dots and spaces, which would change the name.
  safe = safe.replace(/[. ]+$/, '');
  if (!safe || safe === '.' || safe === '..') safe = 'file';
  if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`;
  if (safe.length > MAX_FILE_NAME_LENGTH) {
    const extension = path.extname(safe).slice(0, 20);
    safe = `${safe.slice(0, MAX_FILE_NAME_LENGTH - extension.length)}${extension}`;
  }
  return safe;
}

/** Create an owner-only folder under `root` and an empty file named after the remote one. */
export async function createLocalCopy(root: string, name: string): Promise<LocalCopy> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Under a shared /tmp someone else may have created the root first; their
  // folder would let them swap the copy before the program reads it.
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const info = await lstat(root);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
      throw new Error(`${root} is not a private folder of this user`);
    }
  }
  const directory = await mkdtemp(path.join(root, LOCAL_COPY_PREFIX));
  const file = path.join(directory, localCopyFileName(name));
  try {
    return { directory, file, handle: await open(file, 'wx', 0o600) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Remove copies whose folder and file have both been left alone for `maxAgeMs`. */
export async function purgeStaleLocalCopies(
  root: string,
  now = Date.now(),
  maxAgeMs = LOCAL_COPY_MAX_AGE_MS,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(LOCAL_COPY_PREFIX))
      .map(async (name) => {
        const directory = path.join(root, name);
        try {
          const info = await lstat(directory);
          if (!info.isDirectory()) return;
          let newest = info.mtimeMs;
          for (const child of await readdir(directory)) {
            newest = Math.max(newest, (await lstat(path.join(directory, child))).mtimeMs);
          }
          if (now - newest > maxAgeMs) await rm(directory, { recursive: true, force: true });
        } catch {
          // Still in use or already gone; the next purge tries again.
        }
      }),
  );
}

/**
 * Tag a Windows copy as downloaded from the internet, as a browser would, so
 * SmartScreen and Office Protected View treat it like any other download.
 */
export async function markAsDownloaded(file: string): Promise<void> {
  try {
    await writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  } catch {
    // Volumes without alternate data streams (FAT, network shares) cannot carry the mark.
  }
}

/**
 * The environment for programs Muxus starts. Electron sets these for itself;
 * inherited, they make a launched Electron app group under the Muxus icon or
 * force a GTK program onto the wrong display backend.
 */
export function launchEnvironment(environment: Environment): Environment {
  const launched = { ...environment };
  if (launched.ORIGINAL_XDG_CURRENT_DESKTOP) {
    launched.XDG_CURRENT_DESKTOP = launched.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  delete launched.ORIGINAL_XDG_CURRENT_DESKTOP;
  delete launched.CHROME_DESKTOP;
  delete launched.GDK_BACKEND;
  delete launched.NO_AT_BRIDGE;
  return launched;
}

/** Start a program that outlives Muxus; resolves once it is running. */
export function startDetached(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Environment; windowsVerbatimArguments?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Run an opener (xdg-open, open -a) that hands the file to another program
 * and exits. A non-zero exit is a failure; an opener still running after
 * `timeoutMs` is assumed to be waiting on the program it started.
 */
export function runOpener(
  command: string,
  args: readonly string[],
  options: { env?: Environment; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, options.timeoutMs ?? 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with ${code ?? signal}`));
    });
  });
}
