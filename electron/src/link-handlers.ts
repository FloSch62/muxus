import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CONNECTION_LINK_SCHEMES,
  type ConnectionLinkScheme,
  type LinkHandlerRegistration,
  type LinkHandlerState,
  type LinkHandlerStatus,
} from '@muxus/shared';
import {
  dataDirectories,
  parseKeyFileGroup,
  splitExec,
  unescapeDesktopString,
} from './linux-applications.js';

// Registering is always the user's choice: nothing here runs until Settings
// asks, because it changes which program the whole system uses for a scheme.

type Environment = Record<string, string | undefined>;

/** Runs a program without a shell and resolves to its standard output. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  env: Environment,
) => Promise<string>;

export const runCommand: CommandRunner = (command, args, env) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: 10_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** The desktop file the Linux packages install (`desktopName`). */
export const INSTALLED_DESKTOP_ID = 'muxus.desktop';
/** Written for an AppImage or a source checkout, which install no desktop file. */
export const GENERATED_DESKTOP_ID = 'muxus-url-handler.desktop';

const NOT_DEFAULT: LinkHandlerStatus = { isDefault: false };

/** An Exec argument that needs no quoting. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_/.,:=@+-]+$/;

function mimeType(scheme: ConnectionLinkScheme): string {
  return `x-scheme-handler/${scheme}`;
}

/**
 * One Exec argument, quoted per the Desktop Entry spec: inside quotes `"`,
 * `` ` ``, `$` and `\` take a backslash, the string escape doubles every
 * backslash again, and `%` is written `%%` so it is not a field code.
 */
export function desktopExecArgument(argument: string): string {
  if (/[\n\r\t]/.test(argument)) throw new Error('A launch path cannot contain line breaks.');
  const quoted = PLAIN_ARGUMENT.test(argument)
    ? argument
    : `"${argument.replace(/["`$\\]/g, '\\$&')}"`;
  return quoted.replaceAll('\\', '\\\\').replaceAll('%', '%%');
}

/** A hidden launcher that hands links to this Muxus, for the schemes it should claim. */
export function generatedDesktopEntry(
  command: readonly string[],
  schemes: readonly ConnectionLinkScheme[],
): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Muxus',
    'Comment=Opens ssh:// and telnet:// links in Muxus',
    `Exec=${[...command.map(desktopExecArgument), '%u'].join(' ')}`,
    'Icon=muxus',
    'Terminal=false',
    'NoDisplay=true',
    `MimeType=${schemes.map((scheme) => `${mimeType(scheme)};`).join('')}`,
    'StartupWMClass=muxus',
    '',
  ].join('\n');
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * An AppImage puts its own mount first in PATH, XDG_DATA_DIRS and
 * LD_LIBRARY_PATH. Those entries must not reach xdg-mime: the mount has
 * nothing to say about desktop defaults, and a space in its name breaks the
 * script's directory loops.
 */
export function withoutAppImagePaths(env: Environment): Environment {
  const mount = env.APPDIR;
  if (!env.APPIMAGE || !mount) return env;
  const cleaned = { ...env };
  for (const name of ['PATH', 'XDG_DATA_DIRS', 'LD_LIBRARY_PATH']) {
    const value = cleaned[name];
    if (value === undefined) continue;
    const kept = value.split(':').filter((entry) => entry && entry !== mount && !entry.startsWith(`${mount}/`));
    if (kept.length > 0) cleaned[name] = kept.join(':');
    else delete cleaned[name];
  }
  return cleaned;
}

