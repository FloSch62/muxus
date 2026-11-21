import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LocalX11 } from '../../server/src/x11/local-x11.js';
import { parseX11Setup } from '../../server/src/x11/x11-proxy.js';
import { FAMILY_WILD, MIT_MAGIC_COOKIE, serializeXauthority } from '../../server/src/x11/xauthority.js';
import { finished, fixture, recordingIo, ssh, useScratchHome } from './harness.js';

const ALICE = ['User alice', 'IdentitiesOnly yes', `IdentityFile ${fixture('id_ed25519')}`];
const X11_TCP_BASE = 6000;

describe('X11 forwarding through OpenSSH', () => {
  const home = useScratchHome();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'muxus-openssh-x11-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** An X server stand-in on a display of its own that records what a client first sends. */
  async function localXServer() {
    const received: Buffer[] = [];
    const xServer = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk);
        socket.write('x-server-answers');
      });
      socket.on('error', () => undefined);
    });
    // A display number whose TCP port is free.
    for (let display = 70; ; display++) {
      const listening = await new Promise<boolean>((resolve) => {
        xServer.once('error', () => resolve(false));
        xServer.listen(X11_TCP_BASE + display, '127.0.0.1', () => resolve(true));
      });
      if (listening) break;
      if (display > 170) throw new Error('no free X display');
    }
    const display = (xServer.address() as AddressInfo).port - X11_TCP_BASE;
    return { xServer, display, received: () => Buffer.concat(received) };
  }

  it('lets a remote X client reach the local X server, which only ever sees its own cookie', async () => {
    const { xServer, display, received } = await localXServer();
    const realCookie = Buffer.alloc(16, 0x5a);
    const xauthority = path.join(scratch, 'Xauthority');
    writeFileSync(
      xauthority,
      serializeXauthority([
        { family: FAMILY_WILD, address: Buffer.alloc(0), number: String(display), name: MIT_MAGIC_COOKIE, data: realCookie },
      ]),
    );
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const x11 = new LocalX11({
      log: log as never,
      env: { DISPLAY: `127.0.0.1:${display}`, XAUTHORITY: xauthority },
      platform: 'linux',
    });
    try {
      const shell = await home
        .manager(
          { box: [...ALICE, 'ForwardX11 yes', 'RequestTTY no', 'RemoteCommand python3 /opt/muxus/x11-client.py'] },
          { x11 },
        )
        .connectShell(ssh('box'), recordingIo().io, 80, 24, 'xterm-256color');
      expect(shell.summary.x11).toBe('on');
      const result = await finished(shell.stream);
      expect(result.stdout).toBe('x-server-answers');

      // The client presented the cookie sshd handed it; the X server got the real one,
      // and then the client's first request, untouched.
      const setup = parseX11Setup(received());
      expect(setup).toMatchObject({ kind: 'complete', authName: MIT_MAGIC_COOKIE, authData: realCookie });
      if (setup.kind !== 'complete') return;
      expect(received().subarray(setup.length).toString()).toBe('first-request');
      expect(log.warn).not.toHaveBeenCalled();
      shell.lease.release();
    } finally {
      x11.close();
      xServer.close();
    }
  });

  it('opens the session without X11 when no X server is there to forward to', async () => {
    const x11 = new LocalX11({ log: { info: vi.fn(), warn: vi.fn() } as never, env: {}, platform: 'linux' });
    const io = recordingIo();
    const shell = await home
      .manager({ box: [...ALICE, 'ForwardX11 yes', 'RequestTTY no', 'RemoteCommand echo "display=$DISPLAY"'] }, { x11 })
      .connectShell(ssh('box'), io.io, 80, 24, 'xterm-256color');
    expect(shell.summary.x11).toBe('no-server');
    expect((await finished(shell.stream)).stdout).toBe('display=\n');
    expect(io.statuses.some((status) => status.startsWith('X11 forwarding is on for this host, but no local X server'))).toBe(true);
    shell.lease.release();
  });
});
