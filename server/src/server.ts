import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { resolveConfig, type ServerConfig } from './config.js';
import { buildApp } from './app.js';
import { serverUrls } from './auth.js';

// The Electron shell logs its own milestones (boot, crashes) into the same
// in-process buffer the /api/logs viewer reads.
export { appendAppLog } from './logging/log-buffer.js';

export interface RunningServer {
  app: FastifyInstance;
  port: number;
  token: string;
  /** Public URL safe to show in logs. It never contains the bearer token. */
  url: string;
  /** Standalone-browser bootstrap URL. The fragment is never sent in an HTTP request. */
  browserUrl: string;
  close(): Promise<void>;
}

/** Start the server programmatically (used by the CLI entry and the Electron shell). */
export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const config = resolveConfig(overrides);
  const { app } = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  // config.port may be 0 (pick any free port); read the real one back.
  const port = (app.server.address() as AddressInfo).port;
  const urls = serverUrls(config.host, port, config.token);
  return {
    app,
    port,
    token: config.token,
    url: urls.publicUrl,
    browserUrl: urls.browserUrl,
    close: () => app.close(),
  };
}
