import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  HostPreviewResponse,
  OpenSshMetadataPatch,
  OpenSshProfileMetadata,
  SshConfigResponse,
  SshKeysResponse,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';
import { metadataPatchSchema } from './metadata-schema.js';
import { defaultSshConfigPath, listHosts, loadConfigDocument } from '../ssh/ssh-config.js';
import { deleteHost, previewHost, upsertHost } from '../ssh/ssh-config-edit.js';
import { listSshKeys } from '../ssh/key-scan.js';

const forwardSchema = z.object({
  type: z.enum(['local', 'remote', 'dynamic']),
  bindPort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1).optional(),
  targetPort: z.number().int().min(1).max(65535).optional(),
});

const upsertSchema = z.object({
  aliases: z.array(z.string().min(1)).min(1),
  description: z.string().max(2000).optional(),
  file: z.string().optional(),
  previousAlias: z.string().optional(),
  options: z.object({
    hostname: z.string().optional(),
    user: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    identityFiles: z.array(z.string()).optional(),
    identitiesOnly: z.boolean().optional(),
    forwardAgent: z.boolean().optional(),
    proxyJump: z.array(z.string()).optional(),
    forwards: z.array(forwardSchema).optional(),
    passwordOnly: z.boolean().optional(),
    extras: z.array(z.object({ keyword: z.string(), value: z.string() })).optional(),
  }),
});

/** Live OpenSSH config plus Muxus-owned metadata, editing, and key discovery. */
export function registerSshRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/ssh/config', (): SshConfigResponse => {
    const doc = loadConfigDocument();
    const hosts = listHosts(doc).sort((a, b) => a.alias.localeCompare(b.alias));
    const metadata = ctx.database.openSshMetadata(hosts.map((host) => host.alias));
    return {
      path: defaultSshConfigPath(),
      files: doc.fileOrder,
      hosts: hosts.map((host) => ({ ...host, metadata: metadata.get(host.alias) })),
      error: doc.error,
    };
  });

  app.post('/api/ssh/config/hosts', async (req, reply) => {
    try {
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid host payload' });
      }
      const result = upsertHost(parsed.data);
      const nextAlias = parsed.data.aliases[0]!;
      if (parsed.data.previousAlias) {
        ctx.database.renameOpenSshAlias(parsed.data.previousAlias, nextAlias);
      }
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/ssh/config/preview', async (req, reply): Promise<HostPreviewResponse | void> => {
    try {
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid host payload' });
      }
      return { text: previewHost(parsed.data) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/ssh/config/hosts/:alias', async (req, reply) => {
    try {
      const { alias } = req.params as { alias: string };
      deleteHost(alias);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/ssh/config/hosts/:alias/metadata', async (req, reply): Promise<OpenSshProfileMetadata | void> => {
    try {
      const { alias } = req.params as { alias: string };
      const parsed = metadataPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid metadata payload' });
      }
      return ctx.database.updateOpenSshMetadata(alias, parsed.data satisfies OpenSshMetadataPatch);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/ssh/keys', async (): Promise<SshKeysResponse> => listSshKeys());
}
