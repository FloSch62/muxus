import { crc16, crc32Update } from './crc.js';
import {
  baseName,
  RemoteCancelError,
  timingOf,
  TransferTimeoutError,
  type IncomingFile,
  type IncomingFileInfo,
  type OutgoingFile,
  type TransferContext,
  type TransferTiming,
} from './transfer-io.js';

const ZPAD = 0x2a;
const ZDLE = 0x18;
const ZBIN = 0x41;
const ZHEX = 0x42;
const ZBIN32 = 0x43;

export const ZRQINIT = 0;
export const ZRINIT = 1;
const ZSINIT = 2;
const ZACK = 3;
const ZFILE = 4;
const ZSKIP = 5;
const ZNAK = 6;
const ZABORT = 7;
const ZFIN = 8;
const ZRPOS = 9;
const ZDATA = 10;
const ZEOF = 11;
const ZFERR = 12;
const ZCRC = 13;
const ZCHALLENGE = 14;
const ZCOMPL = 15;
const ZCAN = 16;
const ZFREECNT = 17;
const ZCOMMAND = 18;

const ZCRCE = 0x68;
const ZCRCG = 0x69;
const ZCRCQ = 0x6a;
const ZCRCW = 0x6b;
const ZRUB0 = 0x6c;
const ZRUB1 = 0x6d;

const CANFDX = 0x01;
const CANOVIO = 0x02;
const CANFC32 = 0x20;
const ESCCTL = 0x40;

const XON = 0x11;
const XOFF = 0x13;
const CAN = 0x18;

/** ZFILE conversion option: binary, no newline translation. */
const ZCBIN = 1;

/** Data bytes per subpacket; the size every ZMODEM receiver accepts. */
const BLOCK_SIZE = 1024;
/** lrzsz receivers take up to 8 KiB; anything longer is line noise. */
const MAX_SUBPACKET = 8192;
/** Noise tolerated while looking for a header before asking again. */
const GARBAGE_LIMIT = 32 * 1024;

const FRAME_END = 0x100;

export interface ZmodemHeader {
  type: number;
  /** ZP0..ZP3: a little-endian position, or the flags ZF3..ZF0. */
  data: Buffer;
  /** ZBIN, ZHEX or ZBIN32: subpackets after a ZBIN32 header carry CRC-32. */
  format: number;
}

export function headerPosition(header: ZmodemHeader): number {
  return header.data.readUInt32LE(0);
}

function positionBytes(position: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(position >>> 0, 0);
  return data;
}

/** Flags in ZF0..ZF3 order, stored back to front like the protocol does. */
function flagBytes(zf0: number, zf1 = 0, zf2 = 0, zf3 = 0): Buffer {
  return Buffer.from([zf3, zf2, zf1, zf0]);
}

const HEX = '0123456789abcdef';

function hexByte(value: number): string {
  return HEX[(value >> 4) & 0xf]! + HEX[value & 0xf]!;
}

export function encodeHexHeader(type: number, data: Buffer): Buffer {
  const bytes = Buffer.from([type, ...data]);
  const crc = crc16(bytes);
  let text = '**\x18B';
  for (const byte of bytes) text += hexByte(byte);
  text += hexByte(crc >> 8) + hexByte(crc & 0xff);
  const tail = type === ZFIN || type === ZACK ? [0x0d, 0x8a] : [0x0d, 0x8a, XON];
  return Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from(tail)]);
}

/** Escapes data for the wire: ZDLE and flow-control bytes always, every control byte on request. */
export class ZdleEncoder {
  private readonly table = new Uint8Array(256);
  private last = 0;

  constructor(escapeControl: boolean) {
    for (let byte = 0; byte < 256; byte++) {
      if (byte & 0x60) continue;
      if (escapeControl) this.table[byte] = 1;
      else if (byte === ZDLE || byte === XON || byte === XOFF || byte === 0x91 || byte === 0x93 || byte === 0x10 || byte === 0x90) {
        this.table[byte] = 1;
      } else if (byte === 0x0d || byte === 0x8d) {
        // CR after '@' would read as a Telenet escape on the far side.
        this.table[byte] = 2;
      }
    }
  }

