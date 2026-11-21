import type { FastifyInstance } from 'fastify';
import type { HostStatsResponse } from '@muxus/shared';
import type { AppContext } from '../app.js';
import type { HostStatsOutcome } from '../stats/host-stats-reader.js';
import { sendError } from '../util/errors.js';

/**
 * Status bar readings: the computer local terminals run on, or the far end of
 * a live SSH connection. Several windows polling the same connection share
 * one exec channel instead of opening one each, and share it with the host
 * monitor. A connection whose server never ran a command (a router CLI, a
 * console server) is not asked at all: some of them drop the whole connection
 * when another channel asks to exec.
 */
export function registerHostStatsRoutes(app: FastifyInstance, ctx: Pick<AppContext, 'hostStats'>): void {
  const respond = (outcome: HostStatsOutcome): HostStatsResponse =>
    outcome.status === 'ok'
      ? { status: 'ok', sampledAt: Date.now(), sample: outcome.sample }
      : { status: 'unsupported', message: 'The host does not run the statistics command.' };

  app.get('/api/host-stats/local', async (_req, reply) => {
    try {
      return respond(await ctx.hostStats.local());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/host-stats/ssh/:connId', async (req, reply) => {
    try {
      const { connId } = req.params as { connId: string };
      return respond(await ctx.hostStats.ssh(connId));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
