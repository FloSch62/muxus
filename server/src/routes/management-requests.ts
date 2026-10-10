import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SavedManagementRequest } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';

const protocolSchema = z.enum(['gnmi', 'netconf']);

const savedRequestSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  protocol: protocolSchema,
  profileId: z.string().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
  request: z.record(z.string(), z.unknown()),
});

/** Largest request (editor state, including any XML or JSON body) the library keeps. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Saved NETCONF and gNMI requests, per host or for every host of a protocol. */
export function registerManagementRequestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/management/requests', async (req, reply): Promise<{ requests: SavedManagementRequest[] } | void> => {
    const query = req.query as { protocol?: string; profileId?: string };
    const protocol = protocolSchema.safeParse(query.protocol);
    if (!protocol.success) return await reply.code(400).send({ message: 'protocol must be gnmi or netconf' });
    return { requests: ctx.database.listManagementRequests(protocol.data, query.profileId || undefined) };
  });

  app.put('/api/management/requests', async (req, reply): Promise<SavedManagementRequest | void> => {
    try {
      const parsed = savedRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid request' });
      }
      if (JSON.stringify(parsed.data.request).length > MAX_REQUEST_BYTES) {
        return await reply.code(413).send({ message: 'The request is too large to save.' });
      }
      return ctx.database.saveManagementRequest(parsed.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/management/requests/:id', (req) => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.database.deleteManagementRequest(id) };
  });
}
