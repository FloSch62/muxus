import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { registerLocalFileRoutes } from '../../../server/src/routes/local-files.js';

let root: string;
type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>;

function captureHandlers(): { read: RouteHandler; save: RouteHandler } {
  const gets = new Map<string, RouteHandler>();
  const puts = new Map<string, RouteHandler>();
  const app = {
    get: (route: string, handler: RouteHandler) => gets.set(route, handler),
    put: (route: string, _options: unknown, handler: RouteHandler) => puts.set(route, handler),
  };
  registerLocalFileRoutes(app as never);
  return {
    read: gets.get('/api/local-files/file')!,
    save: puts.get('/api/local-files/file')!,
  };
}

async function invoke(
  handler: RouteHandler,
  input: { path: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let sent: unknown;
  const reply = {
    code(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    send(body: unknown) {
      sent = body;
    },
  };
  const result = await handler({ query: { path: input.path }, body: input.body }, reply);
  return { status, body: sent ?? result };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'muxus-local-editor-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local file editor routes', () => {
  it('is registered behind the API bearer-token guard', async () => {
    const token = 'local-editor-route-test-token';
    const built = await buildApp(
      resolveConfig({
        token,
        databasePath: ':memory:',
        openBrowser: false,
        prettyLogs: false,
        staticRoot: '/path/that/does/not/exist',
      }),
    );
    try {
      const unauthorized = await built.app.inject({
        method: 'GET',
        url: `/api/local-files/file?path=${encodeURIComponent(path.join(root, 'notes.txt'))}`,
      });
      const registered = await built.app.inject({
        method: 'GET',
        url: '/api/local-files/file?path=relative.txt',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(unauthorized.statusCode).toBe(401);
      expect(registered.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('reads UTF-8 text and saves it atomically without changing its bytes', async () => {
    const file = path.join(root, 'notes.txt');
    await writeFile(file, 'before', { mode: 0o674 });
    const { read, save } = captureHandlers();

    const opened = await invoke(read, { path: file });

    expect(opened.status).toBe(200);
    const metadata = opened.body as { content: string; mtimeMs: number; mode: number };
    expect(metadata.content).toBe('before');
    if (process.platform !== 'win32') expect(metadata.mode).toBe(0o674);

    const saved = await invoke(save, {
      path: file,
      body: { content: 'https://example.test', expectedMtimeMs: metadata.mtimeMs },
    });

    expect(saved.status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('https://example.test');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o7777).toBe(0o674);
    expect((await readdir(root)).filter((name) => name.includes('.muxus-'))).toEqual([]);
  });

  it('rejects a save when the file changed after it was opened', async () => {
    const file = path.join(root, 'config.yaml');
    await writeFile(file, 'first');
    const { read, save } = captureHandlers();
    const opened = await invoke(read, { path: file });
    const originalMtime = (opened.body as { mtimeMs: number }).mtimeMs;
    await writeFile(file, 'external');
    await utimes(file, new Date(), new Date(originalMtime + 5_000));

    const response = await invoke(save, {
      path: file,
      body: { content: 'editor', expectedMtimeMs: originalMtime },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'LOCAL_FILE_CHANGED' });
    expect(await readFile(file, 'utf8')).toBe('external');
  });

  it('rejects binary data, directories, and relative paths', async () => {
    const binary = path.join(root, 'binary.dat');
    await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
    const { read } = captureHandlers();

    const binaryResponse = await invoke(read, { path: binary });
    const directoryResponse = await invoke(read, { path: root });
    const relativeResponse = await invoke(read, { path: 'notes.txt' });

    expect(binaryResponse.status).toBe(415);
    expect(directoryResponse.status).toBe(400);
    expect(relativeResponse.status).toBe(400);
  });

  it.skipIf(process.platform === 'win32')('refuses to follow a symbolic link', async () => {
    const target = path.join(root, 'target.txt');
    const link = path.join(root, 'link.txt');
    await writeFile(target, 'secret');
    await symlink(target, link);
    const { read } = captureHandlers();

    const response = await invoke(read, { path: link });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'LOCAL_EDITOR_SYMLINK' });
  });
});
