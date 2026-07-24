import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SavedHostProfilesResponse,
} from '@muxus/shared';
import {
  serialProfileSchema,
  telnetProfileSchema,
} from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';
import { metadataPatchSchema } from './metadata-schema.js';

const savedProfileSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
  profile: z.discriminatedUnion('kind', [telnetProfileSchema, serialProfileSchema]),
});

/** Muxus-owned Telnet and serial hosts. */
export function registerProfileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/profiles', (): SavedHostProfilesResponse => ({
    profiles: ctx.database.listSavedHostProfiles(),
  }));

  app.put('/api/profiles', async (req, reply): Promise<SavedHostProfile | void> => {
    try {
      const parsed = savedProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({
          message: parsed.error.issues[0]?.message ?? 'invalid saved host',
        });
      }
      return ctx.database.saveSavedHostProfile(parsed.data satisfies SavedHostProfileInput);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/profiles/:id/metadata', async (req, reply): Promise<SavedHostProfile | void> => {
    try {
      const { id } = req.params as { id: string };
      const parsed = metadataPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({
          message: parsed.error.issues[0]?.message ?? 'invalid metadata',
        });
      }
      return ctx.database.updateSavedHostMetadata(id, parsed.data satisfies OpenSshMetadataPatch);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/profiles/:id', (req) => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.database.deleteSavedHostProfile(id) };
  });
}