  encode(data: Uint8Array, out: Buffer, offset: number): number {
    for (const byte of data) {
      const rule = this.table[byte]!;
      if (rule === 1 || (rule === 2 && (this.last & 0x7f) === 0x40)) {
        out[offset++] = ZDLE;
        out[offset++] = byte ^ 0x40;
      } else {
        out[offset++] = byte;
      }
      this.last = byte;
    }
    return offset;
  }
}

export function encodeBinaryHeader(type: number, data: Buffer, crc32: boolean, encoder: ZdleEncoder): Buffer {
  const bytes = Buffer.from([type, ...data]);
  const check = Buffer.alloc(crc32 ? 4 : 2);
  if (crc32) check.writeUInt32LE(~crc32Update(0xffffffff, bytes) >>> 0, 0);
  else check.writeUInt16BE(crc16(bytes), 0);
  const out = Buffer.alloc(3 + (bytes.length + check.length) * 2);
  out[0] = ZPAD;
  out[1] = ZDLE;
  out[2] = crc32 ? ZBIN32 : ZBIN;
  let offset = encoder.encode(bytes, out, 3);
  offset = encoder.encode(check, out, offset);
  return out.subarray(0, offset);
}

export function encodeSubpacket(data: Uint8Array, end: number, crc32: boolean, encoder: ZdleEncoder): Buffer {
  const out = Buffer.alloc(data.length * 2 + 16);
  let offset = encoder.encode(data, out, 0);
  out[offset++] = ZDLE;
  out[offset++] = end;
  const check = Buffer.alloc(crc32 ? 4 : 2);
  if (crc32) {
    check.writeUInt32LE(~crc32Update(crc32Update(0xffffffff, data), Uint8Array.of(end)) >>> 0, 0);
  } else {
    check.writeUInt16BE(crc16(Uint8Array.of(end), crc16(data)), 0);
  }
  offset = encoder.encode(check, out, offset);
  // XON after ZCRCW, as lrzsz does, in case flow control stopped the line.
  if (end === ZCRCW) out[offset++] = XON;
  return out.subarray(0, offset);
}

/** Damaged or unexpected framing: the caller asks the other side to resend. */
class FrameError extends Error {
  constructor(
    message: string,
    /** Only noise arrived, such as subpackets still in flight after an error. */
    readonly garbage = false,
  ) {
    super(message);
  }
}

/**
 * Undoes ZDLE escaping one wire byte at a time, so a reader can decode a
 * whole buffer synchronously. Five CANs in a row are the abort sequence.
 */
class ZdleDecoder {
  private escaped = false;
  private cancels = 0;

  reset(): void {
    this.escaped = false;
    this.cancels = 0;
  }

  /** A data byte, FRAME_END | ZCRCx, or -1 when the byte only changed state. */
  push(byte: number): number {
    if (!this.escaped) {
      if (byte & 0x60) return byte;
      if (byte === ZDLE) {
        this.escaped = true;
        this.cancels = 1;
        return -1;
      }
      if (byte === XON || byte === XOFF || byte === (XON | 0x80) || byte === (XOFF | 0x80)) return -1;
      return byte;
    }
    if (byte === CAN) {
      if (++this.cancels >= 5) throw new RemoteCancelError();
      return -1;
    }
    if (byte === XON || byte === XOFF || byte === (XON | 0x80) || byte === (XOFF | 0x80)) return -1;
    this.escaped = false;
    switch (byte) {
      case ZCRCE:
      case ZCRCG:
      case ZCRCQ:
      case ZCRCW:
        return FRAME_END | byte;
      case ZRUB0:
        return 0x7f;
      case ZRUB1:
        return 0xff;
    }
    if ((byte & 0x60) === 0x40) return byte ^ 0x40;
    throw new FrameError('bad escape');
  }
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return -1;
}

export interface ZmodemFileInfo extends IncomingFileInfo {
  name: string;
}

