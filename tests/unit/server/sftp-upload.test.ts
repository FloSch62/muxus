import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough, Readable, Writable } from 'node:stream';
import { Server, type SFTPWrapper } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { registerSftpRoutes } from '../../../server/src/routes/sftp.js';
import { SshError, SshTransport } from '../../../server/src/ssh/engine.js';

type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>;

interface FakeSftp {
  lstat(path: string): Promise<unknown>;
  open?(path: string, flags: string, mode?: number): Promise<Buffer>;
  fchmod?(handle: Buffer, mode: number): Promise<void>;
  createWriteStream(handle: Buffer, options?: { start?: number; autoClose?: boolean }): Writable;
  rename?(from: string, to: string): Promise<void>;
  posixRename?(from: string, to: string): Promise<void>;
  unlink?(path: string): Promise<void>;
  stat?(path: string): Promise<unknown>;
}

/** The server's answers as the engine reports them: an SFTP status, by its number. */
const noSuchFile = () => new SshError('No such file', 'SFTP_STATUS', 2);
const denied = () => new SshError('Permission denied', 'SFTP_STATUS', 3);

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
            stat: async () => ({ size: 7, mtime: 1_760_000_000 }),
            open: async () => Buffer.from('handle'),
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

/** Creates the file it is asked for, as in a folder the user may write to. */
const openNewFile: NonNullable<FakeSftp['open']> = async () => Buffer.from('handle');

/** The uploaded file as a server that reports no modification time describes it. */
const statWithoutTime: NonNullable<FakeSftp['stat']> = async () => regularFile;

