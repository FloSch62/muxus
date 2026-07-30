import type { FastifyInstance, FastifyReply } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import type {
  SessionHistoryResponse,
  SessionHistoryStorageStatus,
  SessionLogDetail,
  SessionLoggingPolicy,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import { defaultHistoryRoot } from '../session-logging/history-store.js';
import { HttpProblem, sendError } from '../util/errors.js';

const TRANSCRIPT_PREVIEW_EVENTS = 5_000;

const historyQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
  profileKey: z.string().trim().min(1).max(500).optional(),
  host: z.string().trim().max(500).optional(),
  kind: z.enum(['ssh', 'local', 'serial', 'telnet']).optional(),
  startedAfter: z.iso.datetime().optional(),
  startedBefore: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1000).optional(),
});

const policyKeySchema = z.object({
  profileKey: z.string().trim().min(1).max(500),
});

const policySchema = z.object({
  enabled: z.boolean(),
  captureInput: z.boolean(),
  maxPartBytes: z.number().int().min(64 * 1024).max(1024 * 1024 * 1024),
  maxParts: z.number().int().min(1).max(1000),
});

const historySettingsSchema = z.object({
  storageLocation: z.string().trim().max(4096).optional(),
  maxTotalBytes: z.number().int().min(64 * 1024 * 1024),
  minFreeBytes: z.number().int().min(0),
  minFreePercent: z.number().min(0).max(100),
  maxAgeDays: z.number().int().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.storageLocation && !path.isAbsolute(value.storageLocation)) {
    ctx.addIssue({
      code: 'custom',
      path: ['storageLocation'],
      message: 'storageLocation must be an absolute path',
    });
  } else if (
    value.storageLocation &&
    path.parse(path.resolve(value.storageLocation)).root ===
      path.resolve(value.storageLocation)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['storageLocation'],
      message: 'storageLocation cannot be the filesystem root',
    });
  }
});

const pinSchema = z.object({ pinned: z.boolean() });

const detailQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
});

export function registerSessionHistoryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get('/api/session-history', async (req): Promise<SessionHistoryResponse> => {
    const parsed = historyQuerySchema.parse(req.query);
    return ctx.history.sessionHistory(parsed);
  });

  app.get(
    '/api/session-history/storage',
    async (): Promise<SessionHistoryStorageStatus> => {
      const settings = ctx.database.sessionHistorySettings();
      return ctx.history.storageStatus(configuredStorageLocation(ctx, settings));
    },
  );

  app.put(
    '/api/session-history/storage',
    async (req, reply): Promise<SessionHistoryStorageStatus | void> => {
      try {
        const settings = ctx.database.saveSessionHistorySettings(
          historySettingsSchema.parse(req.body),
        );
        await ctx.history.updateSettings(settings);
        return ctx.history.storageStatus(configuredStorageLocation(ctx, settings));
      } catch (err) {
        return sendError(reply, asRouteError(err));
      }
    },
  );

  app.get('/api/session-history/policy', (req): SessionLoggingPolicy => {
    const { profileKey } = policyKeySchema.parse(req.query);
    return ctx.database.sessionLoggingPolicy(profileKey);
  });

  app.put(
    '/api/session-history/policy',
    async (req, reply): Promise<SessionLoggingPolicy | void> => {
      try {
        const { profileKey } = policyKeySchema.parse(req.query);
        const input = policySchema.parse(req.body);
        return ctx.database.saveSessionLoggingPolicy(profileKey, input);
      } catch (err) {
        return sendError(reply, asRouteError(err));
      }
    },
  );

  app.delete('/api/session-history/policy', (req): { deleted: boolean } => {
    const { profileKey } = policyKeySchema.parse(req.query);
    return { deleted: ctx.database.deleteSessionLoggingPolicy(profileKey) };
  });

  app.get(
    '/api/session-history/:id',
    async (req, reply): Promise<SessionLogDetail | void> => {
      const { id } = req.params as { id: string };
      const { query } = detailQuerySchema.parse(req.query);
      const session = await ctx.history.sessionLog(
        id,
        TRANSCRIPT_PREVIEW_EVENTS,
        query || undefined,
      );
      if (!session) {
        await reply.code(404).send({ message: 'session log not found' });
        return;
      }
      return session;
    },
  );

  app.get('/api/session-history/:id/raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [session, events] = await Promise.all([
      ctx.history.sessionLog(id, 0),
      ctx.history.rawSessionLogEvents(id),
    ]);
    if (!session || !events) {
      await reply.code(404).send({ message: 'session log not found' });
      return;
    }
    const body = events
      .map((event) =>
        JSON.stringify({
          sequence: event.sequence,
          recordedAt: event.recordedAt,
          elapsedMs: event.elapsedMs,
          direction: event.direction,
          encoding: 'base64',
          data: event.raw.toString('base64'),
        }),
      )
      .join('\n');
    return reply
      .type('application/x-ndjson')
      .header(
        'content-disposition',
        `attachment; filename="${exportSlug(session.title)}.muxlog"`,
      )
      .send(body ? `${body}\n` : '');
  });

  app.get('/api/session-history/:id/clean', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await ctx.history.sessionLog(id);
    if (!session) {
      await reply.code(404).send({ message: 'session log not found' });
      return;
    }
    const transcript = session.events.map((event) => event.text).join('');
    return reply
      .type('text/plain; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${exportSlug(session.title)}-clean.txt"`,
      )
      .send(transcript);
  });

  app.get('/api/session-history/:id/replay.html', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await ctx.history.sessionLog(id);
    if (!session) {
      await reply.code(404).send({ message: 'session log not found' });
      return;
    }
    return sendReplay(reply, session);
  });

  app.put('/api/session-history/:id/pin', async (req): Promise<{ updated: boolean }> => {
    const { id } = req.params as { id: string };
    const { pinned } = pinSchema.parse(req.body);
    return { updated: await ctx.history.setPinned(id, pinned) };
  });

  app.delete('/api/session-history/:id', async (req): Promise<{ deleted: boolean }> => {
    const { id } = req.params as { id: string };
    return { deleted: await ctx.history.deleteSession(id) };
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return sendError(
        reply,
        new HttpProblem(400, err.issues[0]?.message ?? 'invalid session-history request'),
      );
    }
    return sendError(reply, err);
  });
}

