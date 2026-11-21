import path from 'node:path/posix';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  SftpEntry,
  SftpEntryType,
  SftpFileResponse,
  SftpFileSaveRequest,
  SftpFileSaveResponse,
  SftpListResponse,
  SftpUploadResponse,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import {
  isSshError,
  SFTP_NO_SUCH_FILE,
  SFTP_OP_UNSUPPORTED,
  type SftpClient,
  type SftpStats,
} from '../ssh/engine.js';
import type { SftpConnection } from '../ssh/system-openssh.js';
import { HttpProblem, sendError } from '../util/errors.js';

/** Directory-tree deletes stop after this many entries — runaway guard. */
const MAX_RECURSIVE_DELETE = 10_000;
/** Monaco is a text editor, not a way to accidentally buffer huge remote artifacts. */
const MAX_EDITOR_BYTES = 8 * 1024 * 1024;
/** A new file's mode, less the server's umask: what `sftp put` gives a typical file. */
const NEW_FILE_MODE = 0o644;
const CLIPBOARD_IMAGE_MODE = 0o600;
const CLIPBOARD_IMAGE_TEMP_DIR = '/tmp';
/** How many bytes just before where an upload continues must match the staged file. */
const RESUME_CHECK_BYTES = 64 * 1024;

interface ConnParams {
  connId: string;
}

/**
 * SFTP file operations on a live SSH connection. The connId comes from the
 * terminal's `ready` message, so the file panel shares the session's single
 * SSH connection (MobaXterm-style) instead of dialing a second one.
 */