function missingProgram(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export interface LinuxLinkHandlerOptions {
  /** Environment for xdg-mime, with Electron's own desktop overrides undone. */
  env: Environment;
  home: string;
  /**
   * The arguments that start this Muxus, ahead of the link: the AppImage
   * file, the executable, or Electron plus the app directory.
   */
  command: readonly string[];
  /** A packaged installation may use the desktop file its package installed. */
  installed: boolean;
  /**
   * Where a link to a launch path that needs quoting is kept. xdg-utils takes
   * the first space-separated word of Exec and ignores quotes, so an AppImage
   * named "Muxus 0.10.0.AppImage" is registered through this link instead.
   */
  aliasDirectory?: string;
  run?: CommandRunner;
}

/**
 * Linux registration through xdg-mime and mimeapps.list. An installed package
 * uses its own desktop file; an AppImage or a source checkout gets a hidden
 * one that points at itself, since nothing else knows where it lives.
 */
export class LinuxLinkHandlers {
  private readonly run: CommandRunner;

  constructor(private readonly options: LinuxLinkHandlerOptions) {
    this.run = options.run ?? runCommand;
  }

  private applicationDirectories(): string[] {
    return dataDirectories(this.options.env, this.options.home).map((directory) =>
      path.join(directory, 'applications'),
    );
  }

  private generatedPath(): string {
    return path.join(this.applicationDirectories()[0]!, GENERATED_DESKTOP_ID);
  }

  private async findDesktopFile(id: string): Promise<string | undefined> {
    for (const directory of this.applicationDirectories()) {
      const text = await readText(path.join(directory, id));
      if (text !== undefined) return text;
    }
    return undefined;
  }

  private async desktopId(): Promise<string> {
    return this.options.installed && (await this.findDesktopFile(INSTALLED_DESKTOP_ID)) !== undefined
      ? INSTALLED_DESKTOP_ID
      : GENERATED_DESKTOP_ID;
  }

  private aliasPath(): string | undefined {
    const { command, aliasDirectory } = this.options;
    if (command.length !== 1 || PLAIN_ARGUMENT.test(command[0]!)) return undefined;
    return aliasDirectory && PLAIN_ARGUMENT.test(aliasDirectory)
      ? path.join(aliasDirectory, 'muxus-link-handler')
      : undefined;
  }

  /** Whether the generated entry still starts this copy (an AppImage may have moved). */
  private async generatedEntryIsCurrent(): Promise<boolean> {
    const text = await readText(this.generatedPath());
    if (text === undefined) return false;
    const exec = splitExec(unescapeDesktopString(parseKeyFileGroup(text, 'Desktop Entry').get('Exec') ?? ''));
    const alias = this.aliasPath();
    const command = alias ? [alias] : this.options.command;
    const expected = [...command.map((argument) => argument.replaceAll('%', '%%')), '%u'];
    if (JSON.stringify(exec) !== JSON.stringify(expected)) return false;
    if (!alias) return true;
    const [linked, target] = await Promise.all([
      realpath(alias).catch(() => undefined),
      realpath(this.options.command[0]!).catch(() => undefined),
    ]);
    return !!linked && linked === target;
  }

  /** The launch command to write into the entry, pointing the alias at this copy first. */
  private async launchCommand(): Promise<readonly string[]> {
    const alias = this.aliasPath();
    if (!alias) return this.options.command;
    await mkdir(path.dirname(alias), { recursive: true });
    const temporary = `${alias}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    await symlink(this.options.command[0]!, temporary);
    await rename(temporary, alias);
    return [alias];
  }

  private async handlerName(id: string): Promise<string> {
    const text = await this.findDesktopFile(id);
    const name = text ? parseKeyFileGroup(text, 'Desktop Entry').get('Name') : undefined;
    return name ? unescapeDesktopString(name) : id.replace(/\.desktop$/, '');
  }

  async state(): Promise<LinkHandlerState> {
    try {
      const id = await this.desktopId();
      const current = id === INSTALLED_DESKTOP_ID || (await this.generatedEntryIsCurrent());
      const statuses = await Promise.all(
        CONNECTION_LINK_SCHEMES.map(async (scheme): Promise<LinkHandlerStatus> => {
          const handler = (
            await this.run('xdg-mime', ['query', 'default', mimeType(scheme)], this.options.env)
          ).trim();
          if (!handler) return NOT_DEFAULT;
          const isDefault = current && handler === id;
          return {
            isDefault,
            // An entry from an AppImage that has since moved, or from another build.
            currentHandler:
              handler === GENERATED_DESKTOP_ID && !isDefault
                ? 'Another copy of Muxus'
                : await this.handlerName(handler),
          };
        }),
      );
      return { ssh: statuses[0]!, telnet: statuses[1]! };
    } catch (error) {
      return {
        unavailable: missingProgram(error)
          ? 'xdg-mime was not found. Install xdg-utils so Muxus can be chosen for links.'
          : 'The desktop’s default applications could not be read.',
        ssh: NOT_DEFAULT,
        telnet: NOT_DEFAULT,
      };
    }
  }

  async register(scheme: ConnectionLinkScheme): Promise<LinkHandlerRegistration> {
    try {
      const id = await this.desktopId();
      if (id === GENERATED_DESKTOP_ID) {
        // Claim only the schemes the user chose, so the entry never becomes
        // a fallback handler for the other one.
        const before = await this.state();
        const schemes = CONNECTION_LINK_SCHEMES.filter(
          (candidate) => candidate === scheme || before[candidate].isDefault,
        );
        const file = this.generatedPath();
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, generatedDesktopEntry(await this.launchCommand(), schemes), {
          mode: 0o644,
        });
        await rename(temporary, file);
      }
      await this.run('xdg-mime', ['default', id, mimeType(scheme)], this.options.env);
    } catch (error) {
      return {
        state: await this.state(),
        error: missingProgram(error)
          ? 'xdg-mime was not found. Install xdg-utils so Muxus can be chosen for links.'
          : `Could not make Muxus the handler for ${scheme}:// links: ${(error as Error).message}`,
      };
    }
    const state = await this.state();
    return state[scheme].isDefault
      ? { state }
      : { state, error: `The desktop did not accept Muxus as the handler for ${scheme}:// links.` };
  }
}

