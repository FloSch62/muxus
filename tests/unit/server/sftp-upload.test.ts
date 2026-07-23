import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { registerSftpRoutes } from '../../../server/src/routes/sftp.js';

type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>;

interface FakeSftp {
  lstat(path: string, callback: (error: Error | null, attrs?: unknown) => void): void;
  createWriteStream(path: string, options: { flags: string }): Writable;
}

function captureUploadHandler(sftp: FakeSftp): RouteHandler {
  const posts = new Map<string, RouteHandler>();
  const app = {
    get: vi.fn(),
    post: (path: string, handler: RouteHandler) => posts.set(path, handler),
  };
  const ctx = {
    connections: {
      acquire: () => ({
        connection: { sftp: async () => sftp },
        owner: 'sftp',
        release: vi.fn(),
      }),
    },
  };
  registerSftpRoutes(app as never, ctx as never);
  return posts.get('/api/sftp/:connId/upload')!;
}

function captureDownloadHandler(stream: PassThrough): {
  handler: RouteHandler;
  release: ReturnType<typeof vi.fn>;
} {
  const gets = new Map<string, RouteHandler>();
  const app = {
    get: (path: string, handler: RouteHandler) => gets.set(path, handler),
    post: vi.fn(),
  };
  const release = vi.fn();
  const ctx = {
    connections: {
      acquire: () => ({
        connection: {
          sftp: async () => ({
            stat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
              callback(null, { size: 7 }),
            createReadStream: () => stream,
          }),
        },
        owner: 'sftp',
        release,
      }),
    },
  };
  registerSftpRoutes(app as never, ctx as never);
  return { handler: gets.get('/api/sftp/:connId/download')!, release };
}

async function invoke(
  handler: RouteHandler,
  query: Record<string, unknown>,
): Promise<{ result: unknown; status?: number; body?: unknown }> {
  const response: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      response.status = status;
      return this;
    },
    async send(body: unknown) {
      response.body = body;
    },
  };
  const result = await handler(
    {
      params: { connId: 'connection-1' },
      query,
      body: Readable.from([Buffer.from('payload')]),
    },
    reply,
  );
  return { result, ...response };
}

const regularFile = {
  isDirectory: () => false,
  isSymbolicLink: () => false,
};

describe('SFTP upload overwrite policy', () => {
  it('returns a conflict without opening an existing destination', async () => {
    const createWriteStream = vi.fn();
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(null, regularFile),
      createWriteStream,
    });

    const response = await invoke(handler, { path: '/remote/report.txt' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: 'a file already exists at the upload destination',
      code: 'SFTP_DESTINATION_EXISTS',
    });
    expect(createWriteStream).not.toHaveBeenCalled();
  });

  it('uses exclusive create for a new destination', async () => {
    const chunks: Buffer[] = [];
    const createWriteStream = vi.fn((_path: string, _options: { flags: string }) =>
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(Object.assign(new Error('not found'), { code: 2 })),
      createWriteStream,
    });

    const response = await invoke(handler, { path: '/remote/report.txt' });

    expect(response.result).toEqual({ ok: true });
    expect(createWriteStream).toHaveBeenCalledWith('/remote/report.txt', { flags: 'wx' });
    expect(Buffer.concat(chunks).toString()).toBe('payload');
  });

  it('only opens an existing regular file after explicit overwrite consent', async () => {
    const createWriteStream = vi.fn((_path: string, _options: { flags: string }) => new Writable({ write: (_c, _e, cb) => cb() }));
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(null, regularFile),
      createWriteStream,
    });

    const response = await invoke(handler, { path: '/remote/report.txt', overwrite: 'true' });

    expect(response.result).toEqual({ ok: true });
    expect(createWriteStream).toHaveBeenCalledWith('/remote/report.txt', { flags: 'w' });
  });

  it('refuses to follow a destination symlink even with overwrite consent', async () => {
    const createWriteStream = vi.fn();
    const handler = captureUploadHandler({
      lstat: (_path, callback) =>
        callback(null, {
          isDirectory: () => false,
          isSymbolicLink: () => true,
        }),
      createWriteStream,
    });

    const response = await invoke(handler, { path: '/remote/report.txt', overwrite: 'true' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: 'refusing to overwrite a symbolic link',
      code: 'SFTP_DESTINATION_IS_SYMLINK',
    });
    expect(createWriteStream).not.toHaveBeenCalled();
  });
});

describe('SFTP download transport ownership', () => {
  it('holds its connection lease until the stream or HTTP response closes', async () => {
    const stream = new PassThrough();
    const { handler, release } = captureDownloadHandler(stream);
    const raw = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    raw.destroy = vi.fn(() => raw.emit('close'));
    const headers = new Map<string, unknown>();
    const reply = {
      raw,
      header(name: string, value: unknown) {
        headers.set(name, value);
        return this;
      },
      send(value: unknown) {
        return value;
      },
    };

    const result = await handler(
      {
        params: { connId: 'connection-1' },
        query: { path: '/remote/report.txt' },
      },
      reply,
    );

    expect(result).toBe(stream);
    expect(headers.get('content-length')).toBe(7);
    expect(release).not.toHaveBeenCalled();

    raw.emit('close');
    expect(release).toHaveBeenCalledOnce();

    stream.destroy();
    expect(release).toHaveBeenCalledOnce();
  });
});