export function registerSftpRoutes(app: FastifyInstance, ctx: AppContext): void {
  // A listing can stay on screen long before a file is dragged out of it, and
  // a drag whose download fails leaves the file manager with an empty file.
  // So a ticket lasts as long as its connection: each remote file keeps one
  // ticket across listings, and all of them go when the connection closes.
  const downloadTickets = new Map<string, { connId: string; path: string }>();
  const ticketsByConnection = new Map<string, Map<string, string>>();
  const issueDownloadTicket = (connection: SftpConnection, file: string): string => {
    const connId = connection.id;
    let tickets = ticketsByConnection.get(connId);
    if (!tickets) {
      const issued = new Map<string, string>();
      tickets = issued;
      ticketsByConnection.set(connId, issued);
      connection.onClose(() => {
        for (const ticket of issued.values()) downloadTickets.delete(ticket);
        ticketsByConnection.delete(connId);
      });
    }
    const existing = tickets.get(file);
    if (existing) return existing;
    const ticket = randomBytes(18).toString('base64url');
    tickets.set(file, ticket);
    downloadTickets.set(ticket, { connId, path: file });
    return ticket;
  };

  const acquireSftp = async (req: FastifyRequest) => {
    const { connId } = req.params as ConnParams;
    const lease = ctx.systemOpenSsh.acquire(connId) ?? ctx.connections.acquire(connId, 'sftp');
    if (!lease) throw new HttpProblem(404, 'connection not found');
    try {
      return {
        sftp: await lease.connection.sftp(),
        connection: lease.connection,
        release: () => lease.release(),
      };
    } catch (err) {
      lease.release();
      throw err;
    }
  };

  const withSftp = async <T>(
    req: FastifyRequest,
    operation: (sftp: SftpClient, connection: SftpConnection) => Promise<T> | T,
  ): Promise<T> => {
    const lease = await acquireSftp(req);
    try {
      return await operation(lease.sftp, lease.connection);
    } finally {
      lease.release();
    }
  };

  // Kept for API compatibility; the client now resolves "." through /list so
  // its initial directory load only needs one round trip.
  app.get('/api/sftp/:connId/home', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp) => {
        const home = await sftp.realpath('.');
        return { path: home };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/sftp/:connId/list', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp, connection) => {
        const dir = requirePath(req);
        const resolved = await sftp.realpath(dir);
        const listing = await sftp.readdir(resolved);
        const entries: SftpEntry[] = listing
          .map((item) => ({
            name: item.filename,
            type: entryType(item.attrs.mode ?? 0),
            size: item.attrs.size,
            mtimeMs: item.attrs.mtime ? item.attrs.mtime * 1000 : undefined,
            mode: (item.attrs.mode ?? 0) & 0o7777,
            ...ownerFromLongname(item.longname),
            ...(entryType(item.attrs.mode ?? 0) === 'file'
              ? { downloadTicket: issueDownloadTicket(connection, path.join(resolved, item.filename)) }
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
      const stat = await lease.sftp.stat(file);
      const etag = downloadEtag(lease.connection, file, stat);
      const start = etag && stat.size !== undefined ? rangeStart(req, etag, stat.size) : 0;
      // Opened before anything is sent, so a file the user may not read is
      // answered with that error instead of a dropped connection.
      const handle = await lease.sftp.open(file, 'r');
      const stream = lease.sftp.createReadStream(handle, { start });
      // Streaming outlives the route handler. Keep the SFTP lease until the
      // remote stream or HTTP response closes so a closed terminal tab cannot
      // tear the shared transport out from under an active download.
      stream.once('close', releaseLease);
      reply.raw.once('close', releaseLease);
      // A read error after headers are out can only abort the transfer; the
      // client sees a truncated download rather than a JSON error.
      stream.once('error', () => reply.raw.destroy());
      // Last-Modified alone lets the browser cache serve a stale copy of a
      // file rewritten under the same path.
      void reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(path.basename(file))}"`)
        .header('cache-control', 'no-store');
      if (stat.size !== undefined) {
        void reply.header('content-length', stat.size - start);
        if (start > 0) void reply.code(206).header('content-range', `bytes ${start}-${stat.size - 1}/${stat.size}`);
      }
      if (etag) void reply.header('accept-ranges', 'bytes').header('etag', etag);
      // Lets a client that opens the file locally upload it back with a
      // check that nobody changed the remote file in between.
      if (stat.mtime) void reply.header('last-modified', new Date(stat.mtime * 1000).toUTCString());
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
      if (!ticket || ticket.connId !== connId) {
        throw new HttpProblem(401, 'download ticket is missing or expired');
      }
      const lease = await acquireSftp(req);
      releaseLease = once(lease.release);
      const stat = await lease.sftp.stat(ticket.path);
      const stream = lease.sftp.createReadStream(await lease.sftp.open(ticket.path, 'r'));
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
        const attrs = await sftp.lstat(file);
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

          const attrs = await sftp.lstat(file);
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
          const saved = await sftp.stat(file);
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

  // Staged uploads in progress, by connection: the same file sent twice at once
  // goes under a random name the second time instead of into the same file.
  const stagedUploads = new Set<string>();

  app.post('/api/sftp/:connId/upload', async (req, reply) => {
    try {
      return await withSftp(req, async (sftp, connection) => {
        const file = requirePath(req);
        const overwrite = requireOverwrite(req);
        const expectedMtimeMs = optionalMtime(req);
        const source = optionalSource(req);
        const body = req.body;
        if (!body || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
          throw new HttpProblem(400, 'expected an application/octet-stream body');
        }

        const existing = await lstatIfPresent(sftp, file);
        if (
          expectedMtimeMs !== undefined &&
          (existing?.mtime === undefined ? undefined : existing.mtime * 1000) !== expectedMtimeMs
        ) {
          throw new HttpProblem(409, 'the remote file changed since it was downloaded', 'SFTP_FILE_CHANGED');
        }
        if (existing?.isDirectory()) {
          throw new HttpProblem(409, 'a directory already exists at the upload destination', 'SFTP_DESTINATION_IS_DIRECTORY');
        }
        if (existing?.isSymbolicLink()) {
          throw new HttpProblem(409, 'refusing to overwrite a symbolic link', 'SFTP_DESTINATION_IS_SYMLINK');
        }
        if (existing && !overwrite) {
          throw new HttpProblem(409, 'a file already exists at the upload destination', 'SFTP_DESTINATION_EXISTS');
        }

        const staging = source && { source, key: `${connection.id}\0${file}\0${sourceKey(source)}` };
        const resumable = staging && !stagedUploads.has(staging.key) ? staging : undefined;
        if (resumable) stagedUploads.add(resumable.key);
        try {
          if (resumable) {
            await resumableUpload(sftp, file, body as NodeJS.ReadableStream, overwrite, existing?.mode, resumable.source);
          } else {
            await atomicStreamUpload(
              sftp,
              file,
              body as NodeJS.ReadableStream,
              overwrite,
              existing?.mode,
            );
          }
        } catch (err) {
          // A different client may have created the destination while the
          // request was streaming into its temporary file. Return the same
          // actionable conflict response instead of a generic rename error.
          if (!overwrite && (await lstatIfPresent(sftp, file))) {
            throw new HttpProblem(409, 'a file already exists at the upload destination', 'SFTP_DESTINATION_EXISTS');
          }
          throw err;
        } finally {
          if (resumable) stagedUploads.delete(resumable.key);
        }
        const mtimeMs = await sftp.stat(file).then(
          (saved) => (saved.mtime ? saved.mtime * 1000 : undefined),
          () => undefined,
        );
        const response: SftpUploadResponse = { ok: true, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
        return response;
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
        else await sftp.mkdir(target);
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
        await sftp.rename(from, to);
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
        const stat = await sftp.lstat(target);
        if (stat.isDirectory()) {
          const budget = { remaining: MAX_RECURSIVE_DELETE };
          await deleteTree(sftp, target, budget);
        } else {
          await sftp.unlink(target);
        }
        return { ok: true };
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

async function readBounded(sftp: SftpClient, file: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = sftp.createReadStream(await sftp.open(file, 'r'));
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
  sftp: SftpClient,
  file: string,
  bytes: Buffer,
  mode: number | undefined,
): Promise<void> {
  const temp = `${file}.muxus-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await pipeline(Readable.from(bytes), await createTempFile(sftp, temp, mode));
    await commitTempFile(sftp, temp, file, true);
  } catch (error) {
    await unlinkIfPresent(sftp, temp);
    throw error;
  }
}

/**
 * A write stream into a new temporary file. It gets `mode`, the mode of the
 * file it replaces, exactly: the server's umask narrows the mode a file is
 * opened with, so it is set again on the open file. A new file is opened with
 * NEW_FILE_MODE and keeps what the umask leaves of it.
 */
async function createTempFile(
  sftp: SftpClient,
  temp: string,
  mode: number | undefined,
): Promise<Writable> {
  if (mode === undefined) return sftp.createWriteStream(await sftp.open(temp, 'wx', NEW_FILE_MODE));
  const exact = mode & 0o7777;
  const handle = await sftp.open(temp, 'wx', exact);
  // Not every server lets a client change modes; the file is still written.
  await sftp.fchmod(handle, exact).catch(() => undefined);
  return sftp.createWriteStream(handle);
}

/**
 * Upload into a sibling temporary file. If the browser disconnects or the
 * SFTP stream fails, only that temporary file is removed; an existing
 * destination is never left truncated.
 */
async function atomicStreamUpload(
  sftp: SftpClient,
  file: string,
  body: NodeJS.ReadableStream,
  overwrite: boolean,
  mode: number | undefined,
): Promise<void> {
  const temp = `${file}.muxus-${randomBytes(6).toString('hex')}.upload`;
  try {
    await pipeline(body, await createTempFile(sftp, temp, mode));
    await commitTempFile(sftp, temp, file, overwrite);
  } catch (error) {
    await unlinkIfPresent(sftp, temp);
    throw error;
  }
}

/** The local file an upload sends, as the browser describes it. */
interface UploadSource {
  size: number;
  lastModified: number;
  /** SHA-256 of samples from the start, middle and end of the file. */
  fingerprint: string;
}

function sourceKey({ size, lastModified, fingerprint }: UploadSource): string {
  return createHash('sha256').update(`${size}:${lastModified}:${fingerprint}`).digest('hex').slice(0, 12);
}

/** What an interrupted attempt left in a staged file: open where it ends, with its last bytes. */
interface StagedPart {
  handle: Buffer;
  offset: number;
  tail: Buffer;
}

/**
 * {@link atomicStreamUpload} into a temporary file named after the local file,
 * so that the next upload of it continues one a lost connection cut short. A
 * staged file that does not match the body is never written to: the client
 * sends the file again as a new upload. Anything else under that name is
 * removed, or left alone when it cannot be, and the upload goes under a random
 * name.
 */
async function resumableUpload(
  sftp: SftpClient,
  file: string,
  body: NodeJS.ReadableStream,
  overwrite: boolean,
  mode: number | undefined,
  source: UploadSource,
): Promise<void> {
  const staged = `${file}.muxus-${sourceKey(source)}.upload`;
  const found = await lstatIfPresent(sftp, staged);
  // Only a regular file is opened: opening a FIFO or a device can block, or act on it.
  const part = found && entryType(found.mode ?? 0) === 'file'
    ? await openStaged(sftp, staged, source.size)
    : undefined;
  const temp = !found || part || (await removed(sftp, staged))
    ? staged
    : `${file}.muxus-${randomBytes(6).toString('hex')}.upload`;
  try {
    if (part) await continueUpload(sftp, temp, body, part, source.size);
    else await pipeline(body, await createTempFile(sftp, temp, mode));
    await commitTempFile(sftp, temp, file, overwrite);
  } catch (error) {
    await unlinkIfPresent(sftp, temp);
    throw error;
  }
}

/**
 * Open the staged file of an interrupted attempt, if it is a regular file no
 * larger than the upload. Its type, size and last bytes are read again through
 * the handle that is written to, whatever the name pointed to by then.
 */
async function openStaged(sftp: SftpClient, staged: string, size: number): Promise<StagedPart | undefined> {
  let handle: Buffer;
  try {
    handle = await sftp.open(staged, 'r+');
  } catch {
    return undefined;
  }
  try {
    const attrs = await sftp.fstat(handle);
    const offset = attrs.size ?? 0;
    if (entryType(attrs.mode ?? 0) === 'file' && offset > 0 && offset <= size) {
      const tail = await readRange(sftp, handle, Math.max(0, offset - RESUME_CHECK_BYTES), offset);
      if (tail) return { handle, offset, tail };
    }
  } catch {
    // Unreadable: it starts over, like anything else that cannot be continued.
  }
  await sftp.closeHandle(handle).catch(() => undefined);
  return undefined;
}

/**
 * Write what the staged file lacks. The body's bytes before that point are
 * dropped, but the last of them must equal the file's; if they differ, the rest
 * is dropped too and the client is told to send the file again as a new upload.
 */
async function continueUpload(
  sftp: SftpClient,
  temp: string,
  body: NodeJS.ReadableStream,
  { handle, offset, tail }: StagedPart,
  size: number,
): Promise<void> {
  const tailStart = offset - tail.length;
  let diverged = false;
  async function* rest(chunks: AsyncIterable<string | Buffer>) {
    let position = 0;
    for await (const chunk of chunks) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const start = position;
      position += bytes.length;
      const from = Math.max(start, tailStart);
      const to = Math.min(position, offset);
      if (from < to && !bytes.subarray(from - start, to - start).equals(tail.subarray(from - tailStart, to - tailStart))) {
        diverged = true;
      }
      if (!diverged && position > offset) yield bytes.subarray(Math.max(0, offset - start));
    }
  }
  // The handle stays this function's: it is read again once the stream is done.
  const target = sftp.createWriteStream(handle, { start: offset, autoClose: false });
  try {
    await pipeline(body, rest, target);
    // A server that wrote anywhere but where it was asked shows in the size.
    const written = await sftp.fstat(handle);
    if (diverged || written.size !== size) {
      throw new HttpProblem(409, 'the upload kept on the server does not match this file', 'SFTP_UPLOAD_MISMATCH');
    }
  } finally {
    await sftp.closeHandle(handle).catch(() => undefined);
  }
}

/** Bytes `start` to `end` of an open file, or undefined when the file ends sooner. */
async function readRange(sftp: SftpClient, handle: Buffer, start: number, end: number): Promise<Buffer | undefined> {
  const bytes = Buffer.alloc(end - start);
  for (let filled = 0; filled < bytes.length;) {
    const read = await sftp.read(handle, start + filled, bytes.length - filled);
    if (!read?.length) return undefined;
    read.copy(bytes, filled);
    filled += read.length;
  }
  return bytes;
}

/** Whether nothing is left at `file`: removed now, or never there. */
async function removed(sftp: SftpClient, file: string): Promise<boolean> {
  try {
    await sftp.unlink(file);
    return true;
  } catch (err) {
    return isNoSuchFile(err);
  }
}

async function commitTempFile(
  sftp: SftpClient,
  temp: string,
  destination: string,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite) {
    if (await lstatIfPresent(sftp, destination)) {
      throw new HttpProblem(409, 'a file already exists at the upload destination', 'SFTP_DESTINATION_EXISTS');
    }
    await sftp.rename(temp, destination);
    return;
  }

  try {
    await sftp.posixRename(temp, destination);
    return;
  } catch (error) {
    if (!isUnsupportedSftpOperation(error)) throw error;
  }

  // Base SFTP v3 rename commonly refuses an existing destination. Try it
  // first for servers that replace, then use a short unlink/rename fallback.
  try {
    await sftp.rename(temp, destination);
  } catch {
    await sftp.unlink(destination);
    await sftp.rename(temp, destination);
  }
}

async function unlinkIfPresent(sftp: SftpClient, file: string): Promise<void> {
  try {
    await sftp.unlink(file);
  } catch {
    /* best-effort cleanup */
  }
}

function isUnsupportedSftpOperation(err: unknown): boolean {
  // The engine refuses locally when the server never announced the extension
  // (servers other than OpenSSH); one that announced it can still say no.
  if (isSshError(err, 'SFTP_UNSUPPORTED')) return true;
  return isSshError(err, 'SFTP_STATUS') && err.detail === SFTP_OP_UNSUPPORTED;
}

async function mkdirRecursive(sftp: SftpClient, target: string): Promise<void> {
  const normalized = path.normalize(target);
  const absolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(Boolean);
  let current = absolute ? '/' : '.';
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await sftp.mkdir(current);
    } catch (err) {
      const existing = await lstatIfPresent(sftp, current);
      if (!existing?.isDirectory() || existing.isSymbolicLink()) throw err;
    }
  }
}

/**
 * A download's validator: the host, path, size and modification time. A
 * download continues from a byte only while all of them still match.
 */
function downloadEtag(
  connection: SftpConnection,
  file: string,
  stat: { size?: number; mtime?: number },
): string | undefined {
  if (stat.size === undefined || stat.mtime === undefined) return undefined;
  const digest = createHash('sha256')
    .update(JSON.stringify([connection.muxKey, file, stat.size, stat.mtime]))
    .digest('base64url');
  return `"${digest.slice(0, 27)}"`;
}

/** Where a download starts: `Range: bytes=N-` counts only under an `If-Range` with the current validator. */
function rangeStart(req: FastifyRequest, etag: string, size: number): number {
  if (req.headers['if-range'] !== etag) return 0;
  const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
  return start < size ? start : 0;
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

/** `expectedMtimeMs`: upload only if the remote file still has this modification time. */
function optionalMtime(req: FastifyRequest): number | undefined {
  const value = (req.query as { expectedMtimeMs?: unknown }).expectedMtimeMs;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new HttpProblem(400, 'expectedMtimeMs must be a timestamp');
  return parsed;
}

/** `size`, `lastModified` and `fingerprint` of the local file: an interrupted upload of the same file continues. */
function optionalSource(req: FastifyRequest): UploadSource | undefined {
  const { size, lastModified, fingerprint } = req.query as Record<string, unknown>;
  if (size === undefined && lastModified === undefined && fingerprint === undefined) return undefined;
  const source = { size: Number(size), lastModified: Number(lastModified), fingerprint: String(fingerprint) };
  if (
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    !Number.isSafeInteger(source.lastModified) ||
    !/^[0-9a-f]{64}$/.test(source.fingerprint)
  ) {
    throw new HttpProblem(400, 'size, lastModified and fingerprint must describe the local file');
  }
  return source;
}

function requireOverwrite(req: FastifyRequest): boolean {
  const value = (req.query as { overwrite?: unknown }).overwrite;
  if (value === undefined || value === 'false' || value === false) return false;
  if (value === 'true' || value === true) return true;
  throw new HttpProblem(400, 'overwrite must be true or false');
}

async function lstatIfPresent(sftp: SftpClient, file: string): Promise<SftpStats | undefined> {
  try {
    return await sftp.lstat(file);
  } catch (err) {
    if (isNoSuchFile(err)) return undefined;
    throw err;
  }
}

function isNoSuchFile(err: unknown): boolean {
  return isSshError(err, 'SFTP_STATUS') && err.detail === SFTP_NO_SUCH_FILE;
}

async function deleteTree(sftp: SftpClient, dir: string, budget: { remaining: number }): Promise<void> {
  const listing = await sftp.readdir(dir);
  for (const item of listing) {
    if (item.filename === '.' || item.filename === '..') continue;
    if (--budget.remaining < 0) throw new HttpProblem(400, `refusing to delete more than ${MAX_RECURSIVE_DELETE} entries`);
    const child = path.join(dir, item.filename);
    if (entryType(item.attrs.mode ?? 0) === 'dir') await deleteTree(sftp, child, budget);
    else await sftp.unlink(child);
  }
  await sftp.rmdir(dir);
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

function once(operation: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    operation();
  };
}
