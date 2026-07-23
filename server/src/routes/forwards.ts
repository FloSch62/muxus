import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConnectionsResponse } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';

const forwardRequestSchema = z.object({
  connId: z.string().min(1),
  type: z.enum(['local', 'remote', 'dynamic']),
  bindPort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1).optional(),
  targetPort: z.number().int().min(1).max(65535).optional(),
  tunnelId: z.string().min(1).optional(),
});

export function registerForwardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/forwards', (req) => {
    const { connId } = req.query as { connId?: string };
    return { forwards: ctx.forwards.list(connId) };
  });

  app.post('/api/forwards', async (req, reply) => {
    try {
      const parsed = forwardRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid forward request' });
      }
      return await ctx.forwards.start(parsed.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/forwards/:id', (req) => {
    const { id } = req.params as { id: string };
    ctx.forwards.stop(id);
    return { ok: true };
  });

  // Adopt a running forward into a saved tunnel ("save as tunnel" without
  // restarting the listener).
  app.patch('/api/forwards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ tunnelId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'tunnelId is required' });
    }
    const info = ctx.forwards.assignTunnel(id, parsed.data.tunnelId);
    if (!info) return reply.code(404).send({ message: 'forward not found' });
    return info;
  });

  // Live SSH transports — lets the forwarding panel reuse an existing
  // connection for a tunnel instead of dialing a second one.
  app.get('/api/connections', (): ConnectionsResponse => ({ connections: ctx.connections.list() }));
}
