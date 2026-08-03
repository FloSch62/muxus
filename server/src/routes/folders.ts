import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  FolderAuthSettings,
  FolderSettingsRecord,
  FolderSettingsResponse,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import type { FolderSettingsRow } from '../persistence/database.js';
import {
  folderPasswordAccount,
  folderPasswordLabel,
} from '../security/password-vault.js';
import {
  folderPathKey,
  isDescendantFolderPath,
  normalizeFolderPath,
} from '../util/folder-paths.js';
import { sendError } from '../util/errors.js';
import { sendVaultError } from './password-vault.js';

// Mirrors the metadata group cap: a path covers several nested folder names.
const pathSchema = z.string().min(1).max(300);

// Length caps only — cleanAuth trims values and drops the empty ones.
const authSchema = z.object({
  user: z.string().max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFiles: z.array(z.string().max(1024)).max(10).optional(),
  identitiesOnly: z.boolean().optional(),
  identityAgent: z.string().max(1024).optional(),
  forwardAgent: z.boolean().optional(),
});

const upsertSchema = z.object({ path: pathSchema, auth: authSchema });
const moveSchema = z.object({ from: pathSchema, to: pathSchema });
const pathQuerySchema = z.object({ path: pathSchema });
const passwordSchema = z.object({
  path: pathSchema,
  password: z.string().min(1).max(8192),
  masterPassword: z.string().min(1).max(1024).optional(),
});

/**
 * Shared credential defaults for sidebar folders. Non-secret settings live in
 * the folder_settings table; the folder password goes through the encrypted
 * password vault, referenced by the settings row's stable ID.
 */
export function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const record = (row: FolderSettingsRow): FolderSettingsRecord => ({
    id: row.id,
    path: row.path,
    auth: row.auth,
    hasPassword: ctx.vault.hasSshPassword(folderPasswordAccount(row.id)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  app.get('/api/folders/settings', (): FolderSettingsResponse => ({
    folders: ctx.database.listFolderSettings().map(record),
  }));

  app.put('/api/folders/settings', async (req, reply): Promise<{ folder: FolderSettingsRecord | null } | void> => {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success || !normalizeFolderPath(parsed.data.path)) {
      return reply.code(400).send({ message: parsed.success ? 'a folder path is required' : (parsed.error.issues[0]?.message ?? 'invalid folder settings') });
    }
    try {
      const auth = cleanAuth(parsed.data.auth);
      const row = ctx.database.upsertFolderSettings(parsed.data.path, auth);
      // A folder with no settings and no password needs no row at all.
      if (
        Object.keys(auth).length === 0 &&
        !ctx.vault.hasSshPassword(folderPasswordAccount(row.id))
      ) {
        ctx.database.removeFolderSettingsRow(row.id);
        return { folder: null };
      }
      return { folder: record(row) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Rename or re-parent: settings and vault labels follow the path rewrite. */
  app.post('/api/folders/settings/move', async (req, reply): Promise<{
    moved: number;
    destinationPreserved: boolean;
  } | void> => {
    const parsed = moveSchema.safeParse(req.body);
    if (!parsed.success || !normalizeFolderPath(parsed.data.from) || !normalizeFolderPath(parsed.data.to)) {
      return reply.code(400).send({ message: 'both folder paths are required' });
    }
    try {
      // Tell rename callers whether the destination already owned the root
      // settings row. They must not save the source dialog fields over that
      // retained row after the destination-wins merge.
      const sourceKey = folderPathKey(parsed.data.from);
      const targetKey = folderPathKey(parsed.data.to);
      const destinationPreserved =
        sourceKey !== targetKey && !!ctx.database.folderSettingsForPath(parsed.data.to);
      const { moved, dropped } = ctx.database.moveFolderSettings(parsed.data.from, parsed.data.to);
      for (const row of dropped) {
        ctx.vault.deleteSshPassword(folderPasswordAccount(row.id));
      }
      for (const row of ctx.database.listFolderSettings()) {
        if (row.pathKey !== targetKey && !isDescendantFolderPath(row.path, parsed.data.to)) continue;
        ctx.vault.relabelSshPassword(
          folderPasswordAccount(row.id),
          folderPasswordLabel(row.path),
        );
      }
      return { moved, destinationPreserved };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Folder deletion: drop its settings, promote descendants one level up. */
  app.delete('/api/folders/settings', async (req, reply): Promise<{ removed: number } | void> => {
    const parsed = pathQuerySchema.safeParse(req.query);
    if (!parsed.success || !normalizeFolderPath(parsed.data.path)) {
      return reply.code(400).send({ message: 'a folder path is required' });
    }
    try {
      const { removed } = ctx.database.deleteFolderSettings(parsed.data.path);
      for (const row of removed) {
        ctx.vault.deleteSshPassword(folderPasswordAccount(row.id));
      }
      return { removed: removed.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/api/folders/settings/password', async (req, reply): Promise<{ folder: FolderSettingsRecord } | void> => {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success || !normalizeFolderPath(parsed.data.path)) {
      return reply.code(400).send({ message: 'a folder path and password are required' });
    }
    const existing = ctx.database.folderSettingsForPath(parsed.data.path);
    const row = existing ?? ctx.database.upsertFolderSettings(parsed.data.path, {});
    try {
      await ctx.vault.rememberSshPassword(
        folderPasswordAccount(row.id),
        folderPasswordLabel(row.path),
        parsed.data.password,
        parsed.data.masterPassword,
      );
      return { folder: record(row) };
    } catch (err) {
      // Don't leave behind an empty row created only to key this password.
      if (!existing) ctx.database.removeFolderSettingsRow(row.id);
      return sendVaultError(reply, err);
    }
  });

  app.delete('/api/folders/settings/password', async (req, reply): Promise<{ deleted: boolean } | void> => {
    const parsed = pathQuerySchema.safeParse(req.query);
    if (!parsed.success || !normalizeFolderPath(parsed.data.path)) {
      return reply.code(400).send({ message: 'a folder path is required' });
    }
    try {
      const row = ctx.database.folderSettingsForPath(parsed.data.path);
      if (!row) return { deleted: false };
      const deleted = ctx.vault.deleteSshPassword(folderPasswordAccount(row.id));
      if (Object.keys(cleanAuth(row.auth)).length === 0) {
        ctx.database.removeFolderSettingsRow(row.id);
      }
      return { deleted };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

/** Drop empty strings and empty lists so "cleared" fields don't linger. */
function cleanAuth(auth: FolderAuthSettings): FolderAuthSettings {
  const out: FolderAuthSettings = {};
  const user = auth.user?.trim();
  if (user) out.user = user;
  if (auth.port !== undefined) out.port = auth.port;
  const identityFiles = (auth.identityFiles ?? [])
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  if (identityFiles.length > 0) out.identityFiles = identityFiles;
  if (auth.identitiesOnly !== undefined) out.identitiesOnly = auth.identitiesOnly;
  const identityAgent = auth.identityAgent?.trim();
  if (identityAgent) out.identityAgent = identityAgent;
  if (auth.forwardAgent !== undefined) out.forwardAgent = auth.forwardAgent;
  return out;
}
