import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  TERMINAL_SNAPSHOT_MAX_CHARS,
  type TerminalSnapshotRecord,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import { HttpProblem, sendError } from '../util/errors.js';

const snapshotSaveSchema = z.object({
  data: z.string().min(1).max(TERMINAL_SNAPSHOT_MAX_CHARS),
  formatVersion: z.number().int().positive().optional(),
});

// Serialized scrollback rides in a JSON string, where every ESC byte inflates
// to six characters, so the body can be several times the raw snapshot cap.
const SNAPSHOT_BODY_LIMIT = 4 * 1024 * 1024;

export function registerTerminalSnapshotRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/api/terminal-snapshots/:tabId',
    (req): { snapshot: TerminalSnapshotRecord | null } => {
      const { tabId } = req.params as { tabId: string };
      return { snapshot: ctx.database.terminalSnapshot(tabId) ?? null };
    },
  );

  app.put(
    '/api/terminal-snapshots/:tabId',
    { bodyLimit: SNAPSHOT_BODY_LIMIT },
    async (req, reply): Promise<{ saved: boolean } | void> => {
      const { tabId } = req.params as { tabId: string };
      const parsed = snapshotSaveSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, new HttpProblem(400, 'invalid terminal snapshot'));
      }
      ctx.database.saveTerminalSnapshot(
        tabId,
        parsed.data.data,
        parsed.data.formatVersion,
      );
      return { saved: true };
    },
  );
}