describe('SFTP upload overwrite policy', () => {
  it('returns a conflict without opening an existing destination', async () => {
    const open = vi.fn();
    const createWriteStream = vi.fn();
    const handler = captureUploadHandler({
      lstat: async () => regularFile,
      open,
      createWriteStream,
    });

    const response = await invoke(handler, { path: '/remote/report.txt' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: 'a file already exists at the upload destination',
      code: 'SFTP_DESTINATION_EXISTS',
    });
    expect(open).not.toHaveBeenCalled();
    expect(createWriteStream).not.toHaveBeenCalled();
  });

  it('stages a new destination before renaming it into place', async () => {
    const chunks: Buffer[] = [];
    const open = vi.fn(openNewFile);
    const createWriteStream = vi.fn((_handle: Buffer) =>
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
    const rename = vi.fn(async (_from: string, _to: string) => undefined);
    const handler = captureUploadHandler({
      lstat: () => Promise.reject(noSuchFile()),
      stat: statWithoutTime,
      open,
      createWriteStream,
      rename,
      unlink: vi.fn(),
    });

    const response = await invoke(handler, { path: '/remote/report.txt' });

    expect(response.result).toEqual({ ok: true });
    expect(open.mock.calls[0]?.[0]).toMatch(
      /^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/,
    );
    expect(createWriteStream.mock.calls[0]).toEqual([Buffer.from('handle')]);
    expect(Buffer.concat(chunks).toString()).toBe('payload');
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/),
      '/remote/report.txt',
    );
  });

  it('creates clipboard images with owner-only permissions', async () => {
    const open = vi.fn(openNewFile);
    const fchmod = vi.fn(async (_handle: Buffer, _mode: number) => undefined);
    const createWriteStream = vi.fn(
      (_handle: Buffer) => new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    );
    const rename = vi.fn(async (_from: string, _to: string) => undefined);
    const handler = captureUploadHandler(
      {
        lstat: () => Promise.reject(noSuchFile()),
        open,
        fchmod,
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
    expect(open.mock.calls[0]).toEqual([
      expect.stringMatching(new RegExp(`^${remotePath.replaceAll('.', '\\.')}\\.muxus-[a-f0-9]+\\.upload$`)),
      'wx',
      0o600,
    ]);
    // Set on the open file as well, so that it is exactly this mode whatever the umask.
    expect(fchmod).toHaveBeenCalledWith(Buffer.from('handle'), 0o600);
    expect(createWriteStream.mock.calls[0]).toEqual([Buffer.from('handle')]);
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/\.muxus-[a-f0-9]+\.upload$/),
      remotePath,
    );
  });

  it('atomically replaces an existing regular file after explicit overwrite consent', async () => {
    const open = vi.fn(openNewFile);
    const createWriteStream = vi.fn((_handle: Buffer) => new Writable({ write: (_c, _e, cb) => cb() }));
    const atomicRename = vi.fn(async (_from: string, _to: string) => undefined);
    const handler = captureUploadHandler({
      lstat: async () => regularFile,
      stat: statWithoutTime,
      open,
      createWriteStream,
      posixRename: atomicRename,
      unlink: vi.fn(),
    });

    const response = await invoke(handler, { path: '/remote/report.txt', overwrite: 'true' });

    expect(response.result).toEqual({ ok: true });
    expect(open.mock.calls[0]?.[0]).toMatch(
      /^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/,
    );
    expect(createWriteStream.mock.calls[0]).toEqual([Buffer.from('handle')]);
    expect(atomicRename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/),
      '/remote/report.txt',
    );
  });

  it('replaces a file only while it keeps the modification time the client downloaded', async () => {
    const createWriteStream = vi.fn((_handle: Buffer) => new Writable({ write: (_c, _e, cb) => cb() }));
    const handler = captureUploadHandler({
      lstat: async () => ({ ...regularFile, mtime: 1_700_000_000 }),
      stat: async () => ({ ...regularFile, mtime: 1_700_000_050 }),
      open: openNewFile,
      createWriteStream,
      posixRename: async () => undefined,
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
    const open = vi.fn();
    const createWriteStream = vi.fn();
    const handler = captureUploadHandler({
      lstat: () => Promise.reject(noSuchFile()),
      open,
      createWriteStream,
    });

    const response = await invoke(handler, {
      path: '/remote/plan.drawio',
      overwrite: 'true',
      expectedMtimeMs: '1700000000000',
    });

    expect(response.status).toBe(409);
    expect(open).not.toHaveBeenCalled();
    expect(createWriteStream).not.toHaveBeenCalled();
    expect((await invoke(handler, { path: '/remote/plan.drawio', expectedMtimeMs: 'soon' })).status).toBe(400);
  });

  it('replaces a file on servers without the posix-rename extension', async () => {
    const unlink = vi.fn(async (_path: string) => undefined);
    let renamed = 0;
    const rename = vi.fn(async (_from: string, _to: string) => {
      // Plain SFTP v3 rename refuses an existing destination.
      if (renamed++ === 0) throw new SshError('Failure', 'SFTP_STATUS', 4);
    });
    const handler = captureUploadHandler({
      lstat: async () => regularFile,
      stat: statWithoutTime,
      open: openNewFile,
      createWriteStream: () => new Writable({ write: (_c, _e, cb) => cb() }),
      // The engine refuses by itself when the server never announced the extension.
      posixRename: () =>
        Promise.reject(new SshError('Server does not support this extended request', 'SFTP_UNSUPPORTED')),
      rename,
      unlink,
    });

    const response = await invoke(handler, { path: '/remote/report.txt', overwrite: 'true' });

    expect(response.result).toEqual({ ok: true });
    expect(unlink).toHaveBeenCalledWith('/remote/report.txt');
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('refuses to follow a destination symlink even with overwrite consent', async () => {
    const open = vi.fn();
    const createWriteStream = vi.fn();
    const handler = captureUploadHandler({
      lstat: async () => ({
        isDirectory: () => false,
        isSymbolicLink: () => true,
      }),
      open,
      createWriteStream,
    });

    const response = await invoke(handler, { path: '/remote/report.txt', overwrite: 'true' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: 'refusing to overwrite a symbolic link',
      code: 'SFTP_DESTINATION_IS_SYMLINK',
    });
    expect(open).not.toHaveBeenCalled();
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
    const unlink = vi.fn(async (_path: string) => undefined);
    const rename = vi.fn();
    const handler = captureUploadHandler({
      lstat: () => Promise.reject(noSuchFile()),
      open: openNewFile,
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
    );
    expect(rename).not.toHaveBeenCalled();
  });
});

/**
 * An SFTP server in memory with what staged uploads use: files and symbolic
 * links by path, files opened by handle. `truncateOnOpen` empties a file opened
 * for writing, as hack/demo-env.mjs does; `stuck` entries belong to someone
 * else, who neither lets them be opened nor removed. `modes` holds the mode
 * each file was created with, or was given since.
 */
function memorySftp(
  options: { truncateOnOpen?: boolean; stuck?: string[]; failWrites?: boolean; fifos?: string[] } = {},
) {
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  const fifos = new Set(options.fifos);
  const modes = new Map<string, number>();
  // By handle: the name it was opened under, and the file that name led to.
  const handles = new Map<string, { path: string; target: string }>();
  const writes: Array<{ path: string; start: number; bytes: number }> = [];
  const opens: Array<{ path: string; flags: string; handle: string }> = [];
  const closes: string[] = [];
  const attrs = (bytes: Buffer) => ({ ...regularFile, size: bytes.length, mode: 0o100644 });
  const opened = (handle: Buffer) => handles.get(handle.toString())!;
  const sftp = {
    async lstat(file: string) {
      const bytes = files.get(file);
      if (links.has(file)) return { isDirectory: () => false, isSymbolicLink: () => true, mode: 0o120777 };
      if (fifos.has(file)) return { isDirectory: () => false, isSymbolicLink: () => false, mode: 0o010644 };
      if (bytes) return attrs(bytes);
      throw noSuchFile();
    },
    async stat(file: string) {
      const bytes = files.get(links.get(file) ?? file);
      if (!bytes) throw noSuchFile();
      return attrs(bytes);
    },
    async open(file: string, flags: string, mode?: number) {
      if (options.stuck?.includes(file)) throw denied();
      if (fifos.has(file)) throw new Error('a FIFO was opened');
      // A new file is only made under a name that nothing holds.
      if (flags === 'wx' && (files.has(file) || links.has(file))) throw new SshError('Failure', 'SFTP_STATUS', 4);
      const target = links.get(file) ?? file;
      if (flags === 'wx') {
        files.set(target, Buffer.alloc(0));
        modes.set(target, mode ?? 0o666);
      }
      if (!files.has(target)) throw noSuchFile();
      if (options.truncateOnOpen) files.set(target, Buffer.alloc(0));
      const handle = Buffer.from(`handle-${opens.length}`);
      handles.set(handle.toString(), { path: file, target });
      opens.push({ path: file, flags, handle: handle.toString() });
      return handle;
    },
    async fstat(handle: Buffer) {
      return attrs(files.get(opened(handle).target)!);
    },
    async fchmod(handle: Buffer, mode: number) {
      modes.set(opened(handle).target, mode);
    },
    async read(handle: Buffer, offset: number, length: number) {
      const bytes = files.get(opened(handle).target)!.subarray(offset, offset + length);
      // The end of a file is reported as nothing, not as an empty read.
      return bytes.length ? Buffer.from(bytes) : undefined;
    },
    async closeHandle(handle: Buffer) {
      closes.push(handle.toString());
      handles.delete(handle.toString());
    },
    async unlink(file: string) {
      if (options.stuck?.includes(file)) throw denied();
      if (!links.delete(file) && !fifos.delete(file) && !files.delete(file)) throw noSuchFile();
    },
    async rename(from: string, to: string) {
      const bytes = files.get(from);
      if (!bytes) throw noSuchFile();
      files.delete(from);
      files.set(to, bytes);
      if (modes.has(from)) modes.set(to, modes.get(from)!);
    },
    // Replaces what holds the new name, as this server's plain rename does too.
    posixRename(from: string, to: string) {
      return sftp.rename(from, to);
    },
    createWriteStream(handle: Buffer, streamOptions: { start?: number; autoClose?: boolean } = {}) {
      const { path: file, target } = opened(handle);
      let position = streamOptions.start ?? 0;
      const write = { path: file, start: position, bytes: 0 };
      writes.push(write);
      return new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (options.failWrites) return callback(new SshError('Failure', 'SFTP_STATUS', 4));
          const current = files.get(target)!;
          const grown = Buffer.alloc(Math.max(current.length, position + chunk.length));
          current.copy(grown);
          chunk.copy(grown, position);
          files.set(target, grown);
          position += chunk.length;
          write.bytes += chunk.length;
          callback();
        },
        // As in the engine: the stream closes its handle when it ends, unless told to leave it.
        destroy(error, callback) {
          if (streamOptions.autoClose === false) return callback(error);
          void sftp.closeHandle(handle).then(() => callback(error));
        },
      });
    },
  };
  return { sftp, files, links, modes, writes, opens, closes };
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

  it('creates a new staged file with 0644, which the server\'s umask may narrow', async () => {
    const remote = memorySftp();
    const open = vi.spyOn(remote.sftp, 'open');
    const fchmod = vi.spyOn(remote.sftp, 'fchmod');
    const handler = captureUploadHandler(remote.sftp);

    expect((await upload(handler, query, source)).result).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith(staged, 'wx', 0o644);
    // A mode set on the open file would give back what the umask took away.
    expect(fchmod).not.toHaveBeenCalled();
    expect(remote.modes.get('/remote/image.bin')).toBe(0o644);
  });

  it('keeps the mode a continued staged file was created with', async () => {
    const remote = memorySftp();
    remote.files.set(staged, source.subarray(0, 700_000));
    remote.modes.set(staged, 0o600);
    const handler = captureUploadHandler(remote.sftp);

    expect((await upload(handler, query, source)).result).toEqual({ ok: true });
    expect(remote.modes.get('/remote/image.bin')).toBe(0o600);
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
    // Only the staged file it creates itself is opened.
    expect(remote.opens).toEqual([expect.objectContaining({ path: staged, flags: 'wx' })]);
    expect(remote.files.get('/remote/image.bin')).toEqual(source);

    const linked = memorySftp();
    const keys = Buffer.from('ssh-ed25519 AAAA admin@laptop\n');
    linked.files.set('/home/admin/.ssh/authorized_keys', keys);
    linked.links.set(staged, '/home/admin/.ssh/authorized_keys');

    expect((await upload(captureUploadHandler(linked.sftp), query, source)).result).toEqual({ ok: true });
    expect(linked.opens).toEqual([expect.objectContaining({ path: staged, flags: 'wx' })]);
    expect(linked.files.get('/home/admin/.ssh/authorized_keys')).toEqual(keys);
    expect(linked.files.get('/remote/image.bin')).toEqual(source);
  });

  it('never writes through a staged name swapped for a link just before it is opened', async () => {
    const remote = memorySftp();
    const keys = Buffer.from('ssh-ed25519 AAAA admin@laptop\n');
    remote.files.set('/home/admin/.ssh/authorized_keys', keys);
    remote.files.set(staged, source.subarray(0, 700_000));
    const open = remote.sftp.open.bind(remote.sftp);
    remote.sftp.open = (file, flags, mode) => {
      remote.links.set(file, '/home/admin/.ssh/authorized_keys');
      return open(file, flags, mode);
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
    expect(remote.opens.map(({ path }) => path)).not.toContain(staged);
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
        headers: {},
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

/** The download route for a 7-byte file on the host that `muxKey` names. */
function captureResumableDownload(muxKey = 'deploy@web-01:22') {
  const gets = new Map<string, RouteHandler>();
  const app = {
    get: (route: string, handler: RouteHandler) => gets.set(route, handler),
    post: vi.fn(),
    put: vi.fn(),
  };
  const reads: Array<{ start?: number }> = [];
  const ctx = {
    systemOpenSsh: { acquire: () => undefined },
    connections: {
      acquire: () => ({
        connection: {
          muxKey,
          sftp: async () => ({
            stat: async () => ({ size: 7, mtime: 1_760_000_000 }),
            open: async () => Buffer.from('handle'),
            createReadStream: (_handle: Buffer, { start }: { start?: number }) => {
              reads.push({ start });
              return new PassThrough();
            },
          }),
        },
        owner: 'sftp',
        release: vi.fn(),
      }),
    },
  };
  registerSftpRoutes(app as never, ctx as never);
  const handler = gets.get('/api/sftp/:connId/download')!;
  const download = async (headers: Record<string, string> = {}) => {
    const response = { status: 200, headers: new Map<string, unknown>() };
    const reply = {
      raw: new EventEmitter(),
      header(name: string, value: unknown) {
        response.headers.set(name, value);
        return this;
      },
      code(status: number) {
        response.status = status;
        return this;
      },
      send(body: unknown) {
        return body;
      },
    };
    await handler({ params: { connId: 'connection-1' }, query: { path: '/srv/image.bin' }, headers }, reply);
    return response;
  };
  return { download, reads };
}

describe('SFTP download resume', () => {
  it('sends only the rest of a file that is unchanged since the first attempt', async () => {
    const { download, reads } = captureResumableDownload();

    const first = await download();
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    expect(etag).toMatch(/^"[\w-]+"$/);

    const rest = await download({ range: 'bytes=3-', 'if-range': String(etag) });
    expect(rest.status).toBe(206);
    expect(rest.headers.get('content-range')).toBe('bytes 3-6/7');
    expect(rest.headers.get('content-length')).toBe(4);
    expect(reads).toEqual([{ start: 0 }, { start: 3 }]);
  });

  it('sends the whole file once it changed, without a validator, or for any other range', async () => {
    const { download, reads } = captureResumableDownload();
    const etag = String((await download()).headers.get('etag'));

    const responses = [
      await download({ range: 'bytes=3-', 'if-range': '"an older version"' }),
      await download({ range: 'bytes=3-' }),
      await download({ range: 'bytes=7-', 'if-range': etag }),
      await download({ range: 'bytes=1-2', 'if-range': etag }),
    ];

    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect(responses.map(({ headers }) => headers.get('content-length'))).toEqual([7, 7, 7, 7]);
    expect(reads.every(({ start }) => start === 0)).toBe(true);
  });

  it('gives the same file on another host another validator', async () => {
    const here = await captureResumableDownload('deploy@web-01:22').download();
    const there = await captureResumableDownload('deploy@web-02:22').download();

    expect(here.headers.get('etag')).not.toBe(there.headers.get('etag'));
  });

  it('answers a file that cannot be opened with the error instead of dropping the connection', async () => {
    const token = 'sftp-download-test';
    const { app, ctx } = await buildApp(
      resolveConfig({
        token,
        databasePath: ':memory:',
        openBrowser: false,
        prettyLogs: false,
        staticRoot: '/path/that/does/not/exist',
      }),
    );
    const sftp = {
      stat: async () => ({ size: 7, mtime: 1_760_000_000 }),
      open: () => new Promise<Buffer>((_resolve, reject) => setImmediate(() => reject(denied()))),
      // A stream on a file that was never opened fails once headers may be out.
      createReadStream: (handle?: Buffer) => {
        const stream = new PassThrough();
        if (!handle) setImmediate(() => stream.destroy(denied()));
        return stream;
      },
    };
    vi.spyOn(ctx.systemOpenSsh, 'acquire').mockReturnValue({
      connection: { id: 'connection-1', muxKey: 'deploy@web-01:22', sftp: async () => sftp },
      release: () => undefined,
    } as never);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sftp/connection-1/download?path=%2Fsrv%2Fsecret.key',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ message: 'Permission denied' });
    } finally {
      await app.close();
    }
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
    realpath: async (dir: string) => (dir === '.' ? '/home/deploy' : dir),
    readdir: async () => [
      {
        filename: 'report.txt',
        longname: '-rw-r--r--    1 deploy   deploy          7 Oct  9 08:53 report.txt',
        attrs: { size: 7, mtime: 1_760_000_000, mode: 0o100644 },
      },
    ],
    stat: async () => ({ size: 7 }),
    open: async (file: string) => {
      opened.push(file);
      return Buffer.from('handle');
    },
    createReadStream: () => new PassThrough(),
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

describe('SFTP file modes', () => {
  const sink = () => vi.fn((_handle: Buffer) => new Writable({ write: (_c, _e, cb) => cb() }));
  const chmod = () => vi.fn(async (_handle: Buffer, _mode: number) => undefined);

  it('opens a new file with 0644 less the umask, and does not set its mode again', async () => {
    const open = vi.fn(openNewFile);
    const fchmod = chmod();
    const createWriteStream = sink();
    const handler = captureUploadHandler({
      lstat: () => Promise.reject(noSuchFile()),
      stat: statWithoutTime,
      open,
      fchmod,
      createWriteStream,
      rename: async () => undefined,
      unlink: vi.fn(),
    });

    expect((await invoke(handler, { path: '/remote/report.txt' })).result).toEqual({ ok: true });

    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^\/remote\/report\.txt\.muxus-[a-f0-9]+\.upload$/),
      'wx',
      0o644,
    );
    // A mode set on the open file would give back what the umask took away.
    expect(fchmod).not.toHaveBeenCalled();
    expect(createWriteStream).toHaveBeenCalledWith(Buffer.from('handle'));
  });

  it('gives a replaced file the mode it had', async () => {
    const open = vi.fn(openNewFile);
    const fchmod = chmod();
    const createWriteStream = sink();
    const handler = captureUploadHandler({
      lstat: async () => ({ ...regularFile, mode: 0o100750 }),
      stat: statWithoutTime,
      open,
      fchmod,
      createWriteStream,
      posixRename: async () => undefined,
      unlink: vi.fn(),
    });

    await invoke(handler, { path: '/remote/run.sh', overwrite: 'true' });

    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^\/remote\/run\.sh\.muxus-[a-f0-9]+\.upload$/),
      'wx',
      0o750,
    );
    // The umask narrows the mode a file is opened with, so the open file is given it exactly.
    expect(fchmod).toHaveBeenCalledWith(Buffer.from('handle'), 0o750);
    expect(createWriteStream).toHaveBeenCalledWith(Buffer.from('handle'));
  });

  it('saves from the editor as a new file when the server reports no mode', async () => {
    const open = vi.fn(openNewFile);
    const fchmod = chmod();
    const createWriteStream = sink();
    const { save } = captureEditorHandlers({
      lstat: async () => ({ ...regularFile, mtime: 123 }),
      stat: async () => ({ size: 9, mtime: 125 }),
      open,
      fchmod,
      createWriteStream,
      posixRename: async () => undefined,
      unlink: vi.fn(),
    });

    await save({ params: { connId: 'connection-1' }, query: { path: '/etc/motd' }, body: { content: 'hello' } }, {});

    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), 'wx', 0o644);
    expect(fchmod).not.toHaveBeenCalled();
    expect(createWriteStream).toHaveBeenCalledWith(Buffer.from('handle'));
  });
});

describe('SFTP remote editor', () => {
  it('reads bounded UTF-8 text with its optimistic concurrency metadata', async () => {
    const { read } = captureEditorHandlers({
      lstat: async () => ({
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 12,
        mtime: 123,
        mode: 0o100640,
      }),
      open: async () => Buffer.from('handle'),
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
    const open = vi.fn();
    const createWriteStream = vi.fn();
    const { save } = captureEditorHandlers({
      lstat: async () => ({
        isDirectory: () => false,
        isSymbolicLink: () => false,
        mtime: 124,
        mode: 0o100640,
      }),
      open,
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
    expect(open).not.toHaveBeenCalled();
    expect(createWriteStream).not.toHaveBeenCalled();
  });

  it('atomically replaces the remote text when the version still matches', async () => {
    const written: Buffer[] = [];
    const open = vi.fn(openNewFile);
    const fchmod = vi.fn(async (_handle: Buffer, _mode: number) => undefined);
    const createWriteStream = vi.fn(
      (_handle: Buffer) =>
        new Writable({
          write(chunk, _encoding, callback) {
            written.push(Buffer.from(chunk));
            callback();
          },
        }),
    );
    const rename = vi.fn(async (_from: string, _to: string) => undefined);
    const { save } = captureEditorHandlers({
      lstat: async () => ({
        isDirectory: () => false,
        isSymbolicLink: () => false,
        mtime: 123,
        mode: 0o100640,
      }),
      stat: async () => ({ size: 9, mtime: 125 }),
      open,
      fchmod,
      createWriteStream,
      posixRename: rename,
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
    expect(open.mock.calls[0]).toEqual([
      expect.stringMatching(/^\/etc\/example\.conf\.muxus-[a-f0-9]+\.tmp$/),
      'wx',
      0o640,
    ]);
    expect(fchmod).toHaveBeenCalledWith(Buffer.from('handle'), 0o640);
    expect(createWriteStream.mock.calls[0]).toEqual([Buffer.from('handle')]);
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/etc\/example\.conf\.muxus-[a-f0-9]+\.tmp$/),
      '/etc/example.conf',
    );
  });
});

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

/**
 * An sshd stand-in whose SFTP requests `serve` answers, and the engine's SFTP
 * client on a connection to it. `cut` drops the connection the way a dying
 * network does: the socket goes without a word of SSH. `close` ends both sides.
 */
async function sftpSession(serve: (sftp: SFTPWrapper, cut: () => void) => void) {
  // The sockets are accepted here, so that `cut` can take them from under the SSH server.
  const sockets = new Set<net.Socket>();
  const cut = () => {
    for (const socket of sockets) socket.destroy();
  };
  const sshd = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => ctx.accept());
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => serve(acceptSftp(), cut));
      });
    });
  });
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    sshd.injectSocket(socket);
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const transport = new SshTransport({
    host: '127.0.0.1',
    port: (listener.address() as net.AddressInfo).port,
    verifyHostKey: async () => true,
  });
  const close = async () => {
    transport.close();
    cut();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  };
  try {
    await transport.connect();
    await transport.authNone('deploy');
    return { client: await transport.sftp(), close };
  } catch (err) {
    await close();
    throw err;
  }
}

describe('SFTP upload on a connection that drops', () => {
  let session: Awaited<ReturnType<typeof sftpSession>> | undefined;
  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it('answers with an error instead of waiting for replies that cannot come', async () => {
    session = await sftpSession((server, cut) => {
      server.on('LSTAT', (id) => server.status(id, 2));
      server.on('OPEN', (id) => server.handle(id, Buffer.from('handle')));
      server.on('FSETSTAT', (id) => server.status(id, 0));
      // The connection drops while the first write waits for its reply.
      server.on('WRITE', () => cut());
    });
    const handler = captureUploadHandler(session.client);

    const response = await Promise.race([
      invoke(handler, { path: '/remote/report.txt' }),
      new Promise((resolve) => setTimeout(() => resolve('no answer'), 2_000)),
    ]);

    expect(response).toMatchObject({ status: 500, body: { message: 'The SFTP session has ended.' } });
  });
});