export function parseFileInfo(data: Buffer): ZmodemFileInfo {
  const nul = data.indexOf(0);
  const name = baseName(data.subarray(0, nul < 0 ? data.length : nul).toString('utf8'));
  const end = nul < 0 ? -1 : data.indexOf(0, nul + 1);
  const fields =
    nul < 0
      ? []
      : data
          .subarray(nul + 1, end < 0 ? data.length : end)
          .toString('ascii')
          .trim()
          .split(/\s+/);
  const size = fields[0] ? Number.parseInt(fields[0], 10) : Number.NaN;
  const mtime = fields[1] ? Number.parseInt(fields[1], 8) : Number.NaN;
  const filesLeft = fields[4] ? Number.parseInt(fields[4], 10) : Number.NaN;
  const bytesLeft = fields[5] ? Number.parseInt(fields[5], 10) : Number.NaN;
  return {
    name: name || 'zmodem.bin',
    ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    ...(Number.isFinite(mtime) && mtime > 0 ? { mtimeMs: mtime * 1000 } : {}),
    ...(Number.isSafeInteger(filesLeft) && filesLeft > 0 ? { filesLeft } : {}),
    ...(Number.isSafeInteger(bytesLeft) && bytesLeft >= 0 ? { bytesLeft } : {}),
  };
}

/** Header and subpacket framing over the transfer's input and output. */
class ZmodemLink {
  readonly timing: TransferTiming;
  readonly decoder = new ZdleDecoder();
  encoder = new ZdleEncoder(false);
  crc32 = false;
  /** The last hex header's CR LF has been read. */
  private trailerSeen = false;

  constructor(readonly ctx: TransferContext) {
    this.timing = timingOf(ctx);
  }

  write(data: Buffer): void {
    this.ctx.output.write(data);
  }

  hex(type: number, data: Buffer = Buffer.alloc(4)): void {
    this.write(encodeHexHeader(type, data));
  }

  binary(type: number, data: Buffer): void {
    this.write(encodeBinaryHeader(type, data, this.crc32, this.encoder));
  }

  private async next(timeoutMs: number): Promise<number> {
    const byte = this.ctx.input.tryByte();
    return byte ?? this.ctx.input.byte(timeoutMs);
  }

  private async decoded(timeoutMs: number): Promise<number> {
    for (;;) {
      const value = this.decoder.push(await this.next(timeoutMs));
      if (value >= 0) return value;
    }
  }

  /**
   * The next valid header. Noise in between (subpackets being skipped after
   * an error, terminal text, hex header trailers) is passed over; too much of
   * it, or a header that fails its CRC, throws FrameError.
   */
  async header(timeoutMs = this.timing.reply): Promise<ZmodemHeader> {
    let garbage = 0;
    let cancels = 0;
    let pads = 0;
    const deadline = Date.now() + timeoutMs;
    const left = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransferTimeoutError();
      return remaining;
    };
    for (;;) {
      const byte = await this.next(left());
      if (byte === ZPAD) {
        pads++;
        cancels = 0;
        continue;
      }
      if (byte === ZDLE && pads > 0) {
        pads = 0;
        const format = await this.next(left());
        if (format === ZHEX) return this.hexHeader(left);
        if (format === ZBIN || format === ZBIN32) return this.binaryHeader(format);
        cancels = format === CAN ? 2 : 0;
        continue;
      }
      pads = 0;
      if (byte === CAN) {
        if (++cancels >= 5) throw new RemoteCancelError();
        continue;
      }
      cancels = 0;
      if (++garbage > GARBAGE_LIMIT) throw new FrameError('garbage', true);
    }
  }

  /** Swallow the CR, LF and XON that may still follow a hex header. */
  async trailer(waitMs: number): Promise<void> {
    if (this.trailerSeen) return;
    const trailing = (byte: number) => byte === 0x0d || byte === 0x8d || byte === 0x0a || byte === 0x8a || byte === XON;
    for (let i = 0; i < 3; i++) {
      if (!(await this.ctx.input.optional(trailing, waitMs))) return;
    }
  }

  private async hexHeader(left: () => number): Promise<ZmodemHeader> {
    const bytes = Buffer.alloc(7);
    for (let i = 0; i < 7; i++) {
      const high = hexValue(await this.next(left()));
      const low = hexValue(await this.next(left()));
      if (high < 0 || low < 0) throw new FrameError('bad hex header');
      bytes[i] = (high << 4) | low;
    }
    if (crc16(bytes, 0, 0, 5) !== bytes.readUInt16BE(5)) throw new FrameError('hex header CRC');
    const input = this.ctx.input;
    // CR, LF (often with the high bit set) and XON trail a hex header.
    this.trailerSeen = false;
    if (input.peekByte() === 0x0d || input.peekByte() === 0x8d) {
      input.tryByte();
      if (input.peekByte() === 0x0a || input.peekByte() === 0x8a) {
        input.tryByte();
        this.trailerSeen = true;
      }
    }
    if (input.peekByte() === XON) input.tryByte();
    return { type: bytes[0]!, data: bytes.subarray(1, 5), format: ZHEX };
  }

  private async binaryHeader(format: number): Promise<ZmodemHeader> {
    this.decoder.reset();
    const length = format === ZBIN32 ? 9 : 7;
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      const value = await this.decoded(this.timing.byte);
      if (value & FRAME_END) throw new FrameError('frame end inside a header');
      bytes[i] = value;
    }
    if (format === ZBIN32) {
      if ((~crc32Update(0xffffffff, bytes, 0, 5) >>> 0) !== bytes.readUInt32LE(5)) {
        throw new FrameError('header CRC');
      }
    } else if (crc16(bytes, 0, 0, 5) !== bytes.readUInt16BE(5)) {
      throw new FrameError('header CRC');
    }
    return { type: bytes[0]!, data: bytes.subarray(1, 5), format };
  }

  /** One data subpacket; decoded synchronously while bytes are buffered. */
  async subpacket(crc32: boolean): Promise<{ data: Buffer; end: number }> {
    this.decoder.reset();
    const input = this.ctx.input;
    const out = Buffer.allocUnsafe(MAX_SUBPACKET);
    const checkLength = crc32 ? 4 : 2;
    const check = Buffer.alloc(checkLength);
    let length = 0;
    let end = -1;
    let checked = 0;
    for (;;) {
      let byte: number | undefined;
      while ((byte = input.tryByte()) !== undefined) {
        const value = this.decoder.push(byte);
        if (value < 0) continue;
        if (end < 0) {
          if (value & FRAME_END) {
            end = value & 0xff;
          } else {
            if (length >= MAX_SUBPACKET) throw new FrameError('subpacket too long');
            out[length++] = value;
          }
          continue;
        }
        if (value & FRAME_END) throw new FrameError('frame end inside a CRC');
        check[checked++] = value;
        if (checked < checkLength) continue;
        const data = out.subarray(0, length);
        const valid = crc32
          ? (~crc32Update(crc32Update(0xffffffff, data), Uint8Array.of(end)) >>> 0) === check.readUInt32LE(0)
          : crc16(Uint8Array.of(end), crc16(data)) === check.readUInt16BE(0);
        if (!valid) throw new FrameError('subpacket CRC');
        return { data: Buffer.from(data), end };
      }
      await input.wait(this.timing.reply);
    }
  }
}

