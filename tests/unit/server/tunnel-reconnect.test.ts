import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, type Connection } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TunnelRecord } from '@muxus/shared';
import { ForwardManager } from '../../../server/src/forwards/forward-manager.js';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-tunnel-reconnect-'));
const emptyConfig = path.join(tmp, 'ssh_config');
writeFileSync(emptyConfig, '');

const savedEnv = { HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
beforeAll(() => {
  // No real agent and no real ~/.ssh keys take part in the dial.
  process.env.HOME = tmp;
  delete process.env.SSH_AUTH_SOCK;
});
afterAll(() => {
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.SSH_AUTH_SOCK !== undefined) process.env.SSH_AUTH_SOCK = savedEnv.SSH_AUTH_SOCK;
  rmSync(tmp, { recursive: true, force: true });
});

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const PASSWORD = 'secret';

/** sshd stand-in that serves direct-tcpip channels; `drop()` cuts every client. */
function startSshd(auth: 'none' | 'password') {
  const clients = new Set<Connection>();
  let connections = 0;
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    connections += 1;
    clients.add(conn);
    conn.on('close', () => clients.delete(conn));
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (auth === 'none' || (ctx.method === 'password' && ctx.password === PASSWORD)) ctx.accept();
      else ctx.reject(['password']);
    });
    conn.on('ready', () => {
      conn.on('tcpip', (accept, _reject, info) => {
        const stream = accept();
        const socket = net.connect(info.destPort, info.destIP);
        stream.pipe(socket).pipe(stream);
        socket.on('error', () => stream.close());
        stream.on('close', () => socket.destroy());
      });
    });
  });
  return new Promise<{ server: Server; port: number; connections: () => number; drop: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as net.AddressInfo).port,
        connections: () => connections,
        drop: () => {
          for (const client of clients) client.end();
        },
      });
    });
  });
}

function startEcho(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => socket.pipe(socket));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Round-trip a line through the forwarded local port. */
function echoThrough(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (data) => {
      resolve(data.toString('utf8'));
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

let knownHostsCounter = 0;

const interactiveIo: ConnectIo = {
  status: () => undefined,
  prompt: (info) => Promise.resolve({ answers: info.prompts.map(() => PASSWORD) }),
  hostKey: () => Promise.resolve(true),
};

describe('tunnel auto-reconnect over a real SSH transport', () => {
  const closers: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  /** Servers, managers and a saved tunnel, with nothing dialed yet. */
  async function prepare(auth: 'none' | 'password') {
    const sshd = await startSshd(auth);
    const echo = await startEcho();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const connections = new SshConnectionManager(log as never, {
      knownHosts: new KnownHostsStore(path.join(tmp, `known_hosts-${knownHostsCounter++}`), path.join(tmp, 'no-global')),
      loadConfig: () => loadConfigDocument(emptyConfig),
    });
    const bindPort = await freePort();
    const tunnel: TunnelRecord = {
      id: 'tunnel-1',
      target: '127.0.0.1',
      sshOptions: { user: 'tester', port: sshd.port },
      type: 'local',
      bindPort,
      targetHost: '127.0.0.1',
      targetPort: echo.port,
      autoStart: true,
      autoReconnect: true,
      createdAt: '2026-10-08T00:00:00Z',
      updatedAt: '2026-10-08T00:00:00Z',
    };
    const forwards = new ForwardManager(connections, log as never, {
      tunnel: (id) => (id === tunnel.id ? tunnel : undefined),
      reconnectDelaysMs: [20],
    });
    closers.push(
      () => new Promise<void>((resolve) => sshd.server.close(() => resolve())),
      () => new Promise<void>((resolve) => echo.server.close(() => resolve())),
      () => connections.closeAll(),
      () => forwards.stopAll(),
    );

    /** What the forwarding panel does first: dial with prompts (and trust the host key). */
    const dialInteractively = () =>
      connections.connect(
        { kind: 'ssh', target: tunnel.target, useConfig: false, ...tunnel.sshOptions },
        interactiveIo,
        'dial',
      );
    return { sshd, forwards, tunnel, bindPort, dialInteractively };
  }

  /** A running tunnel, started the way the forwarding panel starts one. */
  async function setup(auth: 'none' | 'password') {
    const { sshd, forwards, tunnel, bindPort, dialInteractively } = await prepare(auth);
    const dial = await dialInteractively();
    const started = await forwards.start({
      connId: dial.connection.id,
      tunnelId: tunnel.id,
      type: tunnel.type,
      bindPort: tunnel.bindPort,
      targetHost: tunnel.targetHost,
      targetPort: tunnel.targetPort,
    });
    dial.release();
    return { sshd, forwards, started, bindPort };
  }

  it('starts with Muxus once the host is trusted', async () => {
    const { sshd, forwards, tunnel, bindPort, dialInteractively } = await prepare('none');

    // An unknown host key is never accepted on the user's behalf.
    forwards.autostart([tunnel]);
    expect(forwards.list()[0]?.status).toBe('starting');
    await vi.waitFor(() => expect(forwards.list()[0]?.status).toBe('error'));
    expect(forwards.list()[0]?.error).toMatch(/Sign-in needed/);

    (await dialInteractively()).release();
    forwards.stop(forwards.list()[0]!.id);

    forwards.autostart([tunnel]);
    await vi.waitFor(() => expect(forwards.list()[0]?.status).toBe('active'));
    expect(await echoThrough(bindPort, 'started')).toBe('started');
    // The refused first attempt, the trusting dial and the autostart.
    expect(sshd.connections()).toBe(3);
  });

  it('dials again and carries traffic on the new connection', async () => {
    const { sshd, forwards, started, bindPort } = await setup('none');
    const firstConnId = started.connId;
    expect(await echoThrough(bindPort, 'before')).toBe('before');

    sshd.drop();
    await vi.waitFor(() => expect(forwards.list()[0]?.status).toBe('reconnecting'));
    await vi.waitFor(() => expect(forwards.list()[0]?.status).toBe('active'));

    const [info] = forwards.list();
    expect(info).toMatchObject({ id: started.id, tunnelId: 'tunnel-1' });
    expect(info?.connId).not.toBe(firstConnId);
    expect(sshd.connections()).toBe(2);
    expect(await echoThrough(bindPort, 'after')).toBe('after');
  });

  it('stops and asks for a start when only a password prompt would get back in', async () => {
    const { sshd, forwards, bindPort } = await setup('password');
    expect(await echoThrough(bindPort, 'before')).toBe('before');

    sshd.drop();
    await vi.waitFor(() => expect(forwards.list()[0]?.status).toBe('error'));
    expect(forwards.list()[0]?.error).toMatch(/Sign-in needed/);
    // The listener is down while the tunnel waits for the user.
    await expect(echoThrough(bindPort, 'x')).rejects.toThrow(/ECONNREFUSED/);
  });
});