/** The Electron calls the macOS and Windows registration needs. */
export interface ProtocolClientApi {
  isDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
  getApplicationNameForProtocol(url: string): string;
  getApplicationInfoForProtocol(url: string): Promise<{ path: string; name: string }>;
}

export interface SystemLinkHandlerOptions {
  platform: 'darwin' | 'win32';
  api: ProtocolClientApi;
  /** Microsoft Store packages declare their schemes in the manifest instead. */
  windowsStore: boolean;
  /** Running from a source checkout: Electron plus the app directory. */
  development?: { executable: string; appPath: string };
  executable: string;
  openDefaultAppsSettings(): Promise<void>;
}

function samePath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

/**
 * macOS (Launch Services) and Windows registration through Electron. Windows
 * keeps a user's explicit choice of default app out of reach of programs, so
 * when that choice wins, or for a Store package, its settings page is opened.
 */
export class SystemLinkHandlers {
  constructor(private readonly options: SystemLinkHandlerOptions) {}

  private registrationArgs(): [string?, string[]?] {
    const development = this.options.development;
    return development ? [development.executable, [development.appPath]] : [];
  }

  private async status(scheme: ConnectionLinkScheme): Promise<LinkHandlerStatus> {
    const { api, platform, executable } = this.options;
    const currentHandler = api.getApplicationNameForProtocol(`${scheme}://`) || undefined;
    if (platform === 'darwin') {
      return { isDefault: api.isDefaultProtocolClient(scheme, ...this.registrationArgs()), currentHandler };
    }
    // The handler Windows resolves, which honours the user's choice in Settings.
    const handler = await api.getApplicationInfoForProtocol(`${scheme}://`).catch(() => undefined);
    return { isDefault: !!handler?.path && samePath(handler.path, executable), currentHandler };
  }

  async state(): Promise<LinkHandlerState> {
    const [ssh, telnet] = await Promise.all(CONNECTION_LINK_SCHEMES.map((scheme) => this.status(scheme)));
    return { ssh: ssh!, telnet: telnet! };
  }

  async register(scheme: ConnectionLinkScheme): Promise<LinkHandlerRegistration> {
    const { api, platform, windowsStore } = this.options;
    if (platform === 'win32' && windowsStore) {
      await this.options.openDefaultAppsSettings();
      return { state: await this.state(), openedSystemSettings: true };
    }
    if (!api.setAsDefaultProtocolClient(scheme, ...this.registrationArgs())) {
      return {
        state: await this.state(),
        error: `The system did not accept Muxus as the handler for ${scheme}:// links.`,
      };
    }
    const state = await this.state();
    if (state[scheme].isDefault) return { state };
    if (platform === 'win32') {
      await this.options.openDefaultAppsSettings();
      return { state, openedSystemSettings: true };
    }
    return { state, error: `The system did not accept Muxus as the handler for ${scheme}:// links.` };
  }
}
