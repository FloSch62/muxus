import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSftpRoutes } from '../../../server/src/routes/sftp.js';

type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>;

interface FakeSftp {
  lstat(path: string, callback: (error: Error | null, attrs?: unknown) => void): void;
  createWriteStream(path: string, options: { flags: string; mode?: number }): Writable;
  rename?(from: string, to: string, callback: (error?: Error | null) => void): void;
  ext_openssh_rename?(from: string, to: string, callback: (error?: Error | null) => void): void;
  unlink?(path: string, callback: (error?: Error | null) => void): void;
  stat?(path: string, callback: (error: Error | null, attrs?: unknown) => void): void;
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
    systemOpenSsh: { acquire: () => undefined },
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
    systemOpenSsh: { acquire: () => undefined },
    connections: {
      acquire: () => ({
        connection: {
          sftp: async () => ({
            stat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
              callback(null, { size: 7, mtime: 1_760_000_000 }),
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
    systemOpenSsh: { acquire: () => undefined },
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

  it('replaces a file only while it keeps the modification time the client downloaded', async () => {
    const createWriteStream = vi.fn((_path: string, _options: { flags: string }) => new Writable({ write: (_c, _e, cb) => cb() }));
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(null, { ...regularFile, mtime: 1_700_000_000 }),
      stat: (_path, callback) => callback(null, { ...regularFile, mtime: 1_700_000_050 }),
      createWriteStream,
      ext_openssh_rename: (_from, _to, callback) => callback(null),
      unlink: vi.fn(),
    });

    const stale = await invoke(handler, {
      path: '/remote/plan.drawio',
      overwrite: 'true',
      expectedMtimeMs: '1699999999000',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      message: 'the remote file changed since it was downloaded',
      code: 'SFTP_FILE_CHANGED',
    });
    expect(createWriteStream).not.toHaveBeenCalled();

    const current = await invoke(handler, {
      path: '/remote/plan.drawio',
      overwrite: 'true',
      expectedMtimeMs: '1700000000000',
    });
    expect(current.result).toEqual({ ok: true, mtimeMs: 1_700_000_050_000 });
    expect(createWriteStream).toHaveBeenCalledOnce();
  });

  it('treats a removed remote file as changed when a version was expected', async () => {
    const createWriteStream = vi.fn();
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(Object.assign(new Error('not found'), { code: 2 })),
      createWriteStream,
    });

    const response = await invoke(handler, {
      path: '/remote/plan.drawio',
      overwrite: 'true',
      expectedMtimeMs: '1700000000000',
    });

    expect(response.status).toBe(409);
    expect(createWriteStream).not.toHaveBeenCalled();
    expect((await invoke(handler, { path: '/remote/plan.drawio', expectedMtimeMs: 'soon' })).status).toBe(400);
  });

  it('replaces a file on servers without the posix-rename extension', async () => {
    const unlink = vi.fn((_path: string, callback: (error?: Error | null) => void) => callback(null));
    let renamed = 0;
    const rename = vi.fn((_from: string, _to: string, callback: (error?: Error | null) => void) =>
      // Plain SFTP v3 rename refuses an existing destination.
      renamed++ === 0 ? callback(new Error('Failure')) : callback(null),
    );
    const handler = captureUploadHandler({
      lstat: (_path, callback) => callback(null, regularFile),
      createWriteStream: () => new Writable({ write: (_c, _e, cb) => cb() }),
      ext_openssh_rename: () => {
        throw new Error('Server does not support this extended request');
      },
      rename,
      unlink,
    });

    const response = await invoke(handler, { path: '/remote/report.txt', overwrite: 'true' });

    expect(response.result).toEqual({ ok: true });
    expect(unlink).toHaveBeenCalledWith('/remote/report.txt', expect.any(Function));
    expect(rename).toHaveBeenCalledTimes(2);
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

/**
 * An SFTP server in memory with what staged uploads use: files and symbolic
 * links by path, files opened by handle. `truncateOnOpen` empties a file opened
 * for writing, as hack/demo-env.mjs does; `stuck` entries belong to someone
 * else, who neither lets them be opened nor removed.
 */
function memorySftp(
  options: { truncateOnOpen?: boolean; stuck?: string[]; failWrites?: boolean; fifos?: string[] } = {},
) {
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  const fifos = new Set(options.fifos);
  const handles = new Map<string, string>();
  const writes: Array<{ path: string; start: number; bytes: number }> = [];
  const opens: Array<{ path: string; handle: string }> = [];
  const closes: string[] = [];
  const noSuchFile = () => Object.assign(new Error('No such file'), { code: 2 });
  const denied = () => Object.assign(new Error('Permission denied'), { code: 3 });
  const attrs = (bytes: Buffer) => ({ ...regularFile, size: bytes.length, mode: 0o100644 });
  const opened = (handle: Buffer) => handles.get(handle.toString())!;
  const sftp = {
    lstat(file: string, callback: (error: Error | null, attrs?: unknown) => void) {
      const bytes = files.get(file);
      if (links.has(file)) callback(null, { isDirectory: () => false, isSymbolicLink: () => true, mode: 0o120777 });
      else if (fifos.has(file)) callback(null, { isDirectory: () => false, isSymbolicLink: () => false, mode: 0o010644 });
      else if (bytes) callback(null, attrs(bytes));
      else callback(noSuchFile());
    },
    open(file: string, _flags: string, callback: (error: Error | null, handle?: Buffer) => void) {
      if (options.stuck?.includes(file)) return callback(denied());
      if (fifos.has(file)) throw new Error('a FIFO was opened');
      const target = links.get(file) ?? file;
      if (!files.has(target)) return callback(noSuchFile());
      if (options.truncateOnOpen) files.set(target, Buffer.alloc(0));
      const handle = Buffer.from(`handle-${opens.length}`);
      handles.set(handle.toString(), target);
      opens.push({ path: file, handle: handle.toString() });
      callback(null, handle);
    },
    fstat(handle: Buffer, callback: (error: Error | null, attrs?: unknown) => void) {
      callback(null, attrs(files.get(opened(handle))!));
    },
    read(
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      callback: (error: Error | undefined, bytesRead: number) => void,
    ) {
      callback(undefined, files.get(opened(handle))!.copy(buffer, offset, position, position + length));
    },
    close(handle: Buffer, callback: (error?: Error | null) => void) {
      closes.push(handle.toString());
      handles.delete(handle.toString());
      callback(null);
    },
    unlink(file: string, callback: (error?: Error | null) => void) {
      if (options.stuck?.includes(file)) return callback(denied());
      if (!links.delete(file) && !fifos.delete(file) && !files.delete(file)) return callback(noSuchFile());
      callback(null);
    },
    rename(from: string, to: string, callback: (error?: Error | null) => void) {
      const bytes = files.get(from);
      if (!bytes) return callback(noSuchFile());
      files.delete(from);
      files.set(to, bytes);
      callback(null);
    },
    createWriteStream(file: string, streamOptions: { flags?: string; start?: number; handle?: Buffer }) {
      const target = streamOptions.handle ? opened(streamOptions.handle) : file;
      if (!streamOptions.handle) {
        if (files.has(file) || links.has(file) || fifos.has(file)) throw new Error('Failure');
        files.set(file, Buffer.alloc(0));
      }
      let position = streamOptions.start ?? 0;
      const write = { path: file, start: position, bytes: 0 };
      writes.push(write);
      return new Writable({
        // As in ssh2: a finished stream keeps its handle, a destroyed one closes it.
        autoDestroy: false,
        write(chunk: Buffer, _encoding, callback) {
          if (options.failWrites) return callback(Object.assign(new Error('Failure'), { code: 4 }));
          const current = files.get(target)!;
          const grown = Buffer.alloc(Math.max(current.length, position + chunk.length));
          current.copy(grown);
          chunk.copy(grown, position);
          files.set(target, grown);
          position += chunk.length;
          write.bytes += chunk.length;
          callback();
        },
        destroy(error, callback) {
          if (streamOptions.handle) sftp.close(streamOptions.handle, () => callback(error));
          else callback(error);
        },
      });
    },
  };
  return { sftp, files, links, writes, opens, closes };
}

/** An upload of `body` in 64 KiB chunks, as a browser's request arrives. */
async function upload(handler: RouteHandler, query: Record<string, unknown>, body: Buffer | Readable) {
  const response: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      response.status = status;
      return this;
    },
    async send(value: unknown) {
      response.body = value;
    },
  };
  const chunks: Buffer[] = [];
  if (Buffer.isBuffer(body)) {
    for (let offset = 0; offset < body.length; offset += 64 * 1024) chunks.push(body.subarray(offset, offset + 64 * 1024));
  }
  const result = await handler(
    { params: { connId: 'connection-1' }, query, body: Buffer.isBuffer(body) ? Readable.from(chunks) : body },
    reply,
  );
  return { result, ...response };
}

describe('SFTP upload resume', () => {
  const MiB = 1024 * 1024;
  const lastModified = '1760000000000';
  const fingerprint = 'ab'.repeat(32);
  const source = randomBytes(MiB + 300);
  const query = { path: '/remote/image.bin', size: String(source.length), lastModified, fingerprint };
  const staged = `/remote/image.bin.muxus-${createHash('sha256')
    .update(`${source.length}:${lastModified}:${fingerprint}`)
    .digest('hex')
    .slice(0, 12)}.upload`;

  it('stages an upload under a name made of the local file\'s size, time and fingerprint', async () => {
    const remote = memorySftp();
    const handler = captureUploadHandler(remote.sftp);

    expect((await upload(handler, query, source)).result).toEqual({ ok: true });
    await upload(handler, { ...query, lastModified: '1760000000001', overwrite: 'true' }, source);
    await upload(handler, { ...query, fingerprint: 'cd'.repeat(32), overwrite: 'true' }, source);

    const names = remote.writes.map(({ path }) => path);
    expect(names[0]).toBe(staged);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^\/remote\/image\.bin\.muxus-[a-f0-9]{12}\.upload$/);
    expect(remote.files.get('/remote/image.bin')).toEqual(source);
    expect([...remote.files.keys()]).toEqual(['/remote/image.bin']);
  });

  it('continues a staged file whose last bytes match the upload, sending only the rest', async () => {
    const remote = memorySftp();
    remote.files.set(staged, source.subarray(0, 700_000));
    const handler = captureUploadHandler(remote.sftp);

    const response = await upload(handler, query, source);

    expect(response.result).toEqual({ ok: true });
    expect(remote.writes).toEqual([{ path: staged, start: 700_000, bytes: source.length - 700_000 }]);
    expect(remote.files.get('/remote/image.bin')).toEqual(source);
    expect(remote.files.has(staged)).toBe(false);
  });

  it('writes nothing into a staged file that differs, and has the file sent again', async () => {
    const remote = memorySftp();
    const other = Buffer.concat([source.subarray(0, 600_000), randomBytes(100_000)]);
    remote.files.set(staged, other);
    const handler = captureUploadHandler(remote.sftp);

    const response = await upload(handler, query, source);

    expect(response).toMatchObject({
      status: 409,
      body: { message: 'the upload kept on the server does not match this file', code: 'SFTP_UPLOAD_MISMATCH' },
    });
    expect(remote.writes.every(({ bytes }) => bytes === 0)).toBe(true);
    expect([...remote.files.keys()]).toEqual([]);
  });

  it('never opens what holds the staged name unless it is a regular file', async () => {
    const remote = memorySftp({ fifos: [staged] });
    const handler = captureUploadHandler(remote.sftp);

    expect((await upload(handler, query, source)).result).toEqual({ ok: true });
    expect(remote.opens).toEqual([]);
    expect(remote.files.get('/remote/image.bin')).toEqual(source);

    const linked = memorySftp();
    const keys = Buffer.from('ssh-ed25519 AAAA admin@laptop\n');
    linked.files.set('/home/admin/.ssh/authorized_keys', keys);
    linked.links.set(staged, '/home/admin/.ssh/authorized_keys');

    expect((await upload(captureUploadHandler(linked.sftp), query, source)).result).toEqual({ ok: true });
    expect(linked.opens).toEqual([]);
    expect(linked.files.get('/home/admin/.ssh/authorized_keys')).toEqual(keys);
    expect(linked.files.get('/remote/image.bin')).toEqual(source);
  });

  it('never writes through a staged name swapped for a link just before it is opened', async () => {
    const remote = memorySftp();
    const keys = Buffer.from('ssh-ed25519 AAAA admin@laptop\n');
    remote.files.set('/home/admin/.ssh/authorized_keys', keys);
    remote.files.set(staged, source.subarray(0, 700_000));
    const open = remote.sftp.open.bind(remote.sftp);
    remote.sftp.open = (file, flags, callback) => {
      remote.links.set(file, '/home/admin/.ssh/authorized_keys');
      open(file, flags, callback);
    };
    const handler = captureUploadHandler(remote.sftp);

    const response = await upload(handler, query, source);

    expect(response.status).toBe(409);
    expect(remote.files.get('/home/admin/.ssh/authorized_keys')).toEqual(keys);
    expect(remote.links.has(staged)).toBe(false);
    expect(remote.files.has('/remote/image.bin')).toBe(false);
  });

  it('closes the staged file once, however a continued upload ends', async () => {
    // A second close could close another file: OpenSSH hands a freed handle out again.
    const cancelled = Readable.from(
      (async function* () {
        yield source.subarray(0, 800_000);
        throw new Error('aborted by the browser');
      })(),
    );
    const other = Buffer.concat([source.subarray(0, 600_000), randomBytes(100_000)]);
    for (const [remote, partial, body] of [
      [memorySftp(), source.subarray(0, 700_000), source],
      [memorySftp(), other, source],
      [memorySftp(), source.subarray(0, 700_000), cancelled],
      [memorySftp({ failWrites: true }), source.subarray(0, 700_000), source],
    ] as const) {
      remote.files.set(staged, partial);
      const handler = captureUploadHandler(remote.sftp);

      await upload(handler, query, body);

      const opened = remote.opens.find(({ path }) => path === staged)?.handle;
      expect(remote.closes.filter((handle) => handle === opened)).toHaveLength(1);
    }
  });

  it('starts over from a staged file it cannot continue', async () => {
    for (const [remote, partial] of [
      // The server empties what it opens for writing.
      [memorySftp({ truncateOnOpen: true }), source.subarray(0, 700_000)],
      [memorySftp(), randomBytes(source.length + 1)],
      [memorySftp(), Buffer.alloc(0)],
    ] as const) {
      remote.files.set(staged, partial);
      const handler = captureUploadHandler(remote.sftp);

      expect((await upload(handler, query, source)).result).toEqual({ ok: true });
      expect(remote.writes).toEqual([{ path: staged, start: 0, bytes: source.length }]);
      expect(remote.files.get('/remote/image.bin')).toEqual(source);
    }
  });

  it('uploads under a random name when what holds the staged name cannot be removed', async () => {
    const remote = memorySftp({ stuck: [staged] });
    remote.files.set(staged, Buffer.from('another user\'s file'));
    const handler = captureUploadHandler(remote.sftp);

    expect((await upload(handler, query, source)).result).toEqual({ ok: true });
    expect(remote.writes[0]?.path).toMatch(/^\/remote\/image\.bin\.muxus-[a-f0-9]{12}\.upload$/);
    expect(remote.writes[0]?.path).not.toBe(staged);
    expect(remote.files.get(staged)?.toString()).toBe('another user\'s file');
    expect(remote.files.get('/remote/image.bin')).toEqual(source);
  });

  it('sends the same file a second time at once under a name of its own', async () => {
    const remote = memorySftp();
    const handler = captureUploadHandler(remote.sftp);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = Readable.from(
      (async function* () {
        yield source.subarray(0, MiB);
        await held;
        yield source.subarray(MiB);
      })(),
    );

    const first = upload(handler, query, slow);
    await vi.waitFor(() => expect(remote.writes).toHaveLength(1));
    expect((await upload(handler, query, source)).result).toEqual({ ok: true });
    release();
    await first;

    expect(remote.writes[0]?.path).toBe(staged);
    expect(remote.writes[1]?.path).toMatch(/^\/remote\/image\.bin\.muxus-[a-f0-9]{12}\.upload$/);
    expect(remote.writes[1]?.path).not.toBe(staged);
    expect(remote.files.get('/remote/image.bin')).toEqual(source);
  });

  it('leaves an upload that does not describe the local file as it was', async () => {
    const remote = memorySftp();
    const lstat = vi.spyOn(remote.sftp, 'lstat');
    const handler = captureUploadHandler(remote.sftp);

    expect((await upload(handler, { path: '/remote/image.bin' }, source)).result).toEqual({ ok: true });
    expect(lstat.mock.calls.map(([file]) => file)).toEqual(['/remote/image.bin', '/remote/image.bin']);
    expect(remote.opens).toEqual([]);
    expect(remote.writes[0]?.path).not.toBe(staged);
    expect(remote.files.get('/remote/image.bin')).toEqual(source);
  });

  it('rejects a size, time or fingerprint that cannot describe a file', async () => {
    const remote = memorySftp();
    const handler = captureUploadHandler(remote.sftp);

    expect((await upload(handler, { ...query, size: '-1' }, source)).status).toBe(400);
    expect((await upload(handler, { path: query.path, size: query.size, lastModified }, source)).status).toBe(400);
    expect((await upload(handler, { ...query, lastModified: 'yesterday' }, source)).status).toBe(400);
    expect((await upload(handler, { ...query, fingerprint: '../../etc/passwd' }, source)).status).toBe(400);
    expect(remote.writes).toEqual([]);
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
    expect(headers.get('last-modified')).toBe('Thu, 09 Oct 2025 08:53:20 GMT');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(release).not.toHaveBeenCalled();

    raw.emit('close');
    expect(release).toHaveBeenCalledOnce();

    stream.destroy();
    expect(release).toHaveBeenCalledOnce();
  });
});

/** The listing and drag-download routes on one connection that the test can close. */
function captureDragDownloadRoutes() {
  const gets = new Map<string, RouteHandler>();
  const app = {
    get: (route: string, handler: RouteHandler) => gets.set(route, handler),
    post: vi.fn(),
    put: vi.fn(),
  };
  const closeListeners: Array<() => void> = [];
  const opened: string[] = [];
  const sftp = {
    realpath: (dir: string, callback: (error: Error | null, resolved?: string) => void) =>
      callback(null, dir === '.' ? '/home/deploy' : dir),
    readdir: (_dir: string, callback: (error: Error | null, entries?: unknown) => void) =>
      callback(null, [
        {
          filename: 'report.txt',
          longname: '-rw-r--r--    1 deploy   deploy          7 Oct  9 08:53 report.txt',
          attrs: { size: 7, mtime: 1_760_000_000, mode: 0o100644 },
        },
      ]),
    stat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) =>
      callback(null, { size: 7 }),
    createReadStream: (file: string) => {
      opened.push(file);
      return new PassThrough();
    },
  };
  let closed = false;
  const connection = {
    id: 'connection-1',
    sftp: async () => sftp,
    onClose: (listener: () => void) => {
      closeListeners.push(listener);
      return () => undefined;
    },
  };
  const ctx = {
    systemOpenSsh: { acquire: () => undefined },
    connections: {
      acquire: () =>
        closed ? undefined : { connection, owner: 'sftp', release: vi.fn() },
    },
  };
  registerSftpRoutes(app as never, ctx as never);
  const list = gets.get('/api/sftp/:connId/list')!;
  const drag = gets.get('/api/sftp/:connId/drag-download')!;

  const ticket = async (): Promise<string | undefined> => {
    const listing = (await list(
      { params: { connId: 'connection-1' }, query: { path: '.' } },
      {},
    )) as { entries: Array<{ downloadTicket?: string }> };
    return listing.entries[0]?.downloadTicket;
  };
  const download = async (value: string | undefined, connId = 'connection-1') => {
    const response: { status?: number; body?: unknown } = {};
    const reply = {
      raw: new EventEmitter(),
      header() {
        return this;
      },
      code(status: number) {
        response.status = status;
        return this;
      },
      send(body: unknown) {
        response.body = body;
        return body;
      },
    };
    await drag({ params: { connId }, query: { ticket: value } }, reply);
    return response;
  };
  const closeConnection = () => {
    closed = true;
    for (const listener of closeListeners) listener();
  };
  return { ticket, download, closeConnection, opened, closeListeners };
}

describe('SFTP drag-out download tickets', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('still download a file dragged out long after its folder was listed', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-24T09:00:00Z') });
    const routes = captureDragDownloadRoutes();
    const ticket = await routes.ticket();
    expect(ticket).toBeTruthy();

    // A listing left on screen: finding the file and dragging it can take a while.
    vi.setSystemTime(Date.parse('2026-10-24T12:00:00Z'));
    const response = await routes.download(ticket);

    expect(response.status).toBeUndefined();
    expect(response.body).toBeInstanceOf(PassThrough);
    expect(routes.opened).toEqual(['/home/deploy/report.txt']);
  });

  it('keep one ticket per file across listings of the same connection', async () => {
    const routes = captureDragDownloadRoutes();
    const first = await routes.ticket();

    expect(await routes.ticket()).toBe(first);
    expect(routes.closeListeners).toHaveLength(1);
  });

  it('stop working once the connection closes', async () => {
    const routes = captureDragDownloadRoutes();
    const ticket = await routes.ticket();

    routes.closeConnection();

    expect(await routes.download(ticket)).toMatchObject({
      status: 401,
      body: { message: 'download ticket is missing or expired' },
    });
    expect(routes.opened).toEqual([]);
  });

  it('only download through the connection they were issued for', async () => {
    const routes = captureDragDownloadRoutes();
    const ticket = await routes.ticket();

    expect((await routes.download(ticket, 'connection-2')).status).toBe(401);
    expect((await routes.download('forged')).status).toBe(401);
    expect((await routes.download(undefined)).status).toBe(401);
    expect(routes.opened).toEqual([]);
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
