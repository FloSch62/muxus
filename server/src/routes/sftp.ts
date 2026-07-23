import path from 'node:path/posix';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SFTPWrapper } from 'ssh2';
import type { SftpEntry, SftpEntryType, SftpListResponse } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { HttpProblem, sendError } from '../util/errors.js';

/** Directory-tree deletes stop after this many entries — runaway guard. */
const MAX_RECURSIVE_DELETE = 10_000;

interface ConnParams {
  connId: string;
}

/** Shape of ssh2's readdir entries (its own types are callback-tangled). */
interface SftpDirEntry {
  filename: string;
  longname: string;
  attrs: { size?: number; mtime?: number; mode: number };
}

/**
 * SFTP file operations on a live SSH connection. The connId comes from the
 * terminal's `ready` message, so the file panel shares the session's single
 * SSH connection (MobaXterm-style) instead of dialing a second one.
 */
export function registerSftpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const sftpFor = async (req: FastifyRequest): Promise<SFTPWrapper> => {
    const { connId } = req.params as ConnParams;
    const conn = ctx.connections.get(connId);
    if (!conn) throw new HttpProblem(404, 'connection not found (terminal closed?)');
    return conn.sftp();
  };

  app.get('/api/sftp/:connId/home', async (req, reply) => {
    try {
      const sftp = await sftpFor(req);
      const home = await call<string>((cb) => sftp.realpath('.', cb));
      return { path: home };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/sftp/:connId/list', async (req, reply) => {
    try {
      const sftp = await sftpFor(req);
      const dir = requirePath(req);
      const resolved = await call<string>((cb) => sftp.realpath(dir, cb));
      const listing = await call<SftpDirEntry[]>((cb) => sftp.readdir(resolved, cb));
      const entries: SftpEntry[] = listing
        .map((item) => ({
          name: item.filename,
          type: entryType(item.attrs.mode),
          size: item.attrs.size,
          mtimeMs: item.attrs.mtime ? item.attrs.mtime * 1000 : undefined,
          mode: item.attrs.mode & 0o7777,
          ...ownerFromLongname(item.longname),
        }))
        .filter((entry) => entry.name !== '.' && entry.name !== '..');
      const response: SftpListResponse = { path: resolved, entries };
      return response;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/sftp/:connId/download', async (req, reply) => {
    try {
      const sftp = await sftpFor(req);
      const file = requirePath(req);
      const stat = await call<{ size?: number }>((cb) => sftp.stat(file, cb));
      const stream = sftp.createReadStream(file);
      // A read error after headers are out can only abort the transfer; the
      // client sees a truncated download rather than a JSON error.
      stream.on('error', () => reply.raw.destroy());
      void reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(path.basename(file))}"`);
      if (stat.size !== undefined) void reply.header('content-length', stat.size);
      return reply.send(stream);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/upload', async (req, reply) => {
    try {
      const sftp = await sftpFor(req);
      const file = requirePath(req);
      const body = req.body;
      if (!body || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
        throw new HttpProblem(400, 'expected an application/octet-stream body');
      }
      await new Promise<void>((resolve, reject) => {
        const out = sftp.createWriteStream(file);
        out.on('error', reject);
        out.on('close', resolve);
        (body as NodeJS.ReadableStream).on('error', reject);
        (body as NodeJS.ReadableStream).pipe(out);
      });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/mkdir', async (req, reply) => {
    try {
      const sftp = await sftpFor(req);
      await call<void>((cb) => sftp.mkdir(requirePath(req), cb));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/rename', async (req, reply) => {
    try {
      const sftp = await sftpFor(req);
      const { from, to } = (req.body ?? {}) as { from?: string; to?: string };
      if (!from || !to) throw new HttpProblem(400, 'from and to are required');
      await call<void>((cb) => sftp.rename(from, to, cb));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/delete', async (req, reply) => {
    try {
      const sftp = await sftpFor(req);
      const target = requirePath(req);
      const stat = await call<{ isDirectory(): boolean }>((cb) => sftp.lstat(target, cb));
      if (stat.isDirectory()) {
        const budget = { remaining: MAX_RECURSIVE_DELETE };
        await deleteTree(sftp, target, budget);
      } else {
        await call<void>((cb) => sftp.unlink(target, cb));
      }
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function requirePath(req: FastifyRequest): string {
  const fromQuery = (req.query as { path?: string }).path;
  const fromBody = ((req.body ?? {}) as { path?: string }).path;
  const p = fromQuery ?? fromBody;
  if (!p) throw new HttpProblem(400, 'path is required');
  return p;
}

async function deleteTree(sftp: SFTPWrapper, dir: string, budget: { remaining: number }): Promise<void> {
  const listing = await call<SftpDirEntry[]>((cb) => sftp.readdir(dir, cb));
  for (const item of listing) {
    if (item.filename === '.' || item.filename === '..') continue;
    if (--budget.remaining < 0) throw new HttpProblem(400, `refusing to delete more than ${MAX_RECURSIVE_DELETE} entries`);
    const child = path.join(dir, item.filename);
    if (entryType(item.attrs.mode) === 'dir') await deleteTree(sftp, child, budget);
    else await call<void>((cb) => sftp.unlink(child, cb));
  }
  await call<void>((cb) => sftp.rmdir(dir, cb));
}

function entryType(mode: number): SftpEntryType {
  const fmt = mode & 0o170000;
  if (fmt === 0o040000) return 'dir';
  if (fmt === 0o100000) return 'file';
  if (fmt === 0o120000) return 'link';
  return 'other';
}

/** "drwxr-xr-x  2 alice staff 4096 …" → owner/group display hints. */
function ownerFromLongname(longname: string): { owner?: string; group?: string } {
  const fields = longname.trim().split(/\s+/);
  return fields.length >= 4 ? { owner: fields[2], group: fields[3] } : {};
}

// Typing helper: ssh2's callback style, promisified per call site.
function call<T>(fn: (cb: (err: Error | undefined | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));
}
