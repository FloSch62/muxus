import { timingSafeEqual } from 'node:crypto';
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

/** What the splice uses of a forwarded channel; the SSH engine's channel has it. */
export interface X11Channel<Local> {
  read(): Promise<{ kind: string; data?: Buffer }>;
  close(): Promise<void>;
  /** Join the channel to `local` until either ends; `head` goes to `local` first. */
  splice(local: Local, head?: Buffer): Promise<void>;
}

/**
 * Join a forwarded X11 channel to the local X server the way ssh(1) does:
 * the remote side must present the fake cookie Muxus sent in x11-req, which
 * is swapped for the local server's real credentials before any bytes reach
 * it. Anything else closes both ends. Once the setup has passed, the engine
 * carries the connection, and the promise settles when it has ended.
 */
export async function spliceX11Connection<Local extends { close(): void }>(
  remote: X11Channel<Local>,
  local: Local,
  options: { cookie: Buffer; auth?: X11Auth; onRejected?: (reason: string) => void },
): Promise<void> {
  const closeBoth = async () => {
    local.close();
    await remote.close().catch(() => undefined);
  };
  const reject = async (reason: string) => {
    options.onRejected?.(reason);
    await closeBoth();
  };
  let pending: Buffer = Buffer.alloc(0);
  for (;;) {
    let event: { kind: string; data?: Buffer };
    try {
      event = await remote.read();
    } catch {
      return closeBoth();
    }
    // Ended before it said who it is.
    if (event.kind === 'close' || event.kind === 'eof') return closeBoth();
    if (event.kind !== 'data' || !event.data) continue;
    pending = pending.length ? Buffer.concat([pending, event.data]) : event.data;
    const setup = parseX11Setup(pending);
    if (setup.kind === 'incomplete') {
      if (pending.length > MAX_SETUP_BYTES) return reject('oversized connection setup');
      continue;
    }
    if (setup.kind === 'invalid') return reject('not an X11 connection setup');
    if (
      setup.authName !== MIT_MAGIC_COOKIE ||
      setup.authData.length !== options.cookie.length ||
      !timingSafeEqual(setup.authData, options.cookie)
    ) {
      return reject('wrong X11 authentication cookie');
    }
    const rewritten = rewriteX11Setup(pending, setup.littleEndian, options.auth);
    const head = pending.length > setup.length ? Buffer.concat([rewritten, pending.subarray(setup.length)]) : rewritten;
    try {
      await remote.splice(local, head);
    } catch {
      await closeBoth();
    }
    return;
  }
}
