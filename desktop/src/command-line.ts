import type { AppWindowLaunch, CommandLineLaunch } from '@muxus/shared';

const TARGET_FLAGS = {
  '--host': 'host',
  '--folder': 'folder',
  '--workspace': 'workspace',
} as const satisfies Record<string, CommandLineLaunch['kind']>;

const MAX_TARGET_LENGTH = 500;

/** Parse exactly one desktop launch target from the full argv array. */
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

/** Validate the structured payload forwarded through the single-instance socket. */
export function parseCommandLineLaunchData(
  value: unknown,
): CommandLineLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'host' &&
    candidate.kind !== 'folder' &&
    candidate.kind !== 'workspace'
  ) {
    return undefined;
  }
  if (typeof candidate.name !== 'string') return undefined;
  const name = candidate.name.trim();
  return name && name.length <= MAX_TARGET_LENGTH
    ? { kind: candidate.kind, name }
    : undefined;
}

/** SFTP-only windows do not mount the client-side command request handler. */
export function canHandleCommandLineLaunch(
  windowLaunch: AppWindowLaunch | undefined,
): boolean {
  return windowLaunch?.kind !== 'sftp';
}

/** The native launcher relays argv through the environment to Bun. */
export function initialCommandLineLaunch(): CommandLineLaunch | undefined {
  try {
    const argv: unknown = JSON.parse(process.env.MUXUS_LAUNCH_ARGS ?? '[]');
    return Array.isArray(argv) && argv.every((arg) => typeof arg === 'string')
      ? parseCommandLineLaunch(argv) : undefined;
  } catch { return undefined; }
}
