import path from 'node:path/posix';
import { pipeline } from 'node:stream/promises';
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

interface SftpAttrs {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * SFTP file operations on a live SSH connection. The connId comes from the
 * terminal's `ready` message, so the file panel shares the session's single
 * SSH connection (MobaXterm-style) instead of dialing a second one.
 */
export function registerSftpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const acquireSftp = async (req: FastifyRequest) => {
    const { connId } = req.params as ConnParams;
    const lease = ctx.connections.acquire(connId, 'sftp');
    if (!lease) throw new HttpProblem(404, 'connection not found');
    try {
      return { sftp: await lease.connection.sftp(), release: () => lease.release() };
    } catch (err) {
      lease.release();
      throw err;
    }
  };

  const withSftp = async <T>(
    req: FastifyRequest,
    operation: (sftp: SFTPWrapper) => Promise<T> | T,
  ): Promise<T> => {
    const lease = await acquireSftp(req);
    try {
      return await operation(lease.sftp);
    } finally {
      lease.release();
    }
  };

  app.get('/api/sftp/:connId/home', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const home = await call<string>((cb) => sftp.realpath('.', cb));
        return { path: home };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/sftp/:connId/list', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
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
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/sftp/:connId/download', async (req, reply) => {
    let releaseLease: (() => void) | undefined;
    try {
      const lease = await acquireSftp(req);
      releaseLease = once(lease.release);
      const file = requirePath(req);
      const stat = await call<{ size?: number }>((cb) => lease.sftp.stat(file, cb));
      const stream = lease.sftp.createReadStream(file);
      // Streaming outlives the route handler. Keep the SFTP lease until the
      // remote stream or HTTP response closes so a closed terminal tab cannot
      // tear the shared transport out from under an active download.
      stream.once('close', releaseLease);
      reply.raw.once('close', releaseLease);
      // A read error after headers are out can only abort the transfer; the
      // client sees a truncated download rather than a JSON error.
      stream.once('error', () => reply.raw.destroy());
      void reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(path.basename(file))}"`);
      if (stat.size !== undefined) void reply.header('content-length', stat.size);
      return reply.send(stream);
    } catch (err) {
      releaseLease?.();
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/upload', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const file = requirePath(req);
        const overwrite = requireOverwrite(req);
        const body = req.body;
        if (!body || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
          throw new HttpProblem(400, 'expected an application/octet-stream body');
        }

        const existing = await lstatIfPresent(sftp, file);
        if (existing?.isDirectory()) {
          throw new HttpProblem(409, 'a directory already exists at the upload destination', 'SFTP_DESTINATION_IS_DIRECTORY');
        }
        if (existing?.isSymbolicLink()) {
          throw new HttpProblem(409, 'refusing to overwrite a symbolic link', 'SFTP_DESTINATION_IS_SYMLINK');
        }
        if (existing && !overwrite) {
          throw new HttpProblem(409, 'a file already exists at the upload destination', 'SFTP_DESTINATION_EXISTS');
        }

        try {
          await streamUpload(sftp, file, body as NodeJS.ReadableStream, overwrite);
        } catch (err) {
          // A different client may have created the destination after our
          // preflight. Exclusive-create still protects it; turn that race into
          // the same actionable conflict response instead of a generic 500.
          if (!overwrite && (await lstatIfPresent(sftp, file))) {
            throw new HttpProblem(409, 'a file already exists at the upload destination', 'SFTP_DESTINATION_EXISTS');
          }
          throw err;
        }
        return { ok: true };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/mkdir', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        await call<void>((cb) => sftp.mkdir(requirePath(req), cb));
        return { ok: true };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/rename', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const { from, to } = (req.body ?? {}) as { from?: string; to?: string };
        if (!from || !to) throw new HttpProblem(400, 'from and to are required');
        await call<void>((cb) => sftp.rename(from, to, cb));
        return { ok: true };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/delete', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const target = requirePath(req);
        const stat = await call<{ isDirectory(): boolean }>((cb) => sftp.lstat(target, cb));
        if (stat.isDirectory()) {
          const budget = { remaining: MAX_RECURSIVE_DELETE };
          await deleteTree(sftp, target, budget);
        } else {
          await call<void>((cb) => sftp.unlink(target, cb));
        }
        return { ok: true };
      });
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

function requireOverwrite(req: FastifyRequest): boolean {
  const value = (req.query as { overwrite?: unknown }).overwrite;
  if (value === undefined || value === 'false' || value === false) return false;
  if (value === 'true' || value === true) return true;
  throw new HttpProblem(400, 'overwrite must be true or false');
}

async function lstatIfPresent(sftp: SFTPWrapper, file: string): Promise<SftpAttrs | undefined> {
  try {
    return await call<SftpAttrs>((cb) => sftp.lstat(file, cb));
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === 2 || code === 'ENOENT') return undefined;
    throw err;
  }
}

async function streamUpload(
  sftp: SFTPWrapper,
  file: string,
  body: NodeJS.ReadableStream,
  overwrite: boolean,
): Promise<void> {
  // Exclusive create is the authoritative no-overwrite guard. The lstat
  // above exists for a useful 409 response, not for correctness. pipeline()
  // propagates request cancellation and tears down both sides on failure.
  const out = sftp.createWriteStream(file, { flags: overwrite ? 'w' : 'wx' });
  await pipeline(body, out);
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

function once(operation: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    operation();
  };
}
