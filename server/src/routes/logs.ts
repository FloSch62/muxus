import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppLogsResponse } from '@muxus/shared';
import { baseLogLevel } from '../app.js';
import {
  APP_LOG_CAPACITY,
  appLogEntries,
  clearAppLog,
} from '../logging/log-buffer.js';
import { sendError, HttpProblem } from '../util/errors.js';

const settingsSchema = z.object({ debugEnabled: z.boolean() });

function debugEnabled(app: FastifyInstance): boolean {
  return app.log.level === 'debug' || app.log.level === 'trace';
}

export function registerLogRoutes(app: FastifyInstance): void {
  app.get('/api/logs', (): AppLogsResponse => ({
    entries: appLogEntries(),
    debugEnabled: debugEnabled(app),
    capacity: APP_LOG_CAPACITY,
  }));

  app.put('/api/logs/settings', async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, new HttpProblem(400, 'debugEnabled must be a boolean'));
    }
    const base = baseLogLevel();
    const wasEnabled = debugEnabled(app);
    // An explicit LOG_LEVEL=trace stays trace; the toggle never lowers it.
    app.log.level = parsed.data.debugEnabled
      ? base === 'trace' ? 'trace' : 'debug'
      : base;
    if (parsed.data.debugEnabled !== wasEnabled) {
      app.log.info(
        parsed.data.debugEnabled ? 'debug logging enabled' : 'debug logging disabled',
      );
    }
    return { debugEnabled: debugEnabled(app) };
  });

  app.delete('/api/logs', () => {
    clearAppLog();
    return { cleared: true };
  });
}
