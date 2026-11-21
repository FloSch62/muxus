import { createHash } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForwardManager } from '../../server/src/forwards/forward-manager.js';
import { finished, fixture, inContainer, recordingIo, ssh, useScratchHome } from './harness.js';

const ALICE = ['User alice', 'IdentitiesOnly yes', `IdentityFile ${fixture('id_ed25519')}`];

function get(port: number, path = '/'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Fetch a page through a SOCKS5 proxy, naming the host for the far side to resolve. */
function getThroughSocks(proxyPort: number, host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(Buffer.from([5, 1, 0])));
    let stage: 'greeting' | 'request' | 'page' = 'greeting';
    let received = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (stage === 'greeting' && received.length >= 2) {
        stage = 'request';
        received = received.subarray(2);
        const name = Buffer.from(host);
        const target = Buffer.alloc(2);
        target.writeUInt16BE(port);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, target]));
      }
      if (stage === 'request' && received.length >= 10) {
        if (received[1] !== 0) return reject(new Error(`SOCKS reply ${received[1]}`));
        stage = 'page';
        received = received.subarray(10);
        socket.write('GET / HTTP/1.0\r\n\r\n');
      }
    });
    socket.on('close', () => resolve(received.toString().split('\r\n\r\n')[1] ?? ''));
    socket.on('error', reject);
  });
}

describe('port forwards through OpenSSH', () => {
  const home = useScratchHome();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let forwards: ForwardManager | undefined;
  afterEach(() => {
    forwards?.stopAll();
    forwards = undefined;
    log.warn.mockClear();
  });

  async function connected(hosts: Record<string, string[]> = { box: ALICE }, answers: string[][] = []) {
    const manager = home.manager(hosts);
    forwards = new ForwardManager(manager, log as never);
    const lease = await manager.connect(ssh('box'), recordingIo(answers).io);
    return { lease, forwards, connId: lease.connection.id };
  }

  it('carries a local forward to a service only the server can reach', async () => {
    const { lease, forwards, connId } = await connected();
    const info = await forwards.start({ connId, type: 'local', bindPort: 0, targetHost: '127.0.0.1', targetPort: 8080 });
    expect(info.bindPort).toBeGreaterThan(0);
    expect((await get(info.bindPort)).toString()).toBe('muxus-openssh-web-ok\n');

    // Stopped, nothing listens there any more.
    forwards.stop(info.id);
    await expect(get(info.bindPort)).rejects.toThrow();
    lease.release();
  });

  it('carries a large download through a local forward intact', async () => {
    inContainer('sh', '-c', 'head -c 40000000 /dev/urandom > /srv/www/large.bin');
    const expected = inContainer('sha256sum', '/srv/www/large.bin').split(' ')[0];
    const { lease, forwards, connId } = await connected();
    const info = await forwards.start({ connId, type: 'local', bindPort: 0, targetHost: '127.0.0.1', targetPort: 8080 });
    const body = await get(info.bindPort, '/large.bin');
    expect(body.length).toBe(40_000_000);
    expect(createHash('sha256').update(body).digest('hex')).toBe(expected);
    lease.release();
  });

  it('serves SOCKS5 on a dynamic forward, with names resolved on the far side', async () => {
    const { lease, forwards, connId } = await connected();
    const info = await forwards.start({ connId, type: 'dynamic', bindPort: 0 });
    expect(await getThroughSocks(info.bindPort, 'localhost', 8080)).toBe('muxus-openssh-web-ok\n');
    // A target nobody listens on is refused in SOCKS terms, not left hanging.
    await expect(getThroughSocks(info.bindPort, 'localhost', 1)).rejects.toThrow('SOCKS reply 5');
    lease.release();
  });

  it('carries a remote forward back to a service on this side', async () => {
    const local = http.createServer((_request, response) => response.end('from-this-side'));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const { lease, forwards, connId } = await connected();
    try {
      const info = await forwards.start({
        connId,
        type: 'remote',
        bindPort: 0,
        targetHost: '127.0.0.1',
        targetPort: (local.address() as AddressInfo).port,
      });
      // The server picked the port, and the forward says which.
      expect(info.bindPort).toBeGreaterThan(0);
      const fetched = await finished(
        await lease.connection.transport.exec(`curl -s http://127.0.0.1:${info.bindPort}/`),
      );
      expect(fetched.stdout).toBe('from-this-side');

      forwards.stop(info.id);
      await vi.waitFor(
        async () => {
          const after = await finished(
            await lease.connection.transport.exec(`curl -s -m 2 http://127.0.0.1:${info.bindPort}/; echo "code $?"`),
          );
          expect(after.stdout).toMatch(/code [1-9]/);
        },
        { timeout: 10_000, interval: 250 },
      );
    } finally {
      local.close();
      lease.release();
    }
  });

  it('drops the clients of a forward the server will not carry, and refuses a remote one outright', async () => {
    const { lease, forwards, connId } = await connected({ box: ['User nofwd', ...ALICE.slice(1)] });
    const info = await forwards.start({ connId, type: 'local', bindPort: 0, targetHost: '127.0.0.1', targetPort: 8080 });
    await expect(get(info.bindPort)).rejects.toThrow();
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        { err: expect.stringMatching(/administratively prohibited/), forward: info.id },
        'forwardOut failed',
      ),
    );
    await expect(
      forwards.start({ connId, type: 'remote', bindPort: 0, targetHost: '127.0.0.1', targetPort: 9 }),
    ).rejects.toThrow(/remote bind failed/);
    lease.release();
  });

  it('closes a tunnel whose client stops reading, so the other channels keep working', async () => {
    inContainer('sh', '-c', 'test -f /srv/www/large.bin || head -c 40000000 /dev/urandom > /srv/www/large.bin');
    const { lease, forwards, connId } = await connected();
    const info = await forwards.start({ connId, type: 'local', bindPort: 0, targetHost: '127.0.0.1', targetPort: 8080 });

    // A client that asks for a large file and then never reads a byte of it.
    const stalled = net.connect(info.bindPort, '127.0.0.1');
    await new Promise<void>((resolve) => stalled.once('connect', () => resolve()));
    stalled.pause();
    stalled.write('GET /large.bin HTTP/1.0\r\n\r\n');
    const dropped = new Promise<void>((resolve) => {
      stalled.once('close', () => resolve());
      stalled.once('error', () => undefined);
    });

    // Give the download time to back up behind the client.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const started = Date.now();
    const answer = await finished(await lease.connection.transport.exec('echo still-answering'));
    expect(answer.stdout).toBe('still-answering\n');
    // The tunnel is given ten seconds; the connection is not held longer than that.
    expect(Date.now() - started).toBeLessThan(20_000);
    stalled.resume();
    await dropped;
    lease.release();
  }, 60_000);
});
