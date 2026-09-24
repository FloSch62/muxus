import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseDisplay } from '../../../server/src/x11/display.js';
import { LocalX11 } from '../../../server/src/x11/local-x11.js';
import { BundledXServer, probeX11Server } from '../../../server/src/x11/vcxsrv.js';
import { parseX11Setup, rewriteX11Setup, spliceX11Connection } from '../../../server/src/x11/x11-proxy.js';
import {
  FAMILY_INTERNET,
  FAMILY_INTERNET6,
  FAMILY_LOCAL,
  FAMILY_WILD,
  MIT_MAGIC_COOKIE,
  findXauthCookie,
  parseXauthority,
  serializeXauthority,
  xauthTargetForPeer,
  type XauthEntry,
} from '../../../server/src/x11/xauthority.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-x11-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('parseDisplay', () => {
  it('maps :n to the X11 Unix socket, with the abstract namespace as a Linux fallback', () => {
    expect(parseDisplay(':0', 'linux')).toEqual({
      endpoint: { kind: 'unix', path: '/tmp/.X11-unix/X0', abstract: '\0/tmp/.X11-unix/X0' },
      number: '0',
      screen: 0,
    });
    expect(parseDisplay('unix:1.2', 'darwin')).toEqual({
      endpoint: { kind: 'unix', path: '/tmp/.X11-unix/X1' },
      number: '1',
      screen: 2,
    });
  });

  it('keeps the display suffix in XQuartz launchd socket paths', () => {
    expect(parseDisplay('/private/tmp/com.apple.launchd.AbC/org.xquartz:0', 'darwin')?.endpoint).toEqual({
      kind: 'unix',
      path: '/private/tmp/com.apple.launchd.AbC/org.xquartz:0',
    });
  });

  it('uses TCP 6000+n for host displays and for :n on Windows', () => {
    expect(parseDisplay('localhost:10.0', 'linux')?.endpoint).toEqual({ kind: 'tcp', host: 'localhost', port: 6010 });
    expect(parseDisplay('workstation.example:1', 'linux')?.endpoint).toEqual({
      kind: 'tcp',
      host: 'workstation.example',
      port: 6001,
    });
    expect(parseDisplay('[fd00::5]:2', 'linux')?.endpoint).toEqual({ kind: 'tcp', host: 'fd00::5', port: 6002 });
    expect(parseDisplay(':0.0', 'win32')?.endpoint).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 6000 });
  });

  it('rejects values that are not displays', () => {
    expect(parseDisplay('wayland-0', 'linux')).toBeUndefined();
    expect(parseDisplay('', 'linux')).toBeUndefined();
  });
});