const RECEIVER_FLAGS = CANFDX | CANOVIO | CANFC32;

export interface ZmodemReceiveOptions {
  /** Asked for a target when a file is announced; undefined skips it. */
  open(info: ZmodemFileInfo, index: number): Promise<IncomingFile | undefined>;
}

/**
 * Receive files from a ZMODEM sender (`sz`): announce ZRINIT, take each
 * ZFILE, ask for missing data with ZRPOS, and close with ZFIN / "OO".
 */
export async function zmodemReceive(ctx: TransferContext, options: ZmodemReceiveOptions): Promise<void> {
  const link = new ZmodemLink(ctx);
  const { timing } = link;
  const sendInit = () => link.hex(ZRINIT, flagBytes(RECEIVER_FLAGS));
  sendInit();
  let errors = 0;
  let index = 0;
  for (;;) {
    let header: ZmodemHeader;
    try {
      header = await link.header();
    } catch (error) {
      if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
      if (++errors > timing.retries) throw new TransferTimeoutError('The remote side did not start sending.');
      sendInit();
      continue;
    }
    switch (header.type) {
      case ZRQINIT:
      case ZNAK:
      case ZEOF:
      case ZDATA:
        sendInit();
        break;
      case ZSINIT:
        await link.subpacket(header.format === ZBIN32).catch(() => undefined);
        link.hex(ZACK, positionBytes(1));
        break;
      case ZFILE: {
        let info: ZmodemFileInfo;
        try {
          info = parseFileInfo((await link.subpacket(header.format === ZBIN32)).data);
        } catch (error) {
          if (!(error instanceof FrameError)) throw error;
          link.hex(ZNAK);
          break;
        }
        index++;
        const target = await options.open(info, index);
        if (!target) {
          link.hex(ZSKIP);
          break;
        }
        await receiveFile(link, target, info, index);
        errors = 0;
        sendInit();
        break;
      }
      case ZFIN:
        link.hex(ZFIN);
        // "OO" ends the session; a sender that is already gone may skip it.
        await link.trailer(100);
        await ctx.input.optional((byte) => byte === 0x4f, 1000);
        await ctx.input.optional((byte) => byte === 0x4f, 200);
        return;
      case ZCHALLENGE:
        link.hex(ZACK, header.data);
        break;
      case ZFREECNT:
        link.hex(ZACK, positionBytes(0xffffffff));
        break;
      case ZCOMMAND:
        // Never run commands the remote side asks for.
        await link.subpacket(header.format === ZBIN32).catch(() => undefined);
        link.hex(ZCOMPL, positionBytes(1));
        break;
      case ZCAN:
      case ZABORT:
        throw new RemoteCancelError();
      default:
        break;
    }
  }
}

