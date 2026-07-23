import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  /** Bearer token required on every request; generated fresh per run. */
  token: string;
  /** Disable token auth (dev mode behind the Vite proxy uses a fixed token instead). */
  devToken?: string;
  openBrowser: boolean;
  /** Directory to serve the built client from; defaults to the repo's client/dist. */
  staticRoot?: string;
  /** Local metadata/workspace database. OpenSSH config remains an external source. */
  databasePath: string;
  /** Use the pino-pretty worker transport (unusable inside a bundled main process). */
  prettyLogs: boolean;
}

export function defaultDatabasePath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Muxus', 'muxus.sqlite3');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Muxus', 'muxus.sqlite3');
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'muxus', 'muxus.sqlite3');
}

export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3002,
    token: overrides.devToken ?? randomBytes(24).toString('base64url'),
    openBrowser: true,
    databasePath: defaultDatabasePath(),
    prettyLogs: process.env.NODE_ENV !== 'production',
    ...overrides,
  };
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.set(a.slice(2), next);
        i++;
      } else {
        out.set(a.slice(2), 'true');
      }
    }
  }
  return out;
}

function parsePort(raw: string | number): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port "${raw}" — expected an integer between 1 and 65535`);
  }
  return port;
}

export function loadConfig(): ServerConfig {
  const args = parseArgs(process.argv.slice(2));
  const dev = process.env.NODE_ENV !== 'production' && process.env.MUXUS_DEV === '1';
  // In dev the Vite client can't learn a random token at startup, so use a
  // well-known one; the server still only listens on 127.0.0.1.
  const devToken = dev ? 'dev' : undefined;
  return resolveConfig({
    port: parsePort(args.get('port') ?? process.env.PORT ?? 3002),
    devToken,
    openBrowser: !dev && args.get('no-open') !== 'true' && process.env.MUXUS_NO_OPEN !== '1',
  });
}
