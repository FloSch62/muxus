import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { SerialPort } from '../server/node_modules/serialport';
import { AsyncEntry } from '../server/node_modules/@napi-rs/keyring';
import WebSocket from '../server/node_modules/ws';
import { Server as SshServer } from '../server/node_modules/ssh2';
import { startServer, SystemVaultKeyStore } from '../server/src/server.js';
import { SessionHistoryStore } from '../server/src/session-logging/history-store.js';
import { terminalWebSocketProtocols, TERMINAL_SESSION_CLOSE_REASON } from '../shared/src/ws-protocol.js';

const root = process.env.MUXUS_SMOKE_ROOT!;
const knownHosts = path.join(root, 'known_hosts');
writeFileSync(process.env.MUXUS_SSH_CONFIG!, `Host 127.0.0.1\n UserKnownHostsFile "${knownHosts.replaceAll('\\', '/')}"\n GlobalKnownHostsFile none\n IdentityAgent none\n IdentitiesOnly yes\n`);
assert.ok(process.versions.bun, 'The packaged server must run in Bun');
assert.equal(typeof AsyncEntry, 'function');
assert.ok(Array.isArray(await SerialPort.list()));
const server = await startServer({ port: 0, databasePath: path.join(root, 'muxus.sqlite3'), historyPath: path.join(root, 'history'), staticRoot: process.env.MUXUS_SMOKE_STATIC, openBrowser: false, prettyLogs: false });
try {
  assert.equal((await fetch(server.url + '/api/app/info')).status, 401);
  assert.equal((await fetch(server.url + '/api/app/info', { headers: { authorization: `Bearer ${server.token}` } })).status, 200);
  assert.equal((await fetch(server.url)).status, 200);
  const socket = new WebSocket(new URL('/ws/terminal', server.url).href.replace('http:', 'ws:'), terminalWebSocketProtocols(server.token));
  try {
    await once(socket, 'open');
    let output = '';
    const completed = new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', (data, binary) => {
        if (binary) { output += data.toString(); if (output.includes('muxus-pty-ok')) resolve(); return; }
        const control = JSON.parse(data.toString());
        if (control.op === 'ready') socket.send(Buffer.from(process.platform === 'win32' ? 'echo muxus-pty-^ok\r' : "printf 'muxus-%s\\n' 'pty-ok'\r"));
        if (control.op === 'exit') reject(new Error(control.message || 'PTY exited before producing output'));
      });
    });
    socket.send(JSON.stringify({ op: 'connect', profile: { kind: 'local', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', cwd: root }, cols: 80, rows: 24 }));
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('PTY output timed out')), 10_000).unref())]);
  } finally { socket.close(1000, TERMINAL_SESSION_CLOSE_REASON); }
  console.log('Packaged Bun: HTTP auth, UI assets, PTY and native module loading passed');

  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  let connections = 0;
  const sshd = new SshServer({ hostKeys: [key] }, (client) => {
    connections++;
    client.on('error', () => undefined);
    client.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.password === 'smoke-password') auth.accept();
      else auth.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (accept) => accept?.());
      session.on('env', (accept) => accept?.());
      session.on('exec', (accept) => { const stream = accept(); stream.exit(0); stream.end(); });
      session.on('shell', (accept) => {
        const stream = accept();
        stream.on('data', (data) => stream.write(Buffer.concat([Buffer.from('ssh:'), data])));
      });
      session.on('sftp', (accept) => {
        const sftp = accept();
        let listed = false;
        sftp.on('REALPATH', (id) => sftp.name(id, [{ filename: '/', longname: '/', attrs: {} }]));
        sftp.on('OPENDIR', (id) => { listed = false; sftp.handle(id, Buffer.from('dir')); });
        sftp.on('READDIR', (id) => {
          if (listed) sftp.status(id, 1);
          else { listed = true; sftp.name(id, [{ filename: 'fixture.txt', longname: 'fixture.txt', attrs: { mode: 0o100644, size: 12, mtime: 0, atime: 0, uid: 0, gid: 0 } }]); }
        });
        sftp.on('CLOSE', (id) => sftp.status(id, 0));
      });
    }));
  });
  await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve));
  const sshSocket = new WebSocket(new URL('/ws/terminal', server.url).href.replace('http:', 'ws:'), terminalWebSocketProtocols(server.token));
  try {
    await once(sshSocket, 'open');
    let connId = '';
    const output = new Promise<void>((resolve, reject) => {
      sshSocket.on('error', reject);
      sshSocket.on('message', (data, binary) => {
        if (binary) { if (data.toString().includes('ssh:transport-ok')) resolve(); return; }
        const message = JSON.parse(data.toString());
        if (message.op === 'host-key') sshSocket.send(JSON.stringify({ op: 'host-key-response', accept: true }));
        if (message.op === 'auth-prompt') sshSocket.send(JSON.stringify({ op: 'auth-response', answers: ['smoke-password'] }));
        if (message.op === 'ready') { connId = message.connId; sshSocket.send(Buffer.from('transport-ok')); }
        if (message.op === 'exit' || message.op === 'error') reject(new Error(JSON.stringify(message)));
      });
    });
    sshSocket.send(JSON.stringify({ op: 'connect', profile: { kind: 'ssh', target: '127.0.0.1', port: sshd.address().port, user: 'smoke', passwordOnly: true }, cols: 80, rows: 24 }));
    await output;
    const listing = await fetch(`${server.url}/api/sftp/${connId}/list?path=/`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(listing.status, 200);
    assert.ok((await listing.text()).includes('fixture.txt'));
    assert.ok(readFileSync(knownHosts, 'utf8').includes('[127.0.0.1]:'));
    assert.equal(connections, 1, 'SFTP must reuse the terminal SSH transport');
    console.log('Packaged SSH: host-key verification, password authentication, terminal I/O and shared SFTP passed');
  } finally {
    sshSocket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    sshd.close();
  }
} finally { await server.close(); }

