import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from '../server/node_modules/ws';
import type { RunningServer } from '../server/src/server.js';
import { terminalWebSocketProtocols, TERMINAL_SESSION_CLOSE_REASON } from '../shared/src/ws-protocol.js';

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Serial recovery timed out')), 6_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Exercise the packaged serial driver through the same WebSocket lifecycle as a tab. */
export async function checkSerialRecovery(server: RunningServer, root: string): Promise<void> {
  const device = path.join(root, 'serial-recovery-device');
  const profile = { kind: 'serial', path: device, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
  const sockets = new Set<WebSocket>();
  const makePeer = async () => {
    const child = spawn('python3', ['-u', '-c', `import os,tty,sys
m,s=os.openpty()
tty.setraw(s)
try: os.unlink(sys.argv[1])
except FileNotFoundError: pass
os.symlink(os.ttyname(s),sys.argv[1])
print('ready',flush=True)
while True:
 d=os.read(m,4096)
 while d:
  n=os.write(m,d)
  d=d[n:]`, device], { stdio: ['ignore', 'pipe', 'inherit'] });
    try { await withTimeout(once(child.stdout, 'data')); }
    catch (error) { child.kill(); throw error; }
    return child;
  };
  const dial = async () => {
    const socket = new WebSocket(new URL('/ws/terminal', server.url).href.replace('http:', 'ws:'), terminalWebSocketProtocols(server.token));
    sockets.add(socket);
    let output = '';
    const exits: Array<{ reason?: string; message?: string }> = [];
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A failed dial may close before the caller receives its session object.
    void ready.catch(() => undefined);
    socket.on('message', (data, binary) => {
      if (binary) { output += data.toString(); return; }
      const message = JSON.parse(data.toString());
      if (message.op === 'ready') resolveReady();
      if (message.op === 'exit') {
        exits.push(message);
        rejectReady(new Error(message.message || 'Serial session ended'));
      }
    });
    socket.on('error', rejectReady);
    socket.on('close', () => { sockets.delete(socket); rejectReady(new Error('Serial socket closed')); });
    await withTimeout(once(socket, 'open'));
    socket.send(JSON.stringify({ op: 'connect', profile, cols: 80, rows: 24 }));
    return { socket, ready, exits, output: () => output };
  };
  const close = async (socket: WebSocket) => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const ended = once(socket, 'close');
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    await withTimeout(ended);
  };
  const echo = async (session: Awaited<ReturnType<typeof dial>>, marker: string) => {
    session.socket.send(Buffer.from(marker));
    await withTimeout((async () => {
      while (!session.output().includes(marker)) {
        assert.equal(session.socket.readyState, WebSocket.OPEN, 'Serial session closed before echo');
        await Bun.sleep(10);
      }
    })());
  };
  let peer = await makePeer();
  try {
    for (let cycle = 0; cycle < 30; cycle++) {
      const session = await dial();
      await withTimeout(session.ready);
      await echo(session, `reconnect-${cycle}`);
      await close(session.socket);
    }
    const owner = await dial();
    await withTimeout(owner.ready);
    const busy = await dial();
    await assert.rejects(withTimeout(busy.ready), /already in use/);
    await echo(owner, 'owner-still-works');
    await close(owner.socket);
    const recovered = await dial();
    await withTimeout(recovered.ready);
    await echo(recovered, 'busy-recovered');
    await close(recovered.socket);
    for (let cycle = 0; cycle < 3; cycle++) {
      const session = await dial();
      await withTimeout(session.ready);
      // No input on this session: removal must wake an idle pending read too.
      const ended = once(session.socket, 'close');
      const peerExit = once(peer, 'exit');
      peer.kill();
      await withTimeout(peerExit);
      await withTimeout(ended);
      assert.equal(session.exits.at(-1)?.reason, 'disconnected', 'Device removal must allow automatic reconnect');
      const absent = await dial();
      await assert.rejects(withTimeout(absent.ready), /not found/);
      peer = await makePeer();
      const replugged = await dial();
      await withTimeout(replugged.ready);
      await echo(replugged, `replugged-${cycle}`);
      await close(replugged.socket);
    }
    console.log('Packaged serial recovery: 30 reconnects, busy-port ownership and 3 idle unplug/replug cycles passed');
  } finally {
    try { await Promise.all([...sockets].map(close)); }
    finally { peer.kill(); }
  }
}
