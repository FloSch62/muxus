import type { FastifyInstance } from 'fastify';
import type { WslDistributionsResponse } from '@muxus/shared';
import { listWslDistributions } from '../local/wsl.js';

/** Local shells the server can offer beyond the configured ones. */
export function registerLocalShellRoutes(app: FastifyInstance): void {
  // Read on every request, so a distribution installed or removed while Muxus
  // runs shows up the next time the list is asked for.
  app.get('/api/local-shells/wsl', async (): Promise<WslDistributionsResponse> => ({
    distributions: await listWslDistributions(),
  }));
}