function sendReplay(reply: FastifyReply, session: SessionLogDetail) {
  const eventsJson = JSON.stringify(
    session.events.map((event) => ({
      t: event.elapsedMs,
      d: event.direction,
      x: event.text,
    })),
  )
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const title = escapeHtml(session.title);
  const host = escapeHtml(session.host);
  const started = escapeHtml(session.startedAt);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Muxus replay</title>
<style>
:root{color-scheme:dark;background:#0c1117;color:#d7dee7;font:14px Inter,system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column}
header{padding:14px 18px;background:#121a23;border-bottom:1px solid #293442}
h1{font-size:16px;margin:0 0 4px}.meta{color:#8fa0b3;font-size:12px}
.controls{display:flex;align-items:center;gap:10px;padding:10px 18px;background:#0f171f;border-bottom:1px solid #293442}
button,select{color:inherit;background:#1b2733;border:1px solid #3a4959;border-radius:5px;padding:6px 10px}
input[type=range]{flex:1}.time{font-variant-numeric:tabular-nums;min-width:110px;text-align:right;color:#aab8c6}
pre{flex:1;margin:0;padding:18px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.input{color:#8ec7ff}.system{color:#8391a2;font-style:italic}
</style>
</head>
<body>
<header><h1>${title}</h1><div class="meta">${host} · started ${started} · ${session.eventCount} retained events</div></header>
<div class="controls">
  <button id="play" type="button">Play</button>
  <button id="restart" type="button">Restart</button>
  <label>Speed <select id="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="5">5×</option><option value="20">20×</option></select></label>
  <input id="seek" type="range" min="0" max="0" value="0" aria-label="Replay position">
  <span class="time" id="time">00:00 / 00:00</span>
</div>
<pre id="screen" aria-live="off"></pre>
<script>
const events=${eventsJson};
const duration=events.length?events[events.length-1].t:0;
const screen=document.querySelector('#screen'),play=document.querySelector('#play'),seek=document.querySelector('#seek'),time=document.querySelector('#time'),speed=document.querySelector('#speed');
seek.max=String(duration);let position=0,index=0,running=false,last=0;
const fmt=ms=>{const s=Math.floor(ms/1000),m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
function append(e){const span=document.createElement('span');span.className=e.d;span.textContent=e.x;screen.append(span)}
function render(to){screen.textContent='';index=0;while(index<events.length&&events[index].t<=to)append(events[index++]);screen.scrollTop=screen.scrollHeight;position=to;seek.value=String(to);time.textContent=fmt(to)+' / '+fmt(duration)}
function frame(now){if(!running)return;const delta=(now-last)*Number(speed.value);last=now;position=Math.min(duration,position+delta);while(index<events.length&&events[index].t<=position)append(events[index++]);screen.scrollTop=screen.scrollHeight;seek.value=String(position);time.textContent=fmt(position)+' / '+fmt(duration);if(position>=duration){running=false;play.textContent='Play';return}requestAnimationFrame(frame)}
play.onclick=()=>{running=!running;play.textContent=running?'Pause':'Play';if(running){last=performance.now();requestAnimationFrame(frame)}};
document.querySelector('#restart').onclick=()=>{running=false;play.textContent='Play';render(0)};
seek.oninput=()=>render(Number(seek.value));render(0);
</script>
</body>
</html>`;
  return reply
    .type('text/html')
    .header(
      'content-disposition',
      `attachment; filename="${exportSlug(session.title)}-replay.html"`,
    )
    .send(html);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function exportSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'session'
  );
}

function asRouteError(err: unknown): unknown {
  if (!(err instanceof z.ZodError)) return err;
  return new HttpProblem(
    400,
    err.issues[0]?.message ?? 'invalid session-history request',
  );
}

function configuredStorageLocation(
  ctx: AppContext,
  settings: { storageLocation?: string },
): string | undefined {
  return (
    ctx.config.historyPath ??
    settings.storageLocation ??
    defaultHistoryRoot(ctx.config.databasePath)
  );
}
