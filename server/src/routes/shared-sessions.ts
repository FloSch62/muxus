import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_SHARED_SESSION_HOSTS,
  MAX_SHARED_SESSIONS_BYTES,
  MAX_SHARED_SESSIONS_REFRESH_MINUTES,
  type SharedSessionApplyResult,
  type SharedSessionFetchResponse,
  type SharedSessionHost,
  type SharedSessionSource,
  type SharedSessionSourcesResponse,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import { fetchSharedSessions, storedSharedSessionsLocation } from '../shared-sessions/fetch.js';
import { HttpProblem, sendError } from '../util/errors.js';
import { normalizeFolderPath } from '../util/folder-paths.js';
import { savedHostSessionProfileSchema } from './profiles.js';

/** JSON spells some characters in six bytes, and a list's hosts repeat their folder. */
const APPLY_BODY_LIMIT = MAX_SHARED_SESSIONS_BYTES * 4;

const sourceSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200),
    url: z.string().trim().min(1).max(4096),
    folder: z.string().max(300),
    refreshMinutes: z.number().int().min(0).max(MAX_SHARED_SESSIONS_REFRESH_MINUTES),
  })
  .strict();

const hostSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  profile: savedHostSessionProfileSchema,
  group: z.string().max(300).optional(),
  color: z.string().max(64).optional(),
  icon: z.string().max(64).optional(),
});

const applySchema = z.union([
  z.object({ hosts: z.array(z.unknown()).max(MAX_SHARED_SESSION_HOSTS) }).strict(),
  z.object({ error: z.string().trim().min(1).max(1000) }).strict(),
]);

/**
 * A list read from a link changes without the user looking at it again, so
 * it does not get to set what runs on this computer or weakens a check:
 * ProxyCommand, agent forwarding, remote forwards and host key checking stay
 * the user's to set.
 */
function withoutLocalEffects(host: SharedSessionHost): SharedSessionHost {
  if (host.profile.kind !== 'ssh') return host;
  const {
    proxyCommand: _proxyCommand,
    forwardAgent: _forwardAgent,
    strictHostKeyChecking: _strictHostKeyChecking,
    forwards,
    ...profile
  } = host.profile;
  const kept = forwards?.filter((forward) => forward.type !== 'remote');
  return {
    ...host,
    profile: { ...profile, useConfig: false, ...(kept?.length ? { forwards: kept } : {}) },
  };
}

function parseHosts(values: readonly unknown[]): SharedSessionHost[] {
  return values.map((value, index) => {
    const parsed = hostSchema.safeParse(value);
    if (!parsed.success) {
      const name =
        value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string'
          ? `“${(value as { name: string }).name.slice(0, 80)}”`
          : `entry ${index + 1}`;
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
      throw new HttpProblem(400, `${name} is not a valid host: ${issue?.message ?? 'invalid'}${where}`);
    }
    const group = normalizeFolderPath(parsed.data.group);
    const { group: _group, ...host } = parsed.data;
    return withoutLocalEffects({ ...host, ...(group ? { group } : {}) } as SharedSessionHost);
  });
}

/**
 * Session lists published at a link. The server keeps the links, reads them
 * and stores their hosts; the client turns a list's text into hosts, since
 * the importers live there.
 */
export function registerSharedSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/shared-sessions', (): SharedSessionSourcesResponse => ({
    sources: ctx.database.listSharedSessionSources(),
  }));

  app.put('/api/shared-sessions', async (req, reply): Promise<SharedSessionSource | void> => {
    try {
      const parsed = sourceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid shared sessions link');
      }
      const folder = normalizeFolderPath(parsed.data.folder);
      if (!folder) throw new HttpProblem(400, 'Choose a folder for the shared sessions.');
      return ctx.database.saveSharedSessionSource({
        ...parsed.data,
        url: storedSharedSessionsLocation(parsed.data.url),
        folder,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { keepHosts?: string } }>(
    '/api/shared-sessions/:id',
    (req) => ({
      deleted: ctx.database.deleteSharedSessionSource(req.params.id, req.query.keepHosts === 'true'),
    }),
  );

  app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/api/shared-sessions/:id/fetch',
    async (req, reply): Promise<SharedSessionFetchResponse | void> => {
      const { id } = req.params;
      try {
        const source = ctx.database.beginSharedSessionCheck(id, req.query.force === 'true');
        if (!source) throw new HttpProblem(404, 'shared sessions link not found');
        if (source === 'not-due') return { status: 'not-due' };
        try {
          return { status: 'fetched', content: await fetchSharedSessions(source.url) };
        } catch (err) {
          ctx.database.failSharedSessionCheck(id, err instanceof Error ? err.message : String(err));
          throw err;
        }
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/shared-sessions/:id/apply',
    { bodyLimit: APPLY_BODY_LIMIT },
    async (req, reply): Promise<SharedSessionApplyResult | void> => {
      const { id } = req.params;
      try {
        const parsed = applySchema.safeParse(req.body);
        if (!parsed.success) {
          throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid shared sessions');
        }
        if ('error' in parsed.data) {
          const source = ctx.database.failSharedSessionCheck(id, parsed.data.error);
          if (!source) throw new HttpProblem(404, 'shared sessions link not found');
          return { source, added: 0, updated: 0, removed: 0, unchanged: source.hostCount };
        }
        let counts: ReturnType<typeof ctx.database.applySharedSessions>;
        try {
          const hosts = parseHosts(parsed.data.hosts);
          // An empty list is far more often a broken export than a lab without hosts.
          if (hosts.length === 0) throw new HttpProblem(400, 'The shared sessions list has no hosts.');
          counts = ctx.database.applySharedSessions(id, hosts);
        } catch (err) {
          ctx.database.failSharedSessionCheck(id, err instanceof Error ? err.message : String(err));
          throw err instanceof HttpProblem ? err : new HttpProblem(400, err instanceof Error ? err.message : String(err));
        }
        if (!counts) throw new HttpProblem(404, 'shared sessions link not found');
        return { source: ctx.database.sharedSessionSource(id)!, ...counts };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
