import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { StagedTransferFile } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { HttpProblem, sendError } from '../util/errors.js';

const MAX_NAME_LENGTH = 255;

function stagedId(req: { params: unknown }): string {
  const { id } = req.params as { id?: unknown };
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new HttpProblem(400, 'invalid file id');
  return id;
}

/**
 * Files for XMODEM, YMODEM and ZMODEM transfers travel over HTTP so the
 * terminal socket only carries the transfer's control frames: uploads are
 * staged here before a send, received files are fetched (once) after.
 */
export function registerTerminalFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/terminal-files', async (req, reply) => {
    try {
      const { name, mtimeMs } = req.query as { name?: unknown; mtimeMs?: unknown };
      if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) {
        throw new HttpProblem(400, 'a file name is required');
      }
      const body = req.body;
      if (!body || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
        throw new HttpProblem(400, 'expected an application/octet-stream body');
      }
      const modified = typeof mtimeMs === 'string' ? Number(mtimeMs) : undefined;
      const staged = await ctx.transferFiles.upload(
        name,
        body as NodeJS.ReadableStream,
        modified !== undefined && Number.isFinite(modified) && modified > 0 ? modified : undefined,
      );
      const response: StagedTransferFile = { id: staged.id, name: staged.name, size: staged.size };
      return await reply.code(201).send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/terminal-files/:id', async (req, reply) => {
    try {
      const id = stagedId(req);
      const staged = ctx.transferFiles.get(id);
      if (!staged) throw new HttpProblem(404, 'the file is no longer available');
      const stream = createReadStream(staged.path);
      stream.once('error', () => reply.raw.destroy());
      // Delivered once: a completed download frees the staged copy.
      reply.raw.once('finish', () => void ctx.transferFiles.remove(id));
      void reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(staged.name)}"`)
        .header('content-length', staged.size)
        .header('cache-control', 'no-store');
      return await reply.send(stream);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/terminal-files/:id', async (req, reply) => {
    try {
      await ctx.transferFiles.remove(stagedId(req));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
