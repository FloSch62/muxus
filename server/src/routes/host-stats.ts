import type { FastifyInstance } from 'fastify';
import type { HostStatsResponse } from '@muxus/shared';
import type { AppContext } from '../app.js';
import {
  readLocalHostStats,
  readRemoteHostStats,
  type HostStatsReading,
} from '../stats/host-stats.js';
import { HttpProblem, sendError } from '../util/errors.js';

/**
 * Status bar readings: the computer local terminals run on, or the far end of
 * a live SSH connection. Several windows polling the same connection share
 * one exec channel instead of opening one each.
 */
export function registerHostStatsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const inFlight = new Map<string, Promise<HostStatsReading>>();

  const shared = (key: string, read: () => Promise<HostStatsReading>) => {
    let reading = inFlight.get(key);
    if (!reading) {
      reading = read().finally(() => inFlight.delete(key));
      inFlight.set(key, reading);
    }
    return reading;
  };

  const respond = (reading: HostStatsReading): HostStatsResponse =>
    reading.supported
      ? { status: 'ok', sampledAt: Date.now(), sample: reading.sample }
      : { status: 'unsupported', message: 'The host did not run the statistics command.' };

  app.get('/api/host-stats/local', async (_req, reply) => {
    try {
      return respond(
        await shared('local', async () => ({ supported: true, sample: await readLocalHostStats() })),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/host-stats/ssh/:connId', async (req, reply) => {
    try {
      const { connId } = req.params as { connId: string };
      const reading = await shared(`ssh:${connId}`, async () => {
        const lease = ctx.connections.acquire(connId, 'stats');
        if (!lease) throw new HttpProblem(404, 'connection not found');
        try {
          return await readRemoteHostStats(lease.connection.client);
        } finally {
          lease.release();
        }
      });
      return respond(reading);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
