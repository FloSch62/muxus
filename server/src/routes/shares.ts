import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ShareMountResponse, ShareMountsResponse } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';

const mountRequestSchema = z
  .object({
    password: z.string().max(1024).optional(),
    remember: z.boolean().optional(),
    forwardPort: z.number().int().min(1).max(65535).optional(),
    forwardId: z.string().min(1).max(100).optional(),
  })
  .strict();

/** Mount and unmount saved SMB and NFS shares with the operating system's own clients. */
export function registerShareRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/shares', (): ShareMountsResponse => ({ mounts: ctx.shares.list() }));

  app.post('/api/shares/:id/mount', async (req, reply): Promise<ShareMountResponse | void> => {
    try {
      const { id } = req.params as { id: string };
      const parsed = mountRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid mount request' });
      }
      const result = await ctx.shares.mount(id, parsed.data);
      if (result.status === 'mounted') {
        try {
          ctx.database.recordSavedHostConnection(id);
        } catch (err) {
          req.log.warn({ err }, 'could not record recent connection');
        }
      }
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/shares/:id/unmount', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return await ctx.shares.unmount(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
