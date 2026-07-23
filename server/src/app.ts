import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { TERMINAL_WS_PROTOCOL } from '@muxus/shared/ws-protocol';
import type { ServerConfig } from './config.js';
import { SshConnectionManager } from './ssh/connection-manager.js';
import { ForwardManager } from './forwards/forward-manager.js';
import { registerAppRoutes } from './routes/app.js';
import { registerSshRoutes } from './routes/ssh.js';
import { registerSftpRoutes } from './routes/sftp.js';
import { registerForwardRoutes } from './routes/forwards.js';
import { registerTunnelRoutes } from './routes/tunnels.js';
import { registerTerminalSocket } from './ws/terminal-socket.js';
import { websocketHeaderHasToken } from './auth.js';
import { MuxusDatabase } from './persistence/database.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export interface AppContext {
  config: ServerConfig;
  connections: SshConnectionManager;
  forwards: ForwardManager;
  database: MuxusDatabase;
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

export async function buildApp(config: ServerConfig): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: config.prettyLogs ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } : undefined,
    },
  });

  const connections = new SshConnectionManager(app.log);
  const forwards = new ForwardManager(connections, app.log);
  const database = new MuxusDatabase(config.databasePath);
  const ctx: AppContext = { config, connections, forwards, database };

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
  registerTerminalSocket(app, ctx);

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
    database.close();
  });

  return { app, ctx };
}
