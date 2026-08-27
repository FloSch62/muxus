import path from 'node:path/posix';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SFTPWrapper } from 'ssh2';
import type {
  SftpEntry,
  SftpEntryType,
  SftpFileResponse,
  SftpFileSaveRequest,
  SftpFileSaveResponse,
  SftpListResponse,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import { HttpProblem, sendError } from '../util/errors.js';

/** Directory-tree deletes stop after this many entries — runaway guard. */
const MAX_RECURSIVE_DELETE = 10_000;
/** Monaco is a text editor, not a way to accidentally buffer huge remote artifacts. */
const MAX_EDITOR_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TICKET_TTL_MS = 2 * 60 * 1000;
const CLIPBOARD_IMAGE_MODE = 0o600;
const CLIPBOARD_IMAGE_TEMP_DIR = '/tmp';

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
  size?: number;
  mtime?: number;
  mode?: number;
}

/**
 * SFTP file operations on a live SSH connection. The connId comes from the
 * terminal's `ready` message, so the file panel shares the session's single
 * SSH connection (MobaXterm-style) instead of dialing a second one.
 */
export function registerSftpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const downloadTickets = new Map<
    string,
    { connId: string; path: string; expiresAt: number }
  >();
  const issueDownloadTicket = (connId: string, file: string): string => {
    const now = Date.now();
    for (const [ticket, value] of downloadTickets) {
      if (value.expiresAt <= now) downloadTickets.delete(ticket);
    }
    const ticket = randomBytes(18).toString('base64url');
    downloadTickets.set(ticket, {
      connId,
      path: file,
      expiresAt: now + DOWNLOAD_TICKET_TTL_MS,
    });
    return ticket;
  };

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

  // Kept for API compatibility; the client now resolves "." through /list so
  // its initial directory load only needs one round trip.
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
        const { connId } = req.params as ConnParams;
        const entries: SftpEntry[] = listing
          .map((item) => ({
            name: item.filename,
            type: entryType(item.attrs.mode),
            size: item.attrs.size,
            mtimeMs: item.attrs.mtime ? item.attrs.mtime * 1000 : undefined,
            mode: item.attrs.mode & 0o7777,
            ...ownerFromLongname(item.longname),
            ...(entryType(item.attrs.mode) === 'file'
              ? { downloadTicket: issueDownloadTicket(connId, path.join(resolved, item.filename)) }
              : {}),
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

  app.get('/api/sftp/:connId/drag-download', async (req, reply) => {
    let releaseLease: (() => void) | undefined;
    try {
      const { connId } = req.params as ConnParams;
      const ticketValue = (req.query as { ticket?: unknown }).ticket;
      const ticket = typeof ticketValue === 'string' ? downloadTickets.get(ticketValue) : undefined;
      if (!ticket || ticket.connId !== connId || ticket.expiresAt <= Date.now()) {
        if (typeof ticketValue === 'string') downloadTickets.delete(ticketValue);
        throw new HttpProblem(401, 'download ticket is missing or expired');
      }
      const lease = await acquireSftp(req);
      releaseLease = once(lease.release);
      const stat = await call<{ size?: number }>((cb) => lease.sftp.stat(ticket.path, cb));
      const stream = lease.sftp.createReadStream(ticket.path);
      stream.once('close', releaseLease);
      reply.raw.once('close', releaseLease);
      stream.once('error', () => reply.raw.destroy());
      void reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(path.basename(ticket.path))}"`)
        .header('cache-control', 'no-store');
      if (stat.size !== undefined) void reply.header('content-length', stat.size);
      return reply.send(stream);
    } catch (err) {
      releaseLease?.();
      return sendError(reply, err);
    }
  });

  app.get('/api/sftp/:connId/file', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const file = requirePath(req);
        const attrs = await call<SftpAttrs>((cb) => sftp.lstat(file, cb));
        if (attrs.isDirectory()) throw new HttpProblem(400, 'cannot edit a directory');
        if (attrs.isSymbolicLink()) {
          throw new HttpProblem(409, 'open the symbolic link target explicitly', 'SFTP_EDITOR_SYMLINK');
        }
        if ((attrs.size ?? 0) > MAX_EDITOR_BYTES) {
          throw new HttpProblem(413, `files larger than ${formatBytes(MAX_EDITOR_BYTES)} cannot be opened in the editor`);
        }
        const bytes = await readBounded(sftp, file, MAX_EDITOR_BYTES);
        if (bytes.includes(0)) {
          throw new HttpProblem(415, 'this appears to be a binary file and cannot be opened as text');
        }
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new HttpProblem(415, 'the remote editor currently supports UTF-8 text files');
        }
        const response: SftpFileResponse = {
          path: file,
          content,
          size: bytes.length,
          mtimeMs: attrs.mtime ? attrs.mtime * 1000 : undefined,
          mode: attrs.mode === undefined ? undefined : attrs.mode & 0o7777,
        };
        return response;
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put(
    '/api/sftp/:connId/file',
    { bodyLimit: MAX_EDITOR_BYTES + 64 * 1024 },
    async (req, reply) => {
      try {
        return await withSftp(req, async (sftp) => {
          const file = requirePath(req);
          const body = (req.body ?? {}) as Partial<SftpFileSaveRequest>;
          if (typeof body.content !== 'string') throw new HttpProblem(400, 'content must be a string');
          const bytes = Buffer.from(body.content, 'utf8');
          if (bytes.length > MAX_EDITOR_BYTES) {
            throw new HttpProblem(413, `files larger than ${formatBytes(MAX_EDITOR_BYTES)} cannot be saved from the editor`);
          }

          const attrs = await call<SftpAttrs>((cb) => sftp.lstat(file, cb));
          if (attrs.isDirectory()) throw new HttpProblem(400, 'cannot overwrite a directory');
          if (attrs.isSymbolicLink()) {
            throw new HttpProblem(409, 'refusing to overwrite a symbolic link', 'SFTP_DESTINATION_IS_SYMLINK');
          }
          const currentMtimeMs = attrs.mtime ? attrs.mtime * 1000 : undefined;
          if (
            !body.force &&
            body.expectedMtimeMs !== undefined &&
            currentMtimeMs !== body.expectedMtimeMs
          ) {
            throw new HttpProblem(409, 'the remote file changed since it was opened', 'SFTP_FILE_CHANGED');
          }

          await atomicTextSave(sftp, file, bytes, attrs.mode);
          const saved = await call<SftpAttrs>((cb) => sftp.stat(file, cb));
          const response: SftpFileSaveResponse = {
            ok: true,
            size: saved.size ?? bytes.length,
            mtimeMs: saved.mtime ? saved.mtime * 1000 : undefined,
          };
          return response;
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

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
          await atomicStreamUpload(
            sftp,
            file,
            body as NodeJS.ReadableStream,
            overwrite,
            existing?.mode,
          );
        } catch (err) {
          // A different client may have created the destination while the
          // request was streaming into its temporary file. Return the same
          // actionable conflict response instead of a generic rename error.
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

  app.post('/api/sftp/:connId/clipboard-image', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const body = req.body;
        if (!body || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
          throw new HttpProblem(400, 'expected an application/octet-stream body');
        }
        const file = path.join(
          CLIPBOARD_IMAGE_TEMP_DIR,
          `muxus-paste-${Date.now()}-${randomBytes(16).toString('hex')}.png`,
        );
        await atomicStreamUpload(
          sftp,
          file,
          body as NodeJS.ReadableStream,
          false,
          CLIPBOARD_IMAGE_MODE,
        );
        return { path: file };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/sftp/:connId/mkdir', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const target = requirePath(req);
        const recursive = (req.body as { recursive?: unknown } | undefined)?.recursive === true;
        if (recursive) await mkdirRecursive(sftp, target);
        else await call<void>((cb) => sftp.mkdir(target, cb));
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

async function readBounded(sftp: SFTPWrapper, file: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = sftp.createReadStream(file);
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new HttpProblem(413, `files larger than ${formatBytes(maxBytes)} cannot be opened in the editor`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Write a complete temporary file before replacing the destination. The
 * shared commit path prefers OpenSSH's atomic POSIX rename extension.
 */
async function atomicTextSave(
  sftp: SFTPWrapper,
  file: string,
  bytes: Buffer,
  mode: number | undefined,
): Promise<void> {
  const temp = `${file}.muxus-${randomBytes(6).toString('hex')}.tmp`;
  const options = mode === undefined
    ? { flags: 'wx' as const }
    : { flags: 'wx' as const, mode: mode & 0o7777 };
  try {
    await pipeline(Readable.from(bytes), sftp.createWriteStream(temp, options));
    await commitTempFile(sftp, temp, file, true);
  } catch (error) {
    await unlinkIfPresent(sftp, temp);
    throw error;
  }
}

/**
 * Upload into a sibling temporary file. If the browser disconnects or the
 * SFTP stream fails, only that temporary file is removed; an existing
 * destination is never left truncated.
 */
async function atomicStreamUpload(
  sftp: SFTPWrapper,
  file: string,
  body: NodeJS.ReadableStream,
  overwrite: boolean,
  mode: number | undefined,
): Promise<void> {
  const temp = `${file}.muxus-${randomBytes(6).toString('hex')}.upload`;
  const options = mode === undefined
    ? { flags: 'wx' as const }
    : { flags: 'wx' as const, mode: mode & 0o7777 };
  try {
    await pipeline(body, sftp.createWriteStream(temp, options));
    await commitTempFile(sftp, temp, file, overwrite);
  } catch (error) {
    await unlinkIfPresent(sftp, temp);
    throw error;
  }
}

async function commitTempFile(
  sftp: SFTPWrapper,
  temp: string,
  destination: string,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite) {
    if (await lstatIfPresent(sftp, destination)) {
      throw new HttpProblem(409, 'a file already exists at the upload destination', 'SFTP_DESTINATION_EXISTS');
    }
    await call<void>((cb) => sftp.rename(temp, destination, cb));
    return;
  }

  try {
    await call<void>((cb) => sftp.ext_openssh_rename(temp, destination, cb));
    return;
  } catch (error) {
    if (!isUnsupportedSftpOperation(error)) throw error;
  }

  // Base SFTP v3 rename commonly refuses an existing destination. Try it
  // first for servers that replace, then use a short unlink/rename fallback.
  try {
    await call<void>((cb) => sftp.rename(temp, destination, cb));
  } catch {
    await call<void>((cb) => sftp.unlink(destination, cb));
    await call<void>((cb) => sftp.rename(temp, destination, cb));
  }
}

async function unlinkIfPresent(sftp: SFTPWrapper, file: string): Promise<void> {
  try {
    await call<void>((cb) => sftp.unlink(file, cb));
  } catch {
    /* best-effort cleanup */
  }
}

function isUnsupportedSftpOperation(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === 8 || code === 'OP_UNSUPPORTED';
}

async function mkdirRecursive(sftp: SFTPWrapper, target: string): Promise<void> {
  const normalized = path.normalize(target);
  const absolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(Boolean);
  let current = absolute ? '/' : '.';
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await call<void>((cb) => sftp.mkdir(current, cb));
    } catch (err) {
      const existing = await lstatIfPresent(sftp, current);
      if (!existing?.isDirectory() || existing.isSymbolicLink()) throw err;
    }
  }
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
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
