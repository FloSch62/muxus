import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, type ServerChannel, type X11Info } from 'ssh2';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import { SshConnectionManager, type ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { KnownHostsStore } from '../../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';
import { LocalX11 } from '../../../server/src/x11/local-x11.js';
import { parseX11Setup, rewriteX11Setup } from '../../../server/src/x11/x11-proxy.js';
import { FAMILY_WILD, MIT_MAGIC_COOKIE, serializeXauthority } from '../../../server/src/x11/xauthority.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-x11fwd-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'secret';
const REAL_COOKIE = Buffer.alloc(16, 0x42);
const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

interface X11Capture {
  requests: X11Info[];
  /** What the remote X client got back through the forwarded channel. */
  reply: Promise<string>;
}

/**
 * sshd stand-in: accepts or refuses x11-req, and once a shell starts opens an
 * X11 channel back to the client like a remote X program would, presenting
 * the cookie from the x11-req.
 */
function startServer(acceptX11: boolean): Promise<{ server: Server; port: number; capture: X11Capture }> {
  let resolveReply: (reply: string) => void = () => undefined;
  const capture: X11Capture = {
    requests: [],
    reply: new Promise((resolve) => (resolveReply = resolve)),
  };
  const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (authCtx) => {
      if (authCtx.method === 'password' && authCtx.password === PASSWORD) authCtx.accept();
      else authCtx.reject(['password']);
    });
    conn.on('ready', () => {
      conn.on('session', (acceptSession) => {
        const session = acceptSession();
        let x11: X11Info | undefined;
        session.on('x11', (accept, reject, info) => {
          capture.requests.push(info);
          if (!acceptX11) {
            reject?.();
            return;
          }
          x11 = info;
          accept?.();
        });
        session.on('shell', (acceptShell) => {
          const shell: ServerChannel = acceptShell();
          shell.write('shell ok\n');
          if (!x11) return;
          const request = x11;
          conn.x11('127.0.0.1', 41000, (err, channel) => {
            if (err) {
              resolveReply(`channel refused: ${err.message}`);
              return;
            }
            let reply = '';
            channel.on('data', (chunk: Buffer) => {
              reply += chunk.toString();
              resolveReply(reply);
            });
            const header = Buffer.from([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            // Like sshd hands it to xauth: the x11-req cookie is hex text.
            channel.write(
              rewriteX11Setup(header, true, {
                name: request.protocol,
                data: Buffer.from(String(request.cookie), 'hex'),
              }),
            );
          });
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, capture });
    });
  });
}

/** Local X server stand-in on a socket path, answering once it sees a setup request. */
function startXServer(): Promise<{ display: string; xauthority: string; setups: Buffer[]; close(): void }> {
  const dir = mkdtempSync(path.join(tmp, 'x-'));
  const xauthority = path.join(dir, 'Xauthority');
  writeFileSync(
    xauthority,
    serializeXauthority([
      { family: FAMILY_WILD, address: Buffer.alloc(0), number: '7', name: MIT_MAGIC_COOKIE, data: REAL_COOKIE },
    ]),
  );
  const setups: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.once('data', (chunk: Buffer) => {
      setups.push(chunk);
      socket.write('X11 ready');
    });
  });
  return new Promise((resolve) => {
    server.listen(path.join(dir, 'xsock:7'), () => {
      resolve({
        display: `${path.join(dir, 'xsock')}:7`,
        xauthority,
        setups,
        close: () => server.close(),
      });
    });
  });
}

let counter = 0;
function makeManager(port: number, lines: string[], x11: LocalX11): SshConnectionManager {
  const configFile = path.join(tmp, `ssh_config-${counter++}`);
  writeFileSync(
    configFile,
    [
      'Host lab',
      '  HostName 127.0.0.1',
      '  User tester',
      `  Port ${port}`,
      '  PubkeyAuthentication no',
      // A plain shell: no pty, so no shell-integration probe.
      '  RequestTTY no',
      ...lines,
      '',
    ].join('\n'),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new SshConnectionManager(log as never, {
    knownHosts: new KnownHostsStore(path.join(tmp, `known_hosts-${counter++}`), path.join(tmp, 'no-global')),
    loadConfig: () => loadConfigDocument(configFile),
    x11,
  });
}

function makeIo(statuses: string[]): ConnectIo {
  return {
    status: (message, options) => {
      if (!options?.transient) statuses.push(message);
    },
    prompt: (info) => Promise.resolve({ answers: info.prompts.map(() => PASSWORD) }),
    hostKey: () => Promise.resolve(true),
  };
}

function firstData(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => stream.once('data', (chunk: Buffer) => resolve(chunk.toString())));
}

