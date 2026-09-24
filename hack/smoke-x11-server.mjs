// CI smoke test for the X server packaged with Windows builds: start it from
// the unpacked app exactly as Muxus does, then complete an X11 connection
// setup with the generated cookie and confirm a wrong cookie is refused.
//
//   node hack/smoke-x11-server.mjs   (after `pnpm build` and `pack:dir`)
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { LocalX11 } from '../server/dist/x11/local-x11.js';
import { rewriteX11Setup } from '../server/dist/x11/x11-proxy.js';

const release = path.resolve('electron/release');
const unpacked = readdirSync(release).filter((name) => /^win-.*unpacked$/.test(name));
assert.equal(unpacked.length, 1, `Expected one unpacked Windows app in ${release}`);
const directory = path.join(release, unpacked[0], 'resources', 'vcxsrv');

const print = (level) => (obj, msg) => console.log(`[${level}]`, msg ?? '', typeof obj === 'string' ? obj : JSON.stringify(obj));
const log = { info: print('info'), warn: print('warn'), error: print('error'), debug: () => undefined };
const x11 = new LocalX11({ log, bundledServerDirectory: directory, env: {}, platform: 'win32' });

/** Send a little-endian protocol 11.0 setup request and read the status byte. */
async function handshake(auth) {
  const { socket } = await x11.connect();
  try {
    const header = Buffer.from([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    socket.write(rewriteX11Setup(header, true, auth));
    const reply = await new Promise((resolve, reject) => {
      socket.once('data', resolve);
      socket.once('error', reject);
      setTimeout(() => reject(new Error('no reply from the X server')), 10_000);
    });
    return reply;
  } finally {
    socket.destroy();
  }
}

try {
  assert.deepEqual(x11.availability(), { source: 'bundled', defaultEnabled: true });
  const { auth } = await x11.connect().then(({ socket, auth }) => (socket.destroy(), { auth }));
  assert.ok(auth, 'the bundled server must use a cookie');

  const accepted = await handshake(auth);
  assert.equal(accepted[0], 1, `X server refused the Muxus cookie: ${accepted.subarray(8).toString('latin1')}`);
  const vendorLength = accepted.readUInt16LE(24);
  console.log(`X11 setup accepted by "${accepted.subarray(40, 40 + vendorLength).toString('latin1')}"`);

  const refused = await handshake({ name: auth.name, data: Buffer.alloc(auth.data.length, 0) });
  assert.equal(refused[0], 0, 'X server accepted a connection with the wrong cookie');
  console.log('X11 setup with a wrong cookie refused');
} finally {
  x11.close();
}
