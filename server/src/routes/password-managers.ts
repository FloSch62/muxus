import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  PASSWORD_MANAGER_KINDS,
  type PasswordManagerEntriesResponse,
  type PasswordManagerSource,
  type PasswordManagersResponse,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import { PasswordManagerSourceMissingError } from '../password-managers/password-managers.js';
import { PasswordManagerError, type PasswordManagerProblem } from '../password-managers/provider.js';
import { HttpProblem, sendError } from '../util/errors.js';

const configSchema = z.object({
  path: z.string().max(4096).optional(),
  keyFile: z.string().max(4096).optional(),
  program: z.string().max(4096).optional(),
  account: z.string().max(200).optional(),
});

const sourceSchema = z.object({
  kind: z.enum(PASSWORD_MANAGER_KINDS),
  name: z.string().max(200).optional(),
  config: configSchema,
});

const unlockSchema = z.object({ password: z.string().max(8192) });

const STATUS: Record<PasswordManagerProblem, number> = {
  unavailable: 503,
  locked: 423,
  'signed-out': 409,
  // Not 401: the window takes that for a rejected backend token.
  'invalid-unlock': 422,
  'entry-missing': 404,
  timeout: 504,
  failed: 502,
};

/**
 * Connected password managers and the entry picker. Entries are listed with
 * their titles and user names only: no route returns a password, which is
 * read on the backend at the moment a login needs it.
 */
export function registerPasswordManagerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/password-managers', (): Promise<PasswordManagersResponse> => ctx.passwordManagers.list());

  app.post('/api/password-managers', async (req, reply): Promise<PasswordManagerSource | void> => {
    const parsed = sourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: 'A valid password manager is required.' });
    if (parsed.data.kind === 'keepass' && !parsed.data.config.path?.trim()) {
      return reply.code(400).send({ message: 'Choose the KeePass database file.' });
    }
    try {
      return await ctx.passwordManagers.create(parsed.data);
    } catch (err) {
      return sendPasswordManagerError(reply, err);
    }
  });

  app.put('/api/password-managers/:id', async (req, reply): Promise<PasswordManagerSource | void> => {
    const { id } = req.params as { id: string };
    const parsed = sourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: 'A valid password manager is required.' });
    if (parsed.data.kind === 'keepass' && !parsed.data.config.path?.trim()) {
      return reply.code(400).send({ message: 'Choose the KeePass database file.' });
    }
    try {
      const source = await ctx.passwordManagers.update(id, parsed.data);
      if (!source) throw new PasswordManagerSourceMissingError();
      return source;
    } catch (err) {
      return sendPasswordManagerError(reply, err);
    }
  });

  app.delete('/api/password-managers/:id', (req): { deleted: boolean } => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.passwordManagers.remove(id) };
  });

  app.post('/api/password-managers/:id/unlock', async (req, reply): Promise<PasswordManagerSource | void> => {
    const { id } = req.params as { id: string };
    const parsed = unlockSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: 'A password is required.' });
    try {
      return await ctx.passwordManagers.unlock(id, parsed.data.password);
    } catch (err) {
      return sendPasswordManagerError(reply, err);
    }
  });

  app.post('/api/password-managers/:id/lock', async (req, reply): Promise<PasswordManagerSource | void> => {
    const { id } = req.params as { id: string };
    try {
      return await ctx.passwordManagers.lock(id);
    } catch (err) {
      return sendPasswordManagerError(reply, err);
    }
  });

  app.get('/api/password-managers/:id/entries', async (req, reply): Promise<PasswordManagerEntriesResponse | void> => {
    const { id } = req.params as { id: string };
    const { sync } = req.query as { sync?: string };
    try {
      const entries = await ctx.passwordManagers.entries(id, { sync: sync === '1' });
      return await reply.header('cache-control', 'no-store').send({ entries });
    } catch (err) {
      return sendPasswordManagerError(reply, err);
    }
  });
}

function sendPasswordManagerError(reply: FastifyReply, err: unknown): Promise<void> {
  if (err instanceof PasswordManagerError) {
    return sendError(reply, new HttpProblem(STATUS[err.problem], err.message, `password-manager-${err.problem}`));
  }
  if (err instanceof PasswordManagerSourceMissingError) {
    return sendError(reply, new HttpProblem(404, err.message, 'password-manager-missing'));
  }
  return sendError(reply, err);
}
