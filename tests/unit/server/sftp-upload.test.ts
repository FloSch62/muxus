import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { registerSftpRoutes } from '../../../server/src/routes/sftp.js';

type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>;

interface FakeSftp {
  lstat(path: string, callback: (error: Error | null, attrs?: unknown) => void): void;
  createWriteStream(path: string, options: { flags: string; mode?: number }): Writable;
  rename?(from: string, to: string, callback: (error?: Error | null) => void): void;
  ext_openssh_rename?(from: string, to: string, callback: (error?: Error | null) => void): void;
  unlink?(path: string, callback: (error?: Error | null) => void): void;
}

function captureUploadHandler(
  sftp: FakeSftp,
  route = '/api/sftp/:connId/upload',
): RouteHandler {
  const posts = new Map<string, RouteHandler>();
  const app = {
    get: vi.fn(),
    post: (path: string, handler: RouteHandler) => posts.set(path, handler),
    put: vi.fn(),
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
  return posts.get(route)!;
}

function captureDownloadHandler(stream: PassThrough): {
  handler: RouteHandler;
  release: ReturnType<typeof vi.fn>;
} {
  const gets = new Map<string, RouteHandler>();
  const app = {
    get: (path: string, handler: RouteHandler) => gets.set(path, handler),
    post: vi.fn(),
    put: vi.fn(),
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

function captureEditorHandlers(sftp: object): { read: RouteHandler; save: RouteHandler } {
  const gets = new Map<string, RouteHandler>();
  const puts = new Map<string, RouteHandler>();
  const app = {
    get: (route: string, handler: RouteHandler) => gets.set(route, handler),
    post: vi.fn(),
    put: (route: string, _options: unknown, handler: RouteHandler) => puts.set(route, handler),
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
  return {
    read: gets.get('/api/sftp/:connId/file')!,
    save: puts.get('/api/sftp/:connId/file')!,
  };
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

  it('stages a new destination before renaming it into place', async () => {
    const chunks: Buffer[] = [];
    const createWriteStream = vi.fn((_path: string, _options: { flags: string }) =>
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
    const rename = vi.fn((_from: string, _to: string, callback: (error?: Error | null) => void) =>
      callback(null),
    );
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(Object.assign(new Error('not found'), { code: 2 })),
      createWriteStream,
      rename,
      unlink: vi.fn(),
    });

    const response = await invoke(handler, { path: '/remote/report.txt' });

    expect(response.result).toEqual({ ok: true });
    expect(createWriteStream.mock.calls[0]?.[0]).toMatch(
      /^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/,
    );
    expect(createWriteStream.mock.calls[0]?.[1]).toEqual({ flags: 'wx' });
    expect(Buffer.concat(chunks).toString()).toBe('payload');
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/),
      '/remote/report.txt',
      expect.any(Function),
    );
  });

  it('creates clipboard images with owner-only permissions', async () => {
    const createWriteStream = vi.fn(
      (_path: string, _options: { flags: string; mode?: number }) =>
        new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    );
    const rename = vi.fn(
      (_from: string, _to: string, callback: (error?: Error | null) => void) =>
        callback(null),
    );
    const handler = captureUploadHandler(
      {
        lstat: (_path, callback) =>
          callback(Object.assign(new Error('not found'), { code: 2 })),
        createWriteStream,
        rename,
        unlink: vi.fn(),
      },
      '/api/sftp/:connId/clipboard-image',
    );

    const response = await invoke(handler, {});

    expect(response.result).toEqual({
      path: expect.stringMatching(/^\/tmp\/muxus-paste-\d+-[a-f0-9]+\.png$/),
    });
    if (
      !response.result ||
      typeof response.result !== 'object' ||
      !('path' in response.result) ||
      typeof response.result.path !== 'string'
    ) {
      throw new Error('clipboard image route did not return a path');
    }
    const remotePath = response.result.path;
    expect(createWriteStream.mock.calls[0]?.[0]).toMatch(
      new RegExp(`^${remotePath.replaceAll('.', '\\.')}\\.muxus-[a-f0-9]+\\.upload$`),
    );
    expect(createWriteStream.mock.calls[0]?.[1]).toEqual({ flags: 'wx', mode: 0o600 });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/\.muxus-[a-f0-9]+\.upload$/),
      remotePath,
      expect.any(Function),
    );
  });

  it('atomically replaces an existing regular file after explicit overwrite consent', async () => {
    const createWriteStream = vi.fn((_path: string, _options: { flags: string }) => new Writable({ write: (_c, _e, cb) => cb() }));
    const atomicRename = vi.fn(
      (_from: string, _to: string, callback: (error?: Error | null) => void) => callback(null),
    );
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(null, regularFile),
      createWriteStream,
      ext_openssh_rename: atomicRename,
      unlink: vi.fn(),
    });

    const response = await invoke(handler, { path: '/remote/report.txt', overwrite: 'true' });

    expect(response.result).toEqual({ ok: true });
    expect(createWriteStream.mock.calls[0]?.[0]).toMatch(
      /^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/,
    );
    expect(createWriteStream.mock.calls[0]?.[1]).toEqual({ flags: 'wx' });
    expect(atomicRename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/),
      '/remote/report.txt',
      expect.any(Function),
    );
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

  it('removes the staged file when an upload is interrupted', async () => {
    const interrupted = new Error('request aborted');
    const body = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(interrupted);
      },
    });
    const unlink = vi.fn((_path: string, callback: (error?: Error | null) => void) => callback(null));
    const rename = vi.fn();
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(Object.assign(new Error('not found'), { code: 2 })),
      createWriteStream: () => new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      rename,
      unlink,
    });
    const reply = {
      code() {
        return this;
      },
      send: vi.fn(),
    };

    await handler(
      {
        params: { connId: 'connection-1' },
        query: { path: '/remote/report.txt' },
        body,
      },
      reply,
    );

    expect(unlink).toHaveBeenCalledWith(
      expect.stringMatching(/^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/),
      expect.any(Function),
    );
    expect(rename).not.toHaveBeenCalled();
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

