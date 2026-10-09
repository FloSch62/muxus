import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, Server, type ClientChannel, type Connection } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { requestChannelBreak } from '../../../server/src/ssh/channel-break.js';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

type Answer = 'accept' | 'refuse' | 'ignore';

interface BreakRequest {
  wantReply: boolean;
  /** The request-specific data, which for `break` is only the uint32 length. */
  data: Buffer;
}

interface ServerInternals {
  _protocol: {
    _handlers: Record<string, (...args: unknown[]) => void>;
    channelSuccess(id: number): void;
    channelFailure(id: number): void;
  };
  _chanMgr: { get(id: number): { _chanInfo: { outgoing: { id: number } } } };
}

/**
 * sshd stand-in with a shell that echoes. ssh2 has no `break` event, so the
 * raw channel request is captured and answered the way the test asks.
 */
async function startServer(answer: Answer) {
  const requests: BreakRequest[] = [];
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn: Connection) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => ctx.accept());
    const internals = conn as unknown as ServerInternals;
    const protocol = internals._protocol;
    const handleRequest = protocol._handlers.CHANNEL_REQUEST!;
    protocol._handlers.CHANNEL_REQUEST = (...args: unknown[]) => {
      const [, recipient, type, wantReply, data] = args as [unknown, number, string, boolean, Buffer];
      if (type !== 'break') {
        handleRequest(...args);
        return;
      }
      requests.push({ wantReply, data });
      const channel = internals._chanMgr.get(recipient)._chanInfo.outgoing.id;
      if (answer === 'accept') protocol.channelSuccess(channel);
      else if (answer === 'refuse') protocol.channelFailure(channel);
    };
    conn.on('ready', () => {
      conn.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept) => accept?.());
        session.on('shell', (acceptShell) => {
          const shell = acceptShell();
          shell.on('data', (chunk: Buffer) => shell.write(chunk));
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function openShell(answer: Answer) {
  const sshd = await startServer(answer);
  const client = new Client();
  cleanups.push(() => {
    client.end();
    sshd.server.close();
  });
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve()).once('error', reject);
    client.connect({ host: '127.0.0.1', port: sshd.port, username: 'console' });
  });
  const shell = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (err, channel) =>
      err ? reject(err) : resolve(channel),
    );
  });
  return { shell, requests: sshd.requests };
}

describe('requestChannelBreak', () => {
  it('sends an RFC 4335 break with its length and want-reply set', async () => {
    const { shell, requests } = await openShell('accept');

    await expect(requestChannelBreak(shell, 250)).resolves.toBe('accepted');
    expect(requests).toEqual([{ wantReply: true, data: Buffer.from([0, 0, 0x00, 0xfa]) }]);

    // The session keeps working after the request.
    const echoed = new Promise<string>((resolve) => shell.once('data', (chunk: Buffer) => resolve(chunk.toString())));
    shell.write('still here');
    await expect(echoed).resolves.toBe('still here');
  });

  it('reports a server that refuses the request', async () => {
    const { shell, requests } = await openShell('refuse');

    await expect(requestChannelBreak(shell, 1_500)).resolves.toBe('refused');
    expect(requests[0]?.data.readUInt32BE(0)).toBe(1_500);
  });

  it('gives up on a server that never answers', async () => {
    const { shell, requests } = await openShell('ignore');

    await expect(requestChannelBreak(shell, 10, 50)).resolves.toBe('unanswered');
    expect(requests).toHaveLength(1);
  });

  it('refuses to use a channel that has closed', async () => {
    const { shell, requests } = await openShell('accept');
    shell.close();

    await expect(requestChannelBreak(shell, 250)).rejects.toThrow('closed');
    expect(requests).toEqual([]);
  });
});