async function receiveFile(
  link: ZmodemLink,
  target: IncomingFile,
  info: ZmodemFileInfo,
  index: number,
): Promise<void> {
  const { ctx, timing } = link;
  let received = 0;
  let errors = 0;
  let noise = 0;
  let errorAt = -1;
  const fileCount = info.filesLeft === undefined ? undefined : index - 1 + info.filesLeft;
  const report = () =>
    ctx.progress({ fileName: info.name, fileIndex: index, fileCount, bytes: received, total: info.size });
  const reposition = (error?: unknown) => {
    if (error instanceof FrameError && error.garbage) {
      // Data the sender streamed before it saw our last ZRPOS.
      if (++noise > 256) throw new TransferTimeoutError('Too many transmission errors.');
    } else {
      if (received > errorAt) errors = 0;
      errorAt = received;
      if (++errors > timing.retries) throw new TransferTimeoutError('Too many transmission errors.');
    }
    link.hex(ZRPOS, positionBytes(received));
  };
  report();
  link.hex(ZRPOS, positionBytes(0));
  try {
    for (;;) {
      let header: ZmodemHeader;
      try {
        header = await link.header();
      } catch (error) {
        if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
        reposition(error);
        continue;
      }
      switch (header.type) {
        case ZDATA: {
          if (headerPosition(header) !== received) {
            reposition();
            break;
          }
          const crc32 = header.format === ZBIN32;
          for (;;) {
            let packet: { data: Buffer; end: number };
            try {
              packet = await link.subpacket(crc32);
            } catch (error) {
              if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
              reposition(error);
              break;
            }
            if (packet.data.length > 0) {
              await target.write(packet.data);
              received += packet.data.length;
              report();
            }
            if (packet.end === ZCRCW || packet.end === ZCRCQ) link.hex(ZACK, positionBytes(received));
            if (packet.end === ZCRCW || packet.end === ZCRCE) break;
          }
          break;
        }
        case ZEOF:
          if (headerPosition(header) !== received) break;
          await target.finish(info.size === undefined ? undefined : Math.min(info.size, received));
          return;
        case ZFILE:
          // Our ZRPOS was lost; the sender is still offering the file.
          await link.subpacket(header.format === ZBIN32).catch(() => undefined);
          link.hex(ZRPOS, positionBytes(received));
          break;
        case ZNAK:
          reposition();
          break;
        case ZCAN:
        case ZABORT:
        case ZFIN:
          throw new RemoteCancelError();
        default:
          break;
      }
    }
  } catch (error) {
    await target.discard();
    throw error;
  }
}

export interface ZmodemSendOptions {
  /** ZRINIT already read by auto-start detection: the receiver is waiting. */
  receiverInit?: ZmodemHeader;
  /** Type `rz` first, as `sz` does, for a receiver that has not started yet. */
  announce?: boolean;
}

export interface ZmodemSendResult {
  sent: string[];
  /** Files the receiver declined, usually because they already exist there. */
  skipped: string[];
}

