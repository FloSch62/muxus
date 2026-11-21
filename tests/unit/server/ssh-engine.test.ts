import { generateKeyPairSync } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { Server, type Connection, type ServerChannel, type Session } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { SshError, SshTransport, type SshChannel } from '../../../server/src/ssh/engine.js';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** An sshd stand-in that lets everyone in; `onSession` plays the server side of each session. */
async function startServer(onSession: (session: Session, connection: Connection) => void) {
  const connections = new Set<Connection>();
  const server = new Server({ hostKeys: [HOST_KEY] }, (connection) => {
    connections.add(connection);
    connection.on('error', () => undefined);
    connection.on('authentication', (ctx) => ctx.accept());
    connection.on('ready', () => {
      connection.on('session', (accept) => onSession(accept(), connection));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    for (const connection of connections) connection.end();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

async function connect(port: number): Promise<SshTransport> {
  const transport = new SshTransport({ host: '127.0.0.1', port, verifyHostKey: async () => true });
  closers.push(() => transport.close());
  await transport.connect();
  expect((await transport.authNone('tester')).success).toBe(true);
  return transport;
}

function finished(channel: SshChannel): Promise<{ events: string[]; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const events: string[] = [];
    let stdout = '';
    let stderr = '';
    channel.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    channel.on('exit', (code: number | null, signal?: string) => events.push(`exit ${code ?? signal}`));
    channel.on('end', () => events.push('end'));
    channel.on('close', () => {
      events.push('close');
      resolve({ events, stdout, stderr });
    });
  });
}

describe('the SSH engine', () => {
  it('delivers output, error output and the exit status, then ends and closes the channel', async () => {
    const port = await startServer((session) => {
      session.on('exec', (accept, _reject, info) => {
        const channel = accept();
        channel.write(`ran ${info.command}\n`);
        channel.stderr.write('a complaint\n');
        channel.on('data', (chunk: Buffer) => channel.write(`heard ${chunk.toString()}`));
        channel.on('end', () => {
          channel.exit(7);
          channel.end();
        });
      });
    });
    const transport = await connect(port);
    const channel = await transport.exec('the-command');
    const done = finished(channel);
    channel.end('input');
    expect(await done).toEqual({
      events: ['exit 7', 'end', 'close'],
      stdout: 'ran the-command\nheard input',
      stderr: 'a complaint\n',
    });
  });

  it('names what the server refused', async () => {
    const port = await startServer((session) => {
      session.on('pty', (_accept, reject) => reject());
      session.on('exec', (_accept, reject) => reject());
      session.on('shell', (_accept, reject) => reject());
      session.on('subsystem', (_accept, reject) => reject());
    });
    const transport = await connect(port);
    const refusal = (attempt: Promise<unknown>) => attempt.then(() => 'accepted', (err: SshError) => err.code);
    expect(await refusal(transport.exec('anything'))).toBe('EXEC_REFUSED');
    expect(await refusal(transport.shell())).toBe('SHELL_REFUSED');
    expect(await refusal(transport.subsystem('netconf'))).toBe('SUBSYSTEM_REFUSED');
    expect(await refusal(transport.shell({ pty: { term: 'xterm', cols: 80, rows: 24 } }))).toBe('PTY_REFUSED');
    // A target the server will not dial: its reason number travels with the error.
    const refused = await transport.openTcp('192.0.2.1', 9).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(SshError);
    expect(refused).toMatchObject({ code: 'CHANNEL_OPEN_FAILED' });
    expect((refused as SshError).detail).toBeGreaterThan(0);
    // The connection took no harm from any of it.
    expect(transport.closed).toBe(false);
  });

  it('keeps the connection moving when a channel is closed while the server floods it', async () => {
    const flooding = new Set<ServerChannel>();
    const port = await startServer((session) => {
      session.on('exec', (accept, _reject, info) => {
        const channel = accept();
        if (info.command !== 'flood') {
          channel.write('answered');
          channel.exit(0);
          channel.end();
          return;
        }
        // Far more than any buffer on the way holds, and nobody reads it.
        flooding.add(channel);
        const block = Buffer.alloc(64 * 1024, 0x61);
        const pour = () => {
          while (flooding.has(channel) && channel.write(block));
        };
        channel.on('drain', pour);
        channel.on('close', () => flooding.delete(channel));
        pour();
      });
    });
    const transport = await connect(port);
    const flood = await transport.exec('flood');
    // Let it back up, then drop the channel without reading a byte.
    await new Promise((resolve) => setTimeout(resolve, 300));
    flood.destroy();

    const other = await transport.exec('question');
    expect((await finished(other)).stdout).toBe('answered');
  }, 15_000);

  it('closes at once, also while the server has not answered a channel that is being opened', async () => {
    let asked = 0;
    const server = new Server({ hostKeys: [HOST_KEY] }, (connection) => {
      connection.on('error', () => undefined);
      connection.on('authentication', (ctx) => ctx.accept());
      // Neither accepted nor refused: a target the server is still trying to reach.
      connection.on('ready', () => connection.on('tcpip', () => (asked += 1)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => server.close());
    const transport = await connect((server.address() as AddressInfo).port);
    const opening = transport.openTcp('192.0.2.1', 9).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toBe(1);

    const closed = new Promise<void>((resolve) => transport.onClose(() => resolve()));
    const started = Date.now();
    transport.close();
    await closed;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await opening).toMatchObject({ code: 'DISCONNECTED' });
  });

  it('gives up an attempt to connect when it is closed meanwhile', async () => {
    // Takes the connection and never says a word.
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    closers.push(() => silent.close());
    const transport = new SshTransport({
      host: '127.0.0.1',
      port: (silent.address() as AddressInfo).port,
      verifyHostKey: async () => true,
    });
    const attempt = transport.connect().catch((err: unknown) => err);
    setTimeout(() => transport.close(), 100);
    expect(await attempt).toMatchObject({ code: 'ABORTED' });
  });

  it('tells everything on a connection when the server ends it', async () => {
    let serverSide: Connection | undefined;
    const port = await startServer((session, connection) => {
      serverSide = connection;
      session.on('shell', (accept) => accept().write('ready'));
    });
    const transport = await connect(port);
    const channel = await transport.shell();
    const done = finished(channel);
    await new Promise<void>((resolve) => channel.once('data', () => resolve()));
    const closed = new Promise<void>((resolve) => transport.onClose(() => resolve()));
    serverSide!.end();
    await closed;
    expect(transport.closed).toBe(true);
    // The channel ends too, without an exit status: nothing ran to its end.
    expect((await done).events).toEqual(['end', 'close']);
    await expect(transport.exec('late')).rejects.toMatchObject({ code: 'DISCONNECTED' });
    // A listener that comes late still hears about it.
    await new Promise<void>((resolve) => transport.onClose(() => resolve()));
  });
});