const history = await SessionHistoryStore.open({ root: path.join(root, 'recording'), settings: { maxTotalBytes: 64 * 1024 * 1024, minFreeBytes: 0, minFreePercent: 0 } });
try {
  const policy = { maxPartBytes: 64 * 1024, maxParts: 2 };
  const id = history.beginSession({ profileKey: 'local:smoke', title: 'Runtime smoke', kind: 'local', host: 'local', startedAt: new Date().toISOString(), captureInput: false }, policy);
  history.append(id, [{ sequence: 1, recordedAt: new Date().toISOString(), elapsedMs: 1, direction: 'output', raw: Buffer.from('compressed recording'), text: 'compressed recording' }], policy);
  history.finishSession(id, 'completed', new Date().toISOString());
  assert.equal((await history.sessionHistory({ query: 'recording', limit: 10 })).sessions[0]?.id, id);
  assert.equal((await history.rawSessionLogEvents(id))?.[0]?.raw.toString(), 'compressed recording');
  console.log('Packaged history worker: SQLite FTS, compression and replay passed');
} finally { await history.close(); }

if (process.platform === 'linux') {
  // Exercise real serialport native I/O through a PTY pair, without requiring hardware.
  const peer = spawn('python3', ['-u', '-c', 'import os,tty\nm,s=os.openpty()\ntty.setraw(s)\nprint(os.ttyname(s),flush=True)\nwhile True:\n d=os.read(m,4096)\n while d:\n  n=os.write(m,d)\n  d=d[n:]'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let serial: SerialPort | undefined;
  try {
    const [data] = await once(peer.stdout, 'data');
    const device = data.toString().trim();
    for (let cycle = 0; cycle < 3; cycle++) {
      serial = new SerialPort({ path: device, baudRate: 115200, autoOpen: false });
      await new Promise<void>((resolve, reject) => serial!.open((error) => error ? reject(error) : resolve()));
      const expected = randomBytes(128 * 1024);
      const received: Buffer[] = [];
      let bytes = 0;
      const reply = new Promise<Buffer>((resolve, reject) => {
        serial!.on('error', reject);
        serial!.on('data', (chunk: Buffer) => {
          received.push(chunk); bytes += chunk.length;
          if (bytes >= expected.length) resolve(Buffer.concat(received));
        });
      });
      serial.write(expected);
      assert.deepEqual(await reply, expected);
      // Close with another read already waiting in the native poller, then reopen.
      await new Promise<void>((resolve, reject) => serial!.close((error) => error ? reject(error) : resolve()));
    }
    console.log('Packaged serial binding: 384 KiB binary I/O, pending-read cancellation and reopen passed');
  } finally {
    if (serial?.isOpen) await new Promise<void>((resolve) => serial!.close(() => resolve()));
    peer.kill();
  }
}

if (process.env.MUXUS_OS_KEYRING_SMOKE === '1') {
  const store = new SystemVaultKeyStore();
  const id = `runtime-smoke-${randomBytes(12).toString('hex')}`;
  const key = randomBytes(32);
  try { await store.set(id, key); assert.deepEqual(await store.get(id), key); }
  finally { await store.delete(id); key.fill(0); }
  console.log('Packaged OS keyring: write, read and delete passed');
}
