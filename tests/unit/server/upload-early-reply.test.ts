import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'upload-early-reply-test-token';
let built: Awaited<ReturnType<typeof buildApp>>;
let socket: net.Socket | undefined;

beforeEach(async () => {
  built = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  );
  await built.app.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  socket?.destroy();
  vi.restoreAllMocks();
  built.app.server.closeAllConnections();
  await built.app.close();
});

/** Uploads into a folder the user may write to, or into one they may not. */
function useSftp(writable: boolean): void {
  const denied = () => Object.assign(new Error('Permission denied'), { code: 3 });
  const sftp = {
    lstat: (_path: string, callback: (error: Error) => void) =>
      callback(Object.assign(new Error('No such file'), { code: 2 })),
    open: (_path: string, _flags: string, _attrs: unknown, callback: (error: Error | null, handle?: Buffer) => void) =>
      writable ? callback(null, Buffer.from('handle')) : callback(denied()),
    createWriteStream: () =>
      writable
        ? new Writable({ write: (_chunk, _encoding, callback) => callback() })
        : new Writable({ construct: (callback) => callback(denied()) }),
    rename: (_from: string, _to: string, callback: (error?: Error | null) => void) => callback(null),
    stat: (_path: string, callback: (error: Error | null, attrs?: unknown) => void) => callback(null, {}),
    unlink: (_path: string, callback: (error?: Error | null) => void) => callback(null),
  };
  vi.spyOn(built.ctx.connections, 'acquire').mockReturnValue({
    connection: { sftp: async () => sftp },
    release: () => undefined,
  } as never);
}

/** Send a request's header lines over a raw connection, then `body`. */
async function request(head: string[], body?: Buffer) {
  const { port } = built.app.server.address() as AddressInfo;
  const client = net.connect(port, '127.0.0.1');
  socket = client;
  client.on('error', () => undefined);
  let answer = '';
  client.on('data', (data: Buffer) => {
    answer += data.toString('latin1');
  });
  await once(client, 'connect');
  const closed = new Promise((resolve) => client.once('close', () => resolve('closed')));
  client.write([...head, '', ''].join('\r\n'));
  if (body) client.write(body);
  return { closed, answer: () => answer };
}

/** Start an upload of `size` bytes and send `sent` of them. */
function upload(size: number, sent: number) {
  return request(
    [
      'POST /api/sftp/connection-1/upload?path=%2Fsrv%2Ffiles%2Fimage.bin HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/octet-stream',
      `Content-Length: ${size}`,
    ],
    Buffer.alloc(sent),
  );
}

describe('an upload that fails before its body has arrived', () => {
  it('closes the connection once it has answered', async () => {
    // A folder the user may not write to: the remote file cannot be created.
    useSftp(false);

    // The start of a large file has arrived when the answer comes.
    const { closed, answer } = await upload(512 * 1024 * 1024, 64 * 1024);

    expect(await Promise.race([closed, delay(3_000, 'still open')])).toBe('closed');
    expect(answer()).toMatch(/^HTTP\/1\.1 500 /);
    expect(answer()).toMatch(/\r\nconnection: close\r\n/i);
    expect(answer()).toContain('Permission denied');
  });

  it('leaves the connection of a finished upload open for the next request', async () => {
    useSftp(true);

    const { closed, answer } = await upload(64 * 1024, 64 * 1024);

    expect(await Promise.race([closed, delay(500, 'still open')])).toBe('still open');
    expect(answer()).toMatch(/^HTTP\/1\.1 200 /);
    expect(answer()).toMatch(/\r\nconnection: keep-alive\r\n/i);
  });

  it('leaves the connection of a request without a body open when it is answered at once', async () => {
    // The token check answers while the request is still being parsed.
    const { closed, answer } = await request(['GET /api/app/info HTTP/1.1', 'Host: 127.0.0.1']);

    expect(await Promise.race([closed, delay(500, 'still open')])).toBe('still open');
    expect(answer()).toMatch(/^HTTP\/1\.1 401 /);
    expect(answer()).toMatch(/\r\nconnection: keep-alive\r\n/i);
  });
});
