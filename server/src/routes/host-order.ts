import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';

const hostOrderSchema = z.object({
  hosts: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('ssh'), alias: z.string().min(1).max(200) }),
        z.object({ kind: z.literal('profile'), id: z.string().min(1).max(200) }),
      ]),
    )
    .max(10_000),
});

/** One visual sidebar order spanning OpenSSH hosts and saved Telnet/serial hosts. */
export function registerHostOrderRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.put('/api/hosts/order', async (req, reply) => {
    try {
      const parsed = hostOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid host order' });
      }
      const keys = parsed.data.hosts.map((ref) => (ref.kind === 'ssh' ? `ssh:${ref.alias}` : `profile:${ref.id}`));
      if (new Set(keys).size !== keys.length) {
        return await reply.code(400).send({ message: 'host order contains duplicates' });
      }
      ctx.database.reorderManagedHosts(parsed.data.hosts);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
