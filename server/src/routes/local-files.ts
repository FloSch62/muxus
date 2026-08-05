import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  EditorFileResponse,
  EditorFileSaveRequest,
  EditorFileSaveResponse,
} from '@muxus/shared';
import { HttpProblem, sendError } from '../util/errors.js';

const MAX_EDITOR_BYTES = 8 * 1024 * 1024;

/** Authenticated text editing for files visible to a local terminal session. */
export function registerLocalFileRoutes(app: FastifyInstance): void {
  app.get('/api/local-files/file', async (req, reply) => {
    try {
      const file = requireAbsolutePath(req);
      const response: EditorFileResponse = await readLocalTextFile(file);
      return response;
    } catch (error) {
      return sendError(reply, localFileError(error));
    }
  });

  app.put(
    '/api/local-files/file',
    { bodyLimit: MAX_EDITOR_BYTES + 64 * 1024 },
    async (req, reply) => {
      try {
        const file = requireAbsolutePath(req);
        const body = (req.body ?? {}) as Partial<EditorFileSaveRequest>;
        if (typeof body.content !== 'string') {
          throw new HttpProblem(400, 'content must be a string');
        }
        const bytes = Buffer.from(body.content, 'utf8');
        if (bytes.length > MAX_EDITOR_BYTES) {
          throw new HttpProblem(
            413,
            `files larger than ${formatBytes(MAX_EDITOR_BYTES)} cannot be saved from the editor`,
          );
        }

        const current = await lstat(file);
        requireRegularFile(current);
        if (
          !body.force &&
          body.expectedMtimeMs !== undefined &&
          current.mtimeMs !== body.expectedMtimeMs
        ) {
          throw new HttpProblem(
            409,
            'the local file changed since it was opened',
            'LOCAL_FILE_CHANGED',
          );
        }

        await atomicLocalTextSave(file, bytes, current.mode);
        const saved = await stat(file);
        const response: EditorFileSaveResponse = {
          ok: true,
          size: saved.size,
          mtimeMs: saved.mtimeMs,
        };
        return response;
      } catch (error) {
        return sendError(reply, localFileError(error));
      }
    },
  );
}

async function readLocalTextFile(file: string): Promise<EditorFileResponse> {
  const initial = await lstat(file);
  requireRegularFile(initial);
  if (initial.size > MAX_EDITOR_BYTES) {
    throw new HttpProblem(
      413,
      `files larger than ${formatBytes(MAX_EDITOR_BYTES)} cannot be opened in the editor`,
    );
  }

  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    requireRegularFile(opened);
    const buffer = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const afterRead = await handle.stat();
    if (total !== opened.size || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
      throw new HttpProblem(409, 'the local file changed while it was being opened');
    }
    const bytes = buffer.subarray(0, total);
    if (bytes.includes(0)) {
      throw new HttpProblem(415, 'this appears to be a binary file and cannot be opened as text');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HttpProblem(415, 'the file editor currently supports UTF-8 text files');
    }
    return {
      path: file,
      content,
      size: total,
      mtimeMs: opened.mtimeMs,
      mode: opened.mode & 0o7777,
    };
  } finally {
    await handle.close();
  }
}

function requireRegularFile(attributes: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): void {
  if (attributes.isDirectory()) throw new HttpProblem(400, 'cannot edit a directory');
  if (attributes.isSymbolicLink()) {
    throw new HttpProblem(
      409,
      'open the symbolic link target explicitly',
      'LOCAL_EDITOR_SYMLINK',
    );
  }
  if (!attributes.isFile()) {
    throw new HttpProblem(415, 'only regular files can be opened in the editor');
  }
}

async function atomicLocalTextSave(file: string, bytes: Buffer, mode: number): Promise<void> {
  const temporary = `${file}.muxus-${randomBytes(6).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', mode & 0o7777);
    await handle.writeFile(bytes);
    // open() applies the process umask even when a mode is supplied. Restore
    // the original file's permissions before the temporary file is published.
    await handle.chmod(mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function requireAbsolutePath(req: FastifyRequest): string {
  const value = (req.query as { path?: unknown }).path;
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new HttpProblem(400, 'path is required');
  }
  if (!path.isAbsolute(value)) throw new HttpProblem(400, 'path must be absolute');
  return path.normalize(value);
}

function localFileError(error: unknown): unknown {
  if (error instanceof HttpProblem) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new HttpProblem(404, 'local file not found');
  if (code === 'EACCES' || code === 'EPERM') {
    return new HttpProblem(403, 'permission denied while accessing the local file');
  }
  if (code === 'ELOOP') {
    return new HttpProblem(409, 'open the symbolic link target explicitly', 'LOCAL_EDITOR_SYMLINK');
  }
  return error;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