/** Send files to a ZMODEM receiver (`rz`). */
export async function zmodemSend(
  ctx: TransferContext,
  files: OutgoingFile[],
  options: ZmodemSendOptions = {},
): Promise<ZmodemSendResult> {
  const link = new ZmodemLink(ctx);
  const { timing } = link;
  let init = options.receiverInit;
  if (!init) {
    if (options.announce) link.write(Buffer.from('rz\r', 'ascii'));
    for (let attempt = 0; !init; attempt++) {
      if (attempt > timing.retries) throw new TransferTimeoutError('The remote side did not start receiving.');
      link.hex(ZRQINIT);
      try {
        const header = await link.header(attempt === 0 ? timing.start / 3 : timing.reply);
        if (header.type === ZRINIT) init = header;
        else if (header.type === ZCHALLENGE) link.hex(ZACK, header.data);
        else if (header.type === ZCAN || header.type === ZABORT) throw new RemoteCancelError();
      } catch (error) {
        if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
      }
    }
  } else {
    // Repeats of the receiver's ZRINIT may be queued; the first answer it
    // gets must be our ZFILE.
    ctx.input.discard();
  }
  const flags = init.data[3]!;
  const bufferSize = init.data[0]! | (init.data[1]! << 8);
  link.crc32 = (flags & CANFC32) !== 0;
  link.encoder = new ZdleEncoder((flags & ESCCTL) !== 0);
  const streaming = (flags & (CANFDX | CANOVIO)) === (CANFDX | CANOVIO);

  const result: ZmodemSendResult = { sent: [], skipped: [] };
  let bytesLeft = files.reduce((sum, file) => sum + file.size, 0);
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const outcome = await sendFile(link, file, {
      index: index + 1,
      count: files.length,
      bytesLeft,
      streaming,
      bufferSize,
    });
    (outcome === 'sent' ? result.sent : result.skipped).push(file.name);
    bytesLeft -= file.size;
  }

  for (let attempt = 0; ; attempt++) {
    link.hex(ZFIN);
    try {
      const header = await link.header();
      if (header.type === ZFIN) {
        await link.trailer(100);
        break;
      }
    } catch (error) {
      if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
      // The receiver may have finished without answering ZFIN.
      if (attempt >= 2) break;
    }
  }
  link.write(Buffer.from('OO', 'ascii'));
  return result;
}

interface SendPlan {
  index: number;
  count: number;
  bytesLeft: number;
  streaming: boolean;
  bufferSize: number;
}

async function sendFile(link: ZmodemLink, file: OutgoingFile, plan: SendPlan): Promise<'sent' | 'skipped'> {
  const { ctx, timing } = link;
  const mtime = Math.floor((file.mtimeMs ?? Date.now()) / 1000);
  const announcement = Buffer.concat([
    Buffer.from(baseName(file.name), 'utf8'),
    Buffer.from([0]),
    Buffer.from(
      `${file.size} ${mtime.toString(8)} 100644 0 ${plan.count - plan.index + 1} ${plan.bytesLeft}`,
      'ascii',
    ),
    Buffer.from([0]),
  ]);
  const report = (bytes: number) =>
    ctx.progress({ fileName: file.name, fileIndex: plan.index, fileCount: plan.count, bytes, total: file.size });
  report(0);

  let position: number | undefined;
  for (let attempt = 0; position === undefined; attempt++) {
    if (attempt > timing.retries) throw new TransferTimeoutError(`The remote side did not accept ${file.name}.`);
    link.binary(ZFILE, flagBytes(ZCBIN));
    link.write(encodeSubpacket(announcement, ZCRCW, link.crc32, link.encoder));
    for (;;) {
      let header: ZmodemHeader;
      try {
        header = await link.header();
      } catch (error) {
        if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
        break;
      }
      if (header.type === ZRPOS) {
        position = Math.min(headerPosition(header), file.size);
        break;
      }
      if (header.type === ZSKIP) return 'skipped';
      if (header.type === ZCRC) {
        // Resume check: the receiver wants the CRC-32 of the whole file.
        link.hex(ZCRC, positionBytes(await fileCrc(file)));
        continue;
      }
      // A repeated ZRINIT was sent before the receiver saw our ZFILE; its
      // answer follows. Only silence makes us offer the file again.
      if (header.type === ZRINIT) continue;
      if (header.type === ZNAK) break;
      if (header.type === ZCAN || header.type === ZABORT || header.type === ZFIN || header.type === ZFERR) {
        throw new RemoteCancelError();
      }
    }
  }

  let errors = 0;
  let errorAt = -1;
  const failedAt = (at: number) => {
    if (at > errorAt) errors = 0;
    errorAt = at;
    if (++errors > timing.retries) throw new TransferTimeoutError('Too many transmission errors.');
  };
  for (;;) {
    const reposition = await sendData(link, file, position, plan, report);
    if (reposition === 'skipped') return 'skipped';
    if (reposition !== undefined) {
      failedAt(reposition);
      position = Math.min(reposition, file.size);
      continue;
    }
    // Every byte is out; ZEOF until the receiver confirms with ZRINIT.
    let next: number | undefined;
    for (let attempt = 0; next === undefined; attempt++) {
      if (attempt > timing.retries) throw new TransferTimeoutError(`The remote side did not confirm ${file.name}.`);
      link.binary(ZEOF, positionBytes(file.size));
      let header: ZmodemHeader;
      try {
        header = await link.header();
      } catch (error) {
        if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
        continue;
      }
      if (header.type === ZRINIT) return 'sent';
      if (header.type === ZSKIP) return 'skipped';
      if (header.type === ZRPOS) next = headerPosition(header);
      else if (header.type === ZCAN || header.type === ZABORT || header.type === ZFERR) throw new RemoteCancelError();
    }
    failedAt(next);
    position = Math.min(next, file.size);
  }
}