describe('SFTP remote editor', () => {
  it('reads bounded UTF-8 text with its optimistic concurrency metadata', async () => {
    const { read } = captureEditorHandlers({
      lstat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
        callback(null, {
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: 12,
          mtime: 123,
          mode: 0o100640,
        }),
      createReadStream: () => Readable.from([Buffer.from('hello remote')]),
    });

    const response = await invoke(read, { path: '/etc/example.conf' });

    expect(response.result).toEqual({
      path: '/etc/example.conf',
      content: 'hello remote',
      size: 12,
      mtimeMs: 123_000,
      mode: 0o640,
    });
  });

  it('rejects a save when the remote file changed', async () => {
    const createWriteStream = vi.fn();
    const { save } = captureEditorHandlers({
      lstat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
        callback(null, {
          isDirectory: () => false,
          isSymbolicLink: () => false,
          mtime: 124,
          mode: 0o100640,
        }),
      createWriteStream,
    });
    const response: { status?: number; body?: unknown } = {};
    const reply = {
      code(status: number) {
        response.status = status;
        return this;
      },
      send(body: unknown) {
        response.body = body;
      },
    };

    await save(
      {
        params: { connId: 'connection-1' },
        query: { path: '/etc/example.conf' },
        body: { content: 'new value', expectedMtimeMs: 123_000 },
      },
      reply,
    );

    expect(response).toEqual({
      status: 409,
      body: {
        message: 'the remote file changed since it was opened',
        code: 'SFTP_FILE_CHANGED',
      },
    });
    expect(createWriteStream).not.toHaveBeenCalled();
  });

  it('atomically replaces the remote text when the version still matches', async () => {
    const written: Buffer[] = [];
    const createWriteStream = vi.fn(
      (_path: string, _options: { flags: string; mode?: number }) =>
        new Writable({
          write(chunk, _encoding, callback) {
            written.push(Buffer.from(chunk));
            callback();
          },
        }),
    );
    const rename = vi.fn(
      (_from: string, _to: string, callback: (error?: Error | null) => void) => callback(null),
    );
    const { save } = captureEditorHandlers({
      lstat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
        callback(null, {
          isDirectory: () => false,
          isSymbolicLink: () => false,
          mtime: 123,
          mode: 0o100640,
        }),
      stat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
        callback(null, { size: 9, mtime: 125 }),
      createWriteStream,
      ext_openssh_rename: rename,
      unlink: vi.fn(),
    });

    const response = await save(
      {
        params: { connId: 'connection-1' },
        query: { path: '/etc/example.conf' },
        body: { content: 'new value', expectedMtimeMs: 123_000 },
      },
      {},
    );

    expect(response).toEqual({ ok: true, size: 9, mtimeMs: 125_000 });
    expect(Buffer.concat(written).toString()).toBe('new value');
    expect(createWriteStream.mock.calls[0]?.[0]).toMatch(/^\/etc\/example\.conf\.muxus-[a-f0-9]+\.tmp$/);
    expect(createWriteStream.mock.calls[0]?.[1]).toEqual({ flags: 'wx', mode: 0o640 });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/etc\/example\.conf\.muxus-[a-f0-9]+\.tmp$/),
      '/etc/example.conf',
      expect.any(Function),
    );
  });
});
