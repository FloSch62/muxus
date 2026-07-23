import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TunnelRecord, TunnelsResponse } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';

const sshOptionsSchema = z
  .object({
    user: z.string().trim().min(1).max(200).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    identityFiles: z.array(z.string().trim().min(1).max(4096)).max(32).optional(),
    identitiesOnly: z.boolean().optional(),
    forwardAgent: z.boolean().optional(),
    proxyJump: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
    passwordOnly: z.boolean().optional(),
  })
  .strict();

const tunnelSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().max(200).optional(),
    target: z.string().trim().min(1).max(500),
    sshOptions: sshOptionsSchema.optional(),
    type: z.enum(['local', 'remote', 'dynamic']),
    bindPort: z.number().int().min(1).max(65535),
    targetHost: z.string().min(1).max(500).optional(),
    targetPort: z.number().int().min(1).max(65535).optional(),
  })
  .refine((t) => t.type === 'dynamic' || (!!t.targetHost && !!t.targetPort), {
    message: 'targetHost and targetPort are required for local/remote tunnels',
  });

/** Saved tunnel definitions — start/stop happens via /api/forwards. */
export function registerTunnelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/tunnels', (): TunnelsResponse => ({ tunnels: ctx.database.listTunnels() }));

  app.put('/api/tunnels', async (req, reply): Promise<TunnelRecord | void> => {
    try {
      const parsed = tunnelSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid tunnel' });
      }
      return ctx.database.saveTunnel(parsed.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/tunnels/:id', (req) => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.database.deleteTunnel(id) };
  });
}