async function fileCrc(file: OutgoingFile): Promise<number> {
  let crc = 0xffffffff;
  for (let position = 0; position < file.size; ) {
    const chunk = await file.read(position, Math.min(1024 * 1024, file.size - position));
    if (chunk.length === 0) break;
    crc = crc32Update(crc, chunk);
    position += chunk.length;
  }
  return ~crc >>> 0;
}

/**
 * Stream one file from `start`. Resolves undefined when the last subpacket
 * is out, a position when the receiver asked to go back, or 'skipped'.
 */
async function sendData(
  link: ZmodemLink,
  file: OutgoingFile,
  start: number,
  plan: SendPlan,
  report: (bytes: number) => void,
): Promise<number | 'skipped' | undefined> {
  const { ctx } = link;
  let position = start;
  let sinceAck = 0;
  link.binary(ZDATA, positionBytes(position));
  do {
    const chunk = await file.read(position, Math.min(BLOCK_SIZE, file.size - position));
    if (chunk.length === 0 && position < file.size) throw new Error(`${file.name} ended early.`);
    const last = position + chunk.length >= file.size;
    sinceAck += chunk.length;
    const waitForAck =
      !plan.streaming || (plan.bufferSize > 0 && sinceAck + BLOCK_SIZE > plan.bufferSize);
    const end = waitForAck ? ZCRCW : last ? ZCRCE : ZCRCG;
    link.write(encodeSubpacket(chunk, end, link.crc32, link.encoder));
    position += chunk.length;
    report(position);
    await ctx.output.drain();

    if (waitForAck) {
      sinceAck = 0;
      for (;;) {
        let header: ZmodemHeader;
        try {
          header = await link.header();
        } catch (error) {
          if (!(error instanceof TransferTimeoutError || error instanceof FrameError)) throw error;
          return position - chunk.length;
        }
        if (header.type === ZACK) break;
        const answer = interruption(header);
        if (answer !== undefined) return answer;
      }
      if (!last) link.binary(ZDATA, positionBytes(position));
      continue;
    }

    // A full-duplex receiver reports errors while we stream; look for a
    // header start among whatever it has sent back.
    while (ctx.input.available > 0) {
      const peek = ctx.input.peekByte();
      if (peek !== ZPAD && peek !== CAN) {
        ctx.input.tryByte();
        continue;
      }
      let header: ZmodemHeader;
      try {
        header = await link.header();
      } catch (error) {
        if (!(error instanceof FrameError)) throw error;
        continue;
      }
      if (header.type === ZACK) continue;
      const answer = interruption(header);
      if (answer !== undefined) return answer;
    }
  } while (position < file.size);
  return undefined;
}

function interruption(header: ZmodemHeader): number | 'skipped' | undefined {
  switch (header.type) {
    case ZRPOS:
      return headerPosition(header);
    case ZSKIP:
      return 'skipped';
    case ZCAN:
    case ZABORT:
    case ZFIN:
    case ZFERR:
      throw new RemoteCancelError();
    default:
      return undefined;
  }
}

/** Hex header type and flags as auto-start detection decoded them. */
export function hexHeaderFrom(type: number, data: Buffer): ZmodemHeader {
  return { type, data, format: ZHEX };
}
