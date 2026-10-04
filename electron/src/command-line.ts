import type { AppWindowLaunch, CommandLineLaunch } from '@muxus/shared';

const TARGET_FLAGS = {
  '--host': 'host',
  '--folder': 'folder',
  '--workspace': 'workspace',
  '--connect': 'connect',
} as const satisfies Record<string, CommandLineLaunch['kind']>;

/** Parts of a `--connect` target that may also be given as separate flags. */
interface ConnectOptions {
  user?: string;
  port?: string;
}

const CONNECT_FLAGS = {
  '--user': 'user',
  '--port': 'port',
} as const satisfies Record<string, keyof ConnectOptions>;

const MAX_TARGET_LENGTH = 500;

// The host reaches a configured ProxyCommand through %h and runs in a shell,
// so like OpenSSH only plain user and host names are accepted from outside.
const USER_PATTERN = /^(?!-)[\w.@+-]+$/;
const HOSTNAME_PATTERN = /^(?![-.])[A-Za-z0-9._-]+$/;
const IPV6_PATTERN = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?$/;

function validPort(value: string): string | undefined {
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? String(port) : undefined;
}

/**
 * Validate an ad-hoc `[user@]host[:port]` SSH target and fold in a separately
 * supplied user or port. A part given both ways is rejected rather than
 * guessed. IPv6 hosts may be bracketed and are bracketed again when a port
 * follows them.
 */
export function parseConnectTarget(
  target: string,
  options: ConnectOptions = {},
): string | undefined {
  const at = target.lastIndexOf('@');
  if (at === 0) return undefined;
  const targetUser = at > 0 ? target.slice(0, at) : undefined;
  const address = at > 0 ? target.slice(at + 1) : target;

  let host: string;
  let targetPort: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::([^:]*))?$/.exec(address);
  if (bracketed) {
    host = bracketed[1]!;
    if (!IPV6_PATTERN.test(host) && !HOSTNAME_PATTERN.test(host)) return undefined;
    targetPort = bracketed[2];
  } else if (address.indexOf(':') !== address.lastIndexOf(':')) {
    // Unbracketed IPv6 cannot carry a port, matching how the server reads it.
    host = address;
    if (!IPV6_PATTERN.test(host)) return undefined;
  } else {
    const colon = address.indexOf(':');
    host = colon < 0 ? address : address.slice(0, colon);
    targetPort = colon < 0 ? undefined : address.slice(colon + 1);
    if (!HOSTNAME_PATTERN.test(host)) return undefined;
  }

  if (targetUser !== undefined && options.user !== undefined) return undefined;
  if (targetPort !== undefined && options.port !== undefined) return undefined;
  const user = targetUser ?? options.user;
  const rawPort = targetPort ?? options.port;
  if (user !== undefined && !USER_PATTERN.test(user)) return undefined;
  const port = rawPort === undefined ? undefined : validPort(rawPort);
  if (rawPort !== undefined && !port) return undefined;

  const hostPart = port && host.includes(':') ? `[${host}]` : host;
  const normalized = `${user ? `${user}@` : ''}${hostPart}${port ? `:${port}` : ''}`;
  return normalized.length <= MAX_TARGET_LENGTH ? normalized : undefined;
}

/** Parse exactly one desktop launch target from Electron's full argv array. */
export function parseCommandLineLaunch(
  argv: readonly string[],
): CommandLineLaunch | undefined {
  let launch: CommandLineLaunch | undefined;
  const connectOptions: ConnectOptions = {};

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const kind = TARGET_FLAGS[flag as keyof typeof TARGET_FLAGS];
    const option = CONNECT_FLAGS[flag as keyof typeof CONNECT_FLAGS];
    if (!kind && !option) continue;

    const rawValue = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    const value = rawValue?.trim();
    if (
      !value ||
      value.startsWith('--') ||
      value.length > MAX_TARGET_LENGTH
    ) {
      return undefined;
    }
    if (option) {
      if (connectOptions[option] !== undefined) return undefined;
      connectOptions[option] = value;
      continue;
    }
    if (launch) return undefined;
    launch = { kind, name: value };
  }

  if (launch?.kind !== 'connect') {
    // --user and --port only describe a --connect target.
    return Object.keys(connectOptions).length === 0 ? launch : undefined;
  }
  const target = parseConnectTarget(launch.name, connectOptions);
  return target ? { kind: 'connect', name: target } : undefined;
}

/** Validate the structured payload forwarded through Electron's single-instance lock. */
export function parseCommandLineLaunchData(
  value: unknown,
): CommandLineLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'host' &&
    candidate.kind !== 'folder' &&
    candidate.kind !== 'workspace' &&
    candidate.kind !== 'connect'
  ) {
    return undefined;
  }
  if (typeof candidate.name !== 'string') return undefined;
  const name =
    candidate.kind === 'connect'
      ? parseConnectTarget(candidate.name.trim())
      : candidate.name.trim();
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