describe('Xauthority', () => {
  const cookie = (byte: number) => Buffer.alloc(16, byte);
  const entry = (patch: Partial<XauthEntry>): XauthEntry => ({
    family: FAMILY_LOCAL,
    address: Buffer.from('workstation'),
    number: '0',
    name: MIT_MAGIC_COOKIE,
    data: cookie(1),
    ...patch,
  });

  it('round-trips the libXau record format', () => {
    const entries = [entry({}), entry({ family: FAMILY_WILD, address: Buffer.alloc(0), number: '10', data: cookie(2) })];
    expect(parseXauthority(serializeXauthority(entries))).toEqual(entries);
  });

  it('ignores a truncated trailing record', () => {
    const buf = serializeXauthority([entry({})]);
    expect(parseXauthority(Buffer.concat([buf, buf.subarray(0, 9)]))).toHaveLength(1);
  });

  it('picks the record Xlib would use for a display', () => {
    const entries = [
      entry({ address: Buffer.from('other-host'), data: cookie(9) }),
      entry({ number: '1', data: cookie(8) }),
      entry({ data: cookie(1) }),
      entry({ family: FAMILY_INTERNET, address: Buffer.from([10, 0, 0, 5]), data: cookie(3) }),
      entry({ family: FAMILY_INTERNET6, address: ipv6('fd00::5'), data: cookie(6) }),
    ];
    expect(findXauthCookie(entries, '0', { local: true }, 'workstation.example.com')?.data).toEqual(cookie(1));
    expect(findXauthCookie(entries, '1', { local: true }, 'workstation')?.data).toEqual(cookie(8));
    expect(findXauthCookie(entries, '0', xauthTargetForPeer('10.0.0.5'), 'workstation')?.data).toEqual(cookie(3));
    expect(findXauthCookie(entries, '0', xauthTargetForPeer('fd00::5'), 'workstation')?.data).toEqual(cookie(6));
    expect(findXauthCookie(entries, '2', { local: true }, 'workstation')).toBeUndefined();
    expect(
      findXauthCookie([entry({ family: FAMILY_WILD, number: '', data: cookie(4) })], '7', { local: true }, 'x')?.data,
    ).toEqual(cookie(4));
  });

  it('derives the record address from the connected peer, as libxcb does', () => {
    expect(xauthTargetForPeer('127.0.0.1')).toEqual({ local: true });
    expect(xauthTargetForPeer('::1')).toEqual({ local: true });
    expect(xauthTargetForPeer('::ffff:127.0.0.1')).toEqual({ local: true });
    expect(xauthTargetForPeer('192.168.1.20')).toEqual({
      local: false,
      family: FAMILY_INTERNET,
      address: Buffer.from([192, 168, 1, 20]),
    });
    expect(xauthTargetForPeer('::ffff:192.168.1.20')).toEqual({
      local: false,
      family: FAMILY_INTERNET,
      address: Buffer.from([192, 168, 1, 20]),
    });
    expect(xauthTargetForPeer('fe80::1:2%eth0')).toEqual({
      local: false,
      family: FAMILY_INTERNET6,
      address: ipv6('fe80::1:2'),
    });
    expect(xauthTargetForPeer('2001:db8::10.0.0.1')).toMatchObject({ family: FAMILY_INTERNET6 });
    expect((xauthTargetForPeer('2001:db8::10.0.0.1') as { address: Buffer }).address.subarray(12)).toEqual(
      Buffer.from([10, 0, 0, 1]),
    );
  });
});

/** Expected FamilyInternet6 bytes, built independently of the code under test. */
function ipv6(address: string): Buffer {
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.from(groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  }));
}

/** An X11 connection setup request as a client would send it. */
function setupRequest(littleEndian: boolean, name: string, data: Buffer): Buffer {
  const header = Buffer.from([littleEndian ? 0x6c : 0x42, 0, 0, 0, 0, 0]);
  if (littleEndian) header.writeUInt16LE(11, 2);
  else header.writeUInt16BE(11, 2);
  return rewriteX11Setup(Buffer.concat([header, Buffer.alloc(6)]), littleEndian, { name, data });
}

describe('X11 setup rewriting', () => {
  it('parses and rebuilds setup requests in both byte orders', () => {
    for (const littleEndian of [true, false]) {
      const request = setupRequest(littleEndian, MIT_MAGIC_COOKIE, Buffer.alloc(16, 7));
      expect(request).toHaveLength(12 + 20 + 16);
      const parsed = parseX11Setup(request);
      expect(parsed).toEqual({
        kind: 'complete',
        littleEndian,
        authName: MIT_MAGIC_COOKIE,
        authData: Buffer.alloc(16, 7),
        length: request.length,
      });
      const stripped = rewriteX11Setup(request, littleEndian);
      expect(stripped).toHaveLength(12);
      expect(stripped.subarray(0, 6)).toEqual(request.subarray(0, 6));
      expect(parseX11Setup(stripped)).toMatchObject({ kind: 'complete', authName: '', authData: Buffer.alloc(0) });
    }
  });

  it('waits for a complete request and rejects non-X11 data', () => {
    const request = setupRequest(true, MIT_MAGIC_COOKIE, Buffer.alloc(16));
    expect(parseX11Setup(request.subarray(0, 20))).toEqual({ kind: 'incomplete' });
    expect(parseX11Setup(Buffer.from('GET / HTTP/1.1\r\n'))).toEqual({ kind: 'invalid' });
  });
});

