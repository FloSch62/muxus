import type { WslDistribution } from '@muxus/shared';
import type { LocalShellProfileConfig } from './state/prefs.js';

const MAX_LOCAL_SHELL_ARGUMENTS = 64;

export function newLocalShellProfileId(count: number): string {
  return `local-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${count}`}`;
}
const MAX_LOCAL_SHELL_ARGUMENT_LENGTH = 4096;

/** Preserve blank rows while the controlled arguments field is being edited. */
export function parseLocalShellArgumentText(value: string): string[] {
  return value
    .split(/\r?\n/, MAX_LOCAL_SHELL_ARGUMENTS)
    .map((argument) => argument.slice(0, MAX_LOCAL_SHELL_ARGUMENT_LENGTH));
}

/** Empty editor rows describe layout, not arguments passed to the executable. */
export function localShellLaunchArguments(
  arguments_: readonly string[],
): string[] | undefined {
  const compact = arguments_.filter((argument) => argument.length > 0);
  return compact.length ? compact : undefined;
}

/** Launch settings for an installed WSL distribution. `--cd ~` starts in the
 * Linux home directory, as Windows Terminal does, rather than the Windows one. */
export function wslShellProfile(
  distribution: WslDistribution,
): LocalShellProfileConfig {
  return {
    id: `wsl:${distribution.name}`,
    name: distribution.name,
    shell: 'wsl.exe',
    args: ['-d', distribution.name, '--cd', '~'],
    cwd: '',
    startupCommand: '',
  };
}

/** Whether a shell launch — a saved profile or an open tab's — starts the
 * named distribution. */
export function opensWslDistribution(
  launch: { shell?: string; args?: readonly string[] },
  name: string,
): boolean {
  const executable = launch.shell?.trim().split(/[\\/]/).at(-1)?.toLowerCase();
  if (executable !== 'wsl' && executable !== 'wsl.exe') return false;
  const args = launch.args ?? [];
  const wanted = name.toLowerCase();
  return args.some(
    (argument, index) =>
      (argument === '-d' || argument === '--distribution') &&
      args[index + 1]?.toLowerCase() === wanted,
  );
}

/** Installed distributions no saved profile covers yet, ready to launch. */
export function wslShellProfiles(
  distributions: readonly WslDistribution[],
  saved: readonly LocalShellProfileConfig[],
): LocalShellProfileConfig[] {
  return distributions
    .filter(({ name }) => !saved.some((profile) => opensWslDistribution(profile, name)))
    .map(wslShellProfile);
}
