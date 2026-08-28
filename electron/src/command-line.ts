import type { CommandLineLaunch } from '@muxus/shared';

const TARGET_FLAGS = {
  '--host': 'host',
  '--folder': 'folder',
  '--workspace': 'workspace',
} as const satisfies Record<string, CommandLineLaunch['kind']>;

const MAX_TARGET_LENGTH = 500;

/** Parse exactly one desktop launch target from Electron's full argv array. */
export function parseCommandLineLaunch(
  argv: readonly string[],
): CommandLineLaunch | undefined {
  let launch: CommandLineLaunch | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const kind = TARGET_FLAGS[flag as keyof typeof TARGET_FLAGS];
    if (!kind) continue;

    const rawName = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    const name = rawName?.trim();
    if (
      launch ||
      !name ||
      name.startsWith('--') ||
      name.length > MAX_TARGET_LENGTH
    ) {
      return undefined;
    }
    launch = { kind, name };
  }

  return launch;
}
