import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { resolveConfig, type ServerConfig } from './config.js';
import { buildApp } from './app.js';

export interface RunningServer {
  app: FastifyInstance;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

/** Start the server programmatically (used by the CLI entry and the Electron shell). */
export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const config = resolveConfig(overrides);
  const { app } = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  // config.port may be 0 (pick any free port); read the real one back.
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    port,
    token: config.token,
    url: `http://${config.host}:${port}/?token=${config.token}`,
    close: () => app.close(),
  };
}
