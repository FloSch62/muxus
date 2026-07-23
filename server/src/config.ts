import { randomBytes } from 'node:crypto';

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
  /** Use the pino-pretty worker transport (unusable inside a bundled main process). */
  prettyLogs: boolean;
}

export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3002,
    token: overrides.devToken ?? randomBytes(24).toString('base64url'),
    openBrowser: true,
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