const profile: SshProfile = { kind: 'ssh', target: 'lab' };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('X11 forwarding over SSH', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(acceptX11: boolean, lines: string[], platform: NodeJS.Platform = 'linux') {
    const ssh = await startServer(acceptX11);
    cleanups.push(() => new Promise<void>((resolve) => ssh.server.close(() => resolve())));
    const xServer = await startXServer();
    cleanups.push(() => xServer.close());
    const x11 = new LocalX11({
      log,
      env: { DISPLAY: xServer.display, XAUTHORITY: xServer.xauthority },
      platform,
    });
    const manager = makeManager(ssh.port, lines, x11);
    cleanups.push(() => manager.closeAll());
    return { ssh, xServer, manager, x11 };
  }

  it('relays remote X clients to the local display with the real cookie', async () => {
    const { ssh, xServer, manager, x11 } = await setup(true, ['  ForwardX11 yes']);
    const release = vi.spyOn(x11, 'release');
    const statuses: string[] = [];
    const shell = await manager.connectShell(profile, makeIo(statuses), 80, 24, 'xterm');
    expect(await firstData(shell.stream)).toContain('shell ok');

    expect(await ssh.capture.reply).toBe('X11 ready');
    expect(ssh.capture.requests).toHaveLength(1);
    const request = ssh.capture.requests[0]!;
    expect(request.protocol).toBe(MIT_MAGIC_COOKIE);
    // The server only ever sees a fake cookie.
    expect(String(request.cookie)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(request.cookie)).not.toBe(REAL_COOKIE.toString('hex'));
    expect(parseX11Setup(xServer.setups[0]!)).toMatchObject({
      kind: 'complete',
      authName: MIT_MAGIC_COOKIE,
      authData: REAL_COOKIE,
    });
    expect(statuses).toEqual([]);
    shell.stream.close();
    shell.lease.release();

    // The transport's own X display goes away with it.
    manager.closeAll();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it('stays silent while X11 is switched off, as on macOS by default', async () => {
    const { ssh, manager } = await setup(true, ['  ForwardX11 yes'], 'darwin');
    const statuses: string[] = [];
    const shell = await manager.connectShell(profile, makeIo(statuses), 80, 24, 'xterm');
    expect(await firstData(shell.stream)).toContain('shell ok');
    expect(ssh.capture.requests).toHaveLength(0);
    expect(statuses).toEqual([]);
    shell.stream.close();
    shell.lease.release();
  });

  it('keeps X11 off by default when forwarding would reach the user desktop', async () => {
    const { ssh, manager } = await setup(true, []);
    const shell = await manager.connectShell(profile, makeIo([]), 80, 24, 'xterm');
    expect(await firstData(shell.stream)).toContain('shell ok');
    expect(ssh.capture.requests).toHaveLength(0);
    shell.stream.close();
    shell.lease.release();
  });

  it('opens the session anyway when the server refuses X11, and stops asking', async () => {
    const { ssh, manager } = await setup(false, ['  ForwardX11 yes']);
    const statuses: string[] = [];
    const first = await manager.connectShell(profile, makeIo(statuses), 80, 24, 'xterm');
    expect(await firstData(first.stream)).toContain('shell ok');
    expect(statuses).toEqual([expect.stringContaining('refused X11 forwarding')]);

    // A second pane on the shared transport does not repeat the refused request.
    const second = await manager.connectShell(profile, makeIo([]), 80, 24, 'xterm');
    expect(await firstData(second.stream)).toContain('shell ok');
    expect(second.transport).toBe('shared');
    expect(ssh.capture.requests).toHaveLength(1);
    for (const shell of [first, second]) {
      shell.stream.close();
      shell.lease.release();
    }
  });
});