/** Two connected in-memory duplex endpoints. */
function duplexPair(): [Duplex, Duplex] {
  const a = new Duplex({ read() {}, write(chunk, _enc, done) { b.push(chunk); done(); }, final(done) { b.push(null); done(); } });
  const b = new Duplex({ read() {}, write(chunk, _enc, done) { a.push(chunk); done(); }, final(done) { a.push(null); done(); } });
  return [a, b];
}

function nextChunk(stream: Duplex): Promise<Buffer> {
  return new Promise((resolve) => stream.once('data', (chunk: Buffer) => resolve(chunk)));
}

describe('spliceX11Connection', () => {
  const fake = Buffer.alloc(16, 0xaa);
  const real = { name: MIT_MAGIC_COOKIE, data: Buffer.alloc(16, 0x55) };

  it('swaps the fake cookie for the real one and then relays both ways', async () => {
    const [remote, remoteClient] = duplexPair();
    const [local, xServer] = duplexPair();
    spliceX11Connection(remote, local, { cookie: fake, auth: real });

    const firstRequest = Buffer.from([1, 2, 3, 4]);
    const received = nextChunk(xServer);
    // The setup and the first request may arrive split across channel packets.
    const setup = Buffer.concat([setupRequest(true, MIT_MAGIC_COOKIE, fake), firstRequest]);
    remoteClient.write(setup.subarray(0, 10));
    remoteClient.write(setup.subarray(10));
    const forwarded = await received;
    const parsed = parseX11Setup(forwarded);
    expect(parsed).toMatchObject({ kind: 'complete', authName: MIT_MAGIC_COOKIE, authData: real.data });

    const reply = nextChunk(remoteClient);
    xServer.write(Buffer.from('reply'));
    expect((await reply).toString()).toBe('reply');
  });

  it('closes both sides when the remote presents the wrong cookie', async () => {
    const [remote, remoteClient] = duplexPair();
    const [local, xServer] = duplexPair();
    const onRejected = vi.fn();
    const xServerData = vi.fn();
    xServer.on('data', xServerData);
    spliceX11Connection(remote, local, { cookie: fake, auth: real, onRejected });

    remoteClient.write(setupRequest(false, MIT_MAGIC_COOKIE, Buffer.alloc(16, 0xab)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onRejected).toHaveBeenCalledWith('wrong X11 authentication cookie');
    expect(remote.destroyed).toBe(true);
    expect(local.destroyed).toBe(true);
    expect(xServerData).not.toHaveBeenCalled();
  });
});

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

describe('BundledXServer', () => {
  /**
   * `busyPorts` are taken before the scan; `racedPorts` are grabbed by some
   * other X server between the scan and VcXsrv binding them.
   */
  function fixture(busyPorts: number[], racedPorts: number[] = []) {
    const directory = mkdtempSync(path.join(tmp, 'vcxsrv-'));
    writeFileSync(path.join(directory, 'vcxsrv.exe'), '');
    const listening = new Set(busyPorts);
    const raced = new Set(racedPorts);
    const spawns: Array<{ executable: string; args: string[]; child: FakeChild }> = [];
    const server = new BundledXServer(directory, log, {
      authDirectory: directory,
      portInUse: async (port) => listening.has(port),
      probeServer: async (port) => (raced.has(port) ? 'foreign' : listening.has(port) ? 'ours' : 'down'),
      spawnServer: (executable, args) => {
        const child = new FakeChild();
        spawns.push({ executable, args, child });
        // The server starts listening on its display port shortly after launch.
        setTimeout(() => listening.add(6000 + Number(args[0]!.slice(1))), 5);
        child.once('exit', () => listening.delete(6000 + Number(args[0]!.slice(1))));
        return child as never;
      },
    });
    return { directory, server, spawns };
  }

  it('starts one server on the first free display with a private cookie', async () => {
    const { directory, server, spawns } = fixture([6010, 6011]);
    const [first, second] = await Promise.all([server.ensureRunning(), server.ensureRunning()]);
    expect(first).toBe(second);
    expect(spawns).toHaveLength(1);
    expect(first.display).toBe(12);
    expect(first.port).toBe(6012);
    expect(spawns[0]!.executable).toBe(path.join(directory, 'vcxsrv.exe'));
    const authFile = spawns[0]!.args[spawns[0]!.args.indexOf('-auth') + 1]!;
    expect(spawns[0]!.args).toEqual(
      expect.arrayContaining([':12', '-multiwindow', '-noclipboard', '-silent-dup-error']),
    );
    expect(first.clipboard).toBe(false);
    expect(parseXauthority(readFileSync(authFile))).toEqual([
      { family: FAMILY_WILD, address: Buffer.alloc(0), number: '12', name: MIT_MAGIC_COOKIE, data: first.auth.data },
    ]);
    server.close();
    expect(spawns[0]!.child.killed).toBe(true);
  });

  it('starts a fresh server after the previous one exits', async () => {
    const { server, spawns } = fixture([]);
    const first = await server.ensureRunning();
    spawns[0]!.child.emit('exit', 0, null);
    const second = await server.ensureRunning();
    expect(spawns).toHaveLength(2);
    expect(second.auth.data.equals(first.auth.data)).toBe(false);
    server.close();
  });

  it('switches clipboard sharing only while no forwarded windows are open', async () => {
    const { server, spawns } = fixture([]);
    const plain = await server.ensureRunning(false);

    // Windows are open: keep the running server rather than closing them.
    expect(await server.ensureRunning(true, false)).toBe(plain);
    expect(spawns).toHaveLength(1);

    const shared = await server.ensureRunning(true, true);
    expect(spawns).toHaveLength(2);
    expect(spawns[0]!.child.killed).toBe(true);
    expect(spawns[1]!.args).toContain('-clipboard');
    expect(shared.clipboard).toBe(true);
    expect(await server.ensureRunning(true, true)).toBe(shared);
    server.close();
  });

  it('probes readiness with an authenticated X11 connection setup', async () => {
    const cookie = { name: MIT_MAGIC_COOKIE, data: Buffer.alloc(16, 0x11) };
    // A stand-in X server that answers Success (1) only for this cookie.
    const xServer = net.createServer((socket) =>
      socket.once('data', (chunk: Buffer) => {
        const setup = parseX11Setup(chunk);
        socket.end(Buffer.from([setup.kind === 'complete' && setup.authData.equals(cookie.data) ? 1 : 0]));
      }),
    );
    await new Promise<void>((resolve) => xServer.listen(0, '127.0.0.1', resolve));
    const port = (xServer.address() as net.AddressInfo).port;
    try {
      expect(await probeX11Server(port, cookie)).toBe('ours');
      expect(await probeX11Server(port, { ...cookie, data: Buffer.alloc(16) })).toBe('foreign');
    } finally {
      await new Promise((resolve) => xServer.close(resolve));
    }
    expect(await probeX11Server(port, cookie)).toBe('down');
  });

  it('moves to the next display when another X server wins the race for it', async () => {
    const { server, spawns } = fixture([], [6010]);
    const running = await server.ensureRunning();
    expect(running.display).toBe(11);
    expect(spawns.map((spawn) => spawn.args[0])).toEqual([':10', ':11']);
    expect(spawns[0]!.child.killed).toBe(true);
    // The loser's exit must not reset the start that is still in progress.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await server.ensureRunning()).toBe(running);
    expect(spawns).toHaveLength(2);
    server.close();
  });

  it('reports a server that exits during startup', async () => {
    const directory = mkdtempSync(path.join(tmp, 'vcxsrv-'));
    writeFileSync(path.join(directory, 'vcxsrv.exe'), '');
    const server = new BundledXServer(directory, log, {
      authDirectory: directory,
      portInUse: async () => false,
      probeServer: async () => 'down',
      spawnServer: () => {
        const child = new FakeChild();
        setTimeout(() => child.emit('exit', 1, null), 5);
        return child as never;
      },
    });
    await expect(server.ensureRunning()).rejects.toThrow(/failed to start \(exited with code 1\)/);
    server.close();
  });
});

describe('LocalX11', () => {
  it('forwards by default only with the bundled server', () => {
    const directory = mkdtempSync(path.join(tmp, 'bundled-'));
    writeFileSync(path.join(directory, 'vcxsrv.exe'), '');
    const bundled = new LocalX11({ log, bundledServerDirectory: directory, env: { DISPLAY: ':0' }, platform: 'win32' });
    expect(bundled.availability()).toEqual({ source: 'bundled', defaultEnabled: true });
    expect(bundled.wanted(undefined)).toBe(true);
    expect(bundled.wanted(false)).toBe(false);

    const display = new LocalX11({ log, env: { DISPLAY: ':0.1' }, platform: 'linux' });
    expect(display.availability()).toEqual({ source: 'display', defaultEnabled: false, display: ':0.1' });
    expect(display.wanted(undefined)).toBe(false);
    expect(display.wanted(true)).toBe(true);
    expect(display.screen()).toBe(1);

    const none = new LocalX11({ log, bundledServerDirectory: path.join(tmp, 'missing'), env: {}, platform: 'win32' });
    expect(none.availability()).toEqual({ source: 'none', defaultEnabled: false });
    expect(none.wanted(true)).toBe(false);
    expect(none.missingServerMessage()).toMatch(/no bundled X server/);
  });

  it('gives every SSH transport its own bundled display', async () => {
    const directory = mkdtempSync(path.join(tmp, 'bundled-'));
    writeFileSync(path.join(directory, 'vcxsrv.exe'), '');
    const listening = new Set<number>();
    const children: FakeChild[] = [];
    const x11 = new LocalX11({
      log,
      bundledServerDirectory: directory,
      env: {},
      platform: 'win32',
      bundled: {
        authDirectory: directory,
        portInUse: async (port) => listening.has(port),
        probeServer: async (port) => (listening.has(port) ? 'ours' : 'down'),
        spawnServer: (_executable, args) => {
          const child = new FakeChild();
          const port = 6000 + Number(args[0]!.slice(1));
          children.push(child);
          setTimeout(() => listening.add(port), 5);
          child.once('exit', () => listening.delete(port));
          return child as never;
        },
      },
    });
    const hostA = {};
    const hostB = {};

    // Concurrent first windows from two hosts must not end up on one display.
    const [a, b] = await Promise.all([x11.bundledServer(hostA), x11.bundledServer(hostB)]);
    expect(a.display).not.toBe(b.display);
    expect(a.auth.data.equals(b.auth.data)).toBe(false);
    expect(await x11.bundledServer(hostA)).toBe(a);

    // A closed transport takes its display down; the others keep theirs.
    x11.release(hostA);
    expect(children[0]!.killed).toBe(true);
    expect(children[1]!.killed).toBe(false);
    expect(await x11.bundledServer(hostB)).toBe(b);
    x11.close();
    expect(children[1]!.killed).toBe(true);
  });

  it('connects to $DISPLAY with the cookie from XAUTHORITY', async () => {
    const socketDir = mkdtempSync(path.join(tmp, 'display-'));
    const socketPath = path.join(socketDir, 'xsock:3');
    const xauthority = path.join(socketDir, 'Xauthority');
    writeFileSync(
      xauthority,
      serializeXauthority([
        { family: FAMILY_WILD, address: Buffer.alloc(0), number: '3', name: MIT_MAGIC_COOKIE, data: Buffer.alloc(16, 3) },
      ]),
    );
    const accepted = new Promise<net.Socket>((resolve) => {
      const server = net.createServer((socket) => {
        server.close();
        resolve(socket);
      });
      server.listen(socketPath);
    });
    const x11 = new LocalX11({
      log,
      env: { DISPLAY: `${path.join(socketDir, 'xsock')}:3`, XAUTHORITY: xauthority },
      platform: 'linux',
    });
    const { socket, auth } = await x11.connect();
    (await accepted).destroy();
    socket.destroy();
    expect(auth).toEqual({ name: MIT_MAGIC_COOKIE, data: Buffer.alloc(16, 3) });
  });
});
