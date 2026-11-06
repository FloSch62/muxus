import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SavedScript, SavedScriptsResponse, ScriptRunStatus } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';

const MAX_BODY = 1024 * 1024;

const scriptSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200),
    body: z.string().max(MAX_BODY),
  })
  .strict();

const runSchema = z
  .object({
    connId: z.string().min(1).max(200),
    body: z.string().min(1).max(MAX_BODY),
    timeoutSeconds: z.number().int().min(0).max(7 * 24 * 3600).optional(),
  })
  .strict();

/** The script library, and runs of a script on live SSH connections. */
export function registerScriptRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/scripts', (): SavedScriptsResponse => ({ scripts: ctx.database.listScripts() }));

  app.put('/api/scripts', async (req, reply): Promise<SavedScript | void> => {
    const parsed = scriptSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid script' });
    }
    try {
      return ctx.database.saveScript(parsed.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/scripts/:id', (req) => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.database.deleteScript(id) };
  });

  app.post('/api/script-runs', async (req, reply) => {
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues[0]?.message ?? 'invalid run' });
    }
    try {
      return await ctx.scriptRuns.start(parsed.data.connId, parsed.data.body, parsed.data.timeoutSeconds);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/script-runs/:id', async (req, reply): Promise<ScriptRunStatus | void> => {
    const { id } = req.params as { id: string };
    const since = Number((req.query as { since?: string }).since ?? 0);
    try {
      return ctx.scriptRuns.status(id, Number.isFinite(since) && since > 0 ? since : 0);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/script-runs/:id', (req) => {
    const { id } = req.params as { id: string };
    ctx.scriptRuns.cancel(id);
    return { ok: true };
  });
}
