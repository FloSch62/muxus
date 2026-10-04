import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  HostBulkUpdateResponse,
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
import { batchFolderAuthResolver } from '../ssh/folder-auth.js';
import { deleteHost, patchHosts, previewHost, upsertHost } from '../ssh/ssh-config-edit.js';
import { listSshKeys } from '../ssh/key-scan.js';

const forwardSchema = z.object({
  type: z.enum(['local', 'remote', 'dynamic']),
  bindPort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1).optional(),
  targetPort: z.number().int().min(1).max(65535).optional(),
});

const sshKeysQuerySchema = z.object({
  identityAgent: z.string().max(4096).optional(),
});

const strictHostKeyCheckingSchema = z.enum(['yes', 'no', 'accept-new', 'ask']);

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
    certificateFiles: z.array(z.string()).optional(),
    identitiesOnly: z.boolean().optional(),
    identityAgent: z.string().optional(),
    forwardAgent: z.boolean().optional(),
    forwardX11: z.boolean().optional(),
    proxyJump: z.array(z.string()).optional(),
    proxyCommand: z.string().optional(),
    forwards: z.array(forwardSchema).optional(),
    passwordOnly: z.boolean().optional(),
    remoteCommand: z.string().optional(),
    requestTty: z.enum(['no', 'yes', 'force', 'auto']).optional(),
    strictHostKeyChecking: strictHostKeyCheckingSchema.optional(),
    extras: z.array(z.object({ keyword: z.string(), value: z.string() })).optional(),
  }),
});

const bulkUpdateSchema = z.object({
  aliases: z.array(z.string().min(1)).min(1).max(5000),
  options: z
    .object({
      user: z.string().nullable().optional(),
      port: z.number().int().min(1).max(65535).nullable().optional(),
      forwardAgent: z.boolean().nullable().optional(),
      forwardX11: z.boolean().nullable().optional(),
      strictHostKeyChecking: strictHostKeyCheckingSchema.nullable().optional(),
    })
    // Only these options are safe to set across hosts; anything else is a mistake.
    .strict()
    .refine((options) => Object.keys(options).length > 0, 'at least one option is required'),
});

/** Live OpenSSH config plus Muxus-owned metadata, editing, and key discovery. */
export function registerSshRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/ssh/config', (): SshConfigResponse => {
    const doc = loadConfigDocument();
    // Resolved values include folder defaults, so the list and the editor show
    // exactly what connect will use.
    const folderAuth = batchFolderAuthResolver(ctx.database);
    const hosts = listHosts(doc, (alias) => folderAuth(alias)?.optionLines).sort(
      (a, b) => a.alias.localeCompare(b.alias),
    );
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

  // One change across many hosts, in a single write per config file.
  app.patch('/api/ssh/config/hosts', async (req, reply): Promise<HostBulkUpdateResponse | void> => {
    try {
      const parsed = bulkUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid host update' });
      }
      return patchHosts(parsed.data.aliases, parsed.data.options);
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
      ctx.database.deleteSessionLoggingPolicy(`ssh:${alias}`);
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

  app.get('/api/ssh/keys', async (req, reply): Promise<SshKeysResponse | void> => {
    const parsed = sshKeysQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return await reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid SSH key query' });
    }
    return listSshKeys({ identityAgent: parsed.data.identityAgent });
  });
}
