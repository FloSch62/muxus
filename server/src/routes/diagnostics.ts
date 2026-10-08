import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConnectionDiagnosticsResponse } from '@muxus/shared';
import { sshProfileSchema, telnetProfileSchema } from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { diagnoseSsh, diagnoseTelnet } from '../diagnostics/connection-diagnostics.js';
import { HttpProblem, sendError } from '../util/errors.js';

const diagnoseSchema = z.object({
  profile: z.discriminatedUnion('kind', [sshProfileSchema, telnetProfileSchema]),
});

/** Network checks for a session that failed to connect, run from this computer. */
export function registerDiagnosticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/diagnostics/connection', async (req, reply) => {
    try {
      const parsed = diagnoseSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpProblem(400, 'invalid diagnostics request');
      const { profile } = parsed.data;
      let response: ConnectionDiagnosticsResponse;
      if (profile.kind === 'telnet') {
        response = await diagnoseTelnet(profile);
      } else {
        let chain;
        try {
          chain = ctx.connections.dialPlan(profile);
        } catch (err) {
          // A broken plan (missing saved jump host, ProxyJump cycle) is
          // itself the diagnosis; nothing was dialed.
          throw new HttpProblem(422, err instanceof Error ? err.message : String(err));
        }
        response = await diagnoseSsh(chain);
      }
      req.log.info(
        { checked: response.checked, failed: response.checks.filter((c) => c.status === 'fail').map((c) => c.label) },
        'connection diagnostics',
      );
      return response;
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
