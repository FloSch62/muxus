import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino from 'pino';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { TERMINAL_WS_PROTOCOL } from '@muxus/shared/ws-protocol';
import type { ServerConfig } from './config.js';
import { SshConnectionManager } from './ssh/connection-manager.js';
import {
  folderAuthResolver,
  savedProfileFolderAuthResolver,
} from './ssh/folder-auth.js';
import { ForwardManager } from './forwards/forward-manager.js';
import { registerAppRoutes } from './routes/app.js';
import { registerSshRoutes } from './routes/ssh.js';
import { registerSftpRoutes } from './routes/sftp.js';
import { registerForwardRoutes } from './routes/forwards.js';
import { registerTunnelRoutes } from './routes/tunnels.js';
import { registerTerminalSocket } from './ws/terminal-socket.js';
import { registerSftpLeaseSocket } from './ws/sftp-lease-socket.js';
import { websocketHeaderHasToken } from './auth.js';
import { MuxusDatabase } from './persistence/database.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerTerminalSnapshotRoutes } from './routes/terminal-snapshots.js';
import { registerSerialRoutes } from './routes/serial.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerHostOrderRoutes } from './routes/host-order.js';
import { registerSessionHistoryRoutes } from './routes/session-history.js';
import { registerPasswordVaultRoutes } from './routes/password-vault.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerLocalFileRoutes } from './routes/local-files.js';
import { appLogPinoSink } from './logging/log-buffer.js';
import {
  defaultHistoryRoot,
  SessionHistoryStore,
} from './session-logging/history-store.js';
import { PasswordVault } from './security/password-vault.js';

export interface AppContext {
  config: ServerConfig;
  connections: SshConnectionManager;
  forwards: ForwardManager;
  database: MuxusDatabase;
  history: SessionHistoryStore;
  vault: PasswordVault;
}

// Not named __dirname: the Electron esbuild bundle defines that identifier
// in its banner for CJS interop, and banner names can't be renamed around.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The level the server returns to when debug logging is switched off. */
export function baseLogLevel(): string {
  return process.env.LOG_LEVEL ?? 'info';
}

/**
 * All records go both to the console and to the in-memory buffer behind
 * /api/logs; the logger's own level is the only gate. Debug mode (settings)
 * raises that level at runtime.
 */
function buildLogger(config: ServerConfig): FastifyBaseLogger {
  const console = config.prettyLogs
    ? pino.transport({ target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }) as pino.DestinationStream
    : process.stdout;
  return pino(
    { level: baseLogLevel() },
    pino.multistream([
      { level: 'trace', stream: console },
      { level: 'trace', stream: appLogPinoSink() },
    ]),
  ) as FastifyBaseLogger;
}

export async function buildApp(config: ServerConfig): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ loggerInstance: buildLogger(config) });

  const database = new MuxusDatabase(config.databasePath);
  const vault = new PasswordVault(database);
  await vault.initialize();
  const connections = new SshConnectionManager(app.log, {
    vault,
    savedSshProfile: (id) => {
      const profile = database.savedHostProfile(id)?.profile;
      return profile?.kind === 'ssh' ? profile : undefined;
    },
    folderAuth: folderAuthResolver(database),
    profileFolderAuth: savedProfileFolderAuthResolver(database),
    disableSftpForHost: (alias) => database.sftpDisabledForAlias(alias),
    consoleCompatibilityForHost: (alias) => database.consoleCompatibilityForAlias(alias),
    disableSftpForProfile: (id) => database.sftpDisabledForSavedHost(id),
    consoleCompatibilityForProfile: (id) =>
      database.consoleCompatibilityForSavedHost(id),
  });
  const forwards = new ForwardManager(connections, app.log);
  const historySettings = database.sessionHistorySettings();
  const configuredHistoryRoot =
    config.historyPath ??
    historySettings.storageLocation ??
    defaultHistoryRoot(config.databasePath);
  const hadLegacyHistory = database.hasLegacySessionHistory();
  const history = await SessionHistoryStore.open({
    root: configuredHistoryRoot
      ? path.resolve(configuredHistoryRoot)
      : undefined,
    settings: historySettings,
    legacyDatabasePath: hadLegacyHistory ? config.databasePath : undefined,
  });
  database.finalizeSessionHistorySeparation(hadLegacyHistory);
  const ctx: AppContext = {
    config,
    connections,
    forwards,
    database,
    history,
    vault,
  };
  database.pruneTerminalSnapshots();

  // SFTP uploads stream through as-is — no buffering, no size limit.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 16 * 1024 * 1024,
      handleProtocols: (protocols: Set<string>) => (protocols.has(TERMINAL_WS_PROTOCOL) ? TERMINAL_WS_PROTOCOL : false),
      verifyClient: (info: { origin?: string; req: { url?: string; headers: Record<string, unknown> } }) => {
        // Origin check: only same-host browser pages (or non-browser clients
        // without an Origin header) may open sockets — DNS-rebinding defense.
        const origin = info.origin;
        if (origin) {
          try {
            const u = new URL(origin);
            if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
          } catch {
            return false;
          }
        }
        return websocketHeaderHasToken(info.req.headers['sec-websocket-protocol'], config.token);
      },
    },
  });

  app.addHook('onSend', async (_req, reply) => {
    void reply
      .header('content-security-policy', CONTENT_SECURITY_POLICY)
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header(
        'permissions-policy',
        'camera=(), geolocation=(), microphone=(), clipboard-read=(self), clipboard-write=(self)',
      );
  });

  // Bearer-token auth for all /api routes.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Native HTML file drags cannot attach an Authorization header. This
    // one endpoint uses a short-lived, path-bound ticket issued only in an
    // authenticated SFTP listing response.
    if (req.method === 'GET' && /^\/api\/sftp\/[^/]+\/drag-download(?:\?|$)/.test(req.url)) return;
    const header = req.headers.authorization;
    const ok = header === `Bearer ${config.token}`;
    if (!ok) {
      await reply.code(401).send({ message: 'unauthorized' });
    }
  });

  registerAppRoutes(app, ctx);
  registerSshRoutes(app, ctx);
  registerSftpRoutes(app, ctx);
  registerForwardRoutes(app, ctx);
  registerTunnelRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerTerminalSnapshotRoutes(app, ctx);
  registerSerialRoutes(app);
  registerProfileRoutes(app, ctx);
  registerHostOrderRoutes(app, ctx);
  registerSessionHistoryRoutes(app, ctx);
  registerPasswordVaultRoutes(app, ctx);
  registerFolderRoutes(app, ctx);
  registerLogRoutes(app);
  registerLocalFileRoutes(app);
  registerTerminalSocket(app, ctx);
  registerSftpLeaseSocket(app, ctx);

  // Serve the built client in production (same-origin, no CORS needed).
  const clientDist = config.staticRoot ?? path.resolve(moduleDir, '../../client/dist');
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
        void reply.code(404).send({ message: 'not found' });
      } else {
        void reply.sendFile('index.html');
      }
    });
  }

  app.addHook('onClose', async () => {
    forwards.stopAll();
    connections.closeAll();
    vault.dispose();
    await history.close();
    database.close();
  });

  return { app, ctx };
}
