import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { MIT_MAGIC_COOKIE, type X11Auth } from './xauthority.js';

/** Setup requests carry two short strings; anything larger is not X11. */
const MAX_SETUP_BYTES = 64 * 1024;
const SETUP_HEADER_BYTES = 12;

export type X11SetupParse =
  | { kind: 'incomplete' }
  | { kind: 'invalid' }
  | {
      kind: 'complete';
      littleEndian: boolean;
      authName: string;
      authData: Buffer;
      /** Bytes the setup request occupies, padding included. */
      length: number;
    };

const pad4 = (n: number) => (n + 3) & ~3;

/**
 * Parse the X11 connection setup request a client sends first: byte order
 * ('B' or 'l'), protocol version, then the authorization protocol name and
 * data, each padded to four bytes.
 */
export function parseX11Setup(buf: Buffer): X11SetupParse {
  if (buf.length < 1) return { kind: 'incomplete' };
  const order = buf[0];
  if (order !== 0x42 && order !== 0x6c) return { kind: 'invalid' };
  if (buf.length < SETUP_HEADER_BYTES) return { kind: 'incomplete' };
  const littleEndian = order === 0x6c;
  const u16 = (offset: number) => (littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset));
  const nameLength = u16(6);
  const dataLength = u16(8);
  const length = SETUP_HEADER_BYTES + pad4(nameLength) + pad4(dataLength);
  if (buf.length < length) return { kind: 'incomplete' };
  const nameStart = SETUP_HEADER_BYTES;
  const dataStart = nameStart + pad4(nameLength);
  return {
    kind: 'complete',
    littleEndian,
    authName: buf.toString('latin1', nameStart, nameStart + nameLength),
    authData: Buffer.from(buf.subarray(dataStart, dataStart + dataLength)),
    length,
  };
}

/** Rebuild a setup request with different credentials (none when `auth` is absent). */
export function rewriteX11Setup(setup: Buffer, littleEndian: boolean, auth?: X11Auth): Buffer {
  const name = Buffer.from(auth?.name ?? '', 'latin1');
  const data = auth?.data ?? Buffer.alloc(0);
  const out = Buffer.alloc(SETUP_HEADER_BYTES + pad4(name.length) + pad4(data.length));
  setup.copy(out, 0, 0, 6);
  if (littleEndian) {
    out.writeUInt16LE(name.length, 6);
    out.writeUInt16LE(data.length, 8);
  } else {
    out.writeUInt16BE(name.length, 6);
    out.writeUInt16BE(data.length, 8);
  }
  name.copy(out, SETUP_HEADER_BYTES);
  data.copy(out, SETUP_HEADER_BYTES + pad4(name.length));
  return out;
}

/**
 * Join a forwarded X11 channel to the local X server the way ssh(1) does:
 * the remote side must present the fake cookie Muxus sent in x11-req, which
 * is swapped for the local server's real credentials before any bytes reach
 * it. Anything else closes both streams.
 */
export function spliceX11Connection(
  remote: Duplex,
  local: Duplex,
  options: { cookie: Buffer; auth?: X11Auth; onRejected?: (reason: string) => void },
): void {
  let pending: Buffer = Buffer.alloc(0);
  let settled = false;
  const closeBoth = () => {
    remote.destroy();
    local.destroy();
  };
  const reject = (reason: string) => {
    settled = true;
    remote.off('data', onData);
    options.onRejected?.(reason);
    closeBoth();
  };
  const onData = (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const setup = parseX11Setup(pending);
    if (setup.kind === 'incomplete') {
      if (pending.length > MAX_SETUP_BYTES) reject('oversized connection setup');
      return;
    }
    if (setup.kind === 'invalid') {
      reject('not an X11 connection setup');
      return;
    }
    if (
      setup.authName !== MIT_MAGIC_COOKIE ||
      setup.authData.length !== options.cookie.length ||
      !timingSafeEqual(setup.authData, options.cookie)
    ) {
      reject('wrong X11 authentication cookie');
      return;
    }
    settled = true;
    remote.off('data', onData);
    local.write(rewriteX11Setup(pending, setup.littleEndian, options.auth));
    if (pending.length > setup.length) local.write(pending.subarray(setup.length));
    remote.pipe(local);
    local.pipe(remote);
  };

  remote.on('data', onData);
  remote.once('close', closeBoth);
  local.once('close', closeBoth);
  remote.on('error', closeBoth);
  local.on('error', closeBoth);
  remote.once('end', () => {
    if (!settled) closeBoth();
  });
}
