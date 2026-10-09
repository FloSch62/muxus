import { crc16 } from './crc.js';
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

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const SUB = 0x1a;
const CRC_REQUEST = 0x43; // 'C'

type Check = 'crc' | 'checksum';

export interface XmodemSendOptions {
  /** 1024 sends XMODEM-1K blocks once the receiver asks for CRC. */
  blockSize: 128 | 1024;
}

export interface XmodemReceiveOptions {
  /** Ask for CRC-16 blocks ('C') instead of the original checksum (NAK). */
  crc: boolean;
}

/** Wait for the receiver's NAK (checksum) or 'C' (CRC); other bytes are ignored. */
async function awaitStart(ctx: TransferContext, timeoutMs: number): Promise<Check> {
  const deadline = Date.now() + timeoutMs;
  let cancels = 0;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new TransferTimeoutError('The remote side did not start receiving.');
    let byte: number;
    try {
      byte = await ctx.input.byte(left);
    } catch (error) {
      if (error instanceof TransferTimeoutError) {
        throw new TransferTimeoutError('The remote side did not start receiving.');
      }
      throw error;
    }
    if (byte === CRC_REQUEST) return 'crc';
    if (byte === NAK) return 'checksum';
    if (byte === CAN) {
      if (++cancels >= 2) throw new RemoteCancelError();
    } else {
      cancels = 0;
    }
  }
}

function buildBlock(
  number: number,
  payload: Buffer,
  size: 128 | 1024,
  check: Check,
  pad = SUB,
): Buffer {
  const block = Buffer.alloc(3 + size + (check === 'crc' ? 2 : 1), pad);
  block[0] = size === 1024 ? STX : SOH;
  block[1] = number & 0xff;
  block[2] = 0xff - (number & 0xff);
  payload.copy(block, 3, 0, Math.min(payload.length, size));
  if (check === 'crc') {
    const crc = crc16(block, 0, 3, 3 + size);
    block[3 + size] = crc >> 8;
    block[4 + size] = crc & 0xff;
  } else {
    let sum = 0;
    for (let i = 3; i < 3 + size; i++) sum += block[i]!;
    block[3 + size] = sum & 0xff;
  }
  return block;
}

/**
 * Send one block (or EOT) until the receiver ACKs it. Stale input is dropped
 * first so an extra 'C' or NAK queued before the block cannot be mistaken
 * for its answer.
 */
async function sendUntilAcked(
  ctx: TransferContext,
  timing: TransferTiming,
  data: Buffer,
  what: string,
  retries = timing.retries,
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    ctx.input.discard();
    ctx.output.write(data);
    await ctx.output.drain();
    let cancels = 0;
    const deadline = Date.now() + timing.reply;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let reply: number;
      try {
        reply = await ctx.input.byte(left);
      } catch (error) {
        if (error instanceof TransferTimeoutError) break;
        throw error;
      }
      if (reply === ACK) return;
      if (reply === NAK) break;
      if (reply === CAN) {
        if (++cancels >= 2) throw new RemoteCancelError();
        continue;
      }
      cancels = 0;
    }
  }
  throw new TransferTimeoutError(`The remote side did not acknowledge ${what}.`);
}

async function sendData(
  ctx: TransferContext,
  timing: TransferTiming,
  file: OutgoingFile,
  check: Check,
  blockSize: 128 | 1024,
  report: (bytes: number) => void,
): Promise<void> {
  let position = 0;
  let number = 1;
  report(0);
  while (position < file.size) {
    const remaining = file.size - position;
    const size: 128 | 1024 = blockSize === 1024 && check === 'crc' && remaining > 128 ? 1024 : 128;
    const payload = await file.read(position, Math.min(size, remaining));
    if (payload.length === 0) throw new Error(`${file.name} ended early.`);
    await sendUntilAcked(ctx, timing, buildBlock(number, payload, size, check), `block ${number}`);
    position += payload.length;
    number = (number + 1) & 0xff;
    report(position);
  }
  await sendUntilAcked(ctx, timing, Buffer.from([EOT]), 'the end of the file');
}

/** Send one file with XMODEM; the receiver picks checksum or CRC. */
export async function xmodemSend(
  ctx: TransferContext,
  file: OutgoingFile,
  options: XmodemSendOptions,
): Promise<void> {
  const timing = timingOf(ctx);
  const check = await awaitStart(ctx, timing.start);
  await sendData(ctx, timing, file, check, options.blockSize, (bytes) =>
    ctx.progress({ fileName: file.name, fileIndex: 1, fileCount: 1, bytes, total: file.size }),
  );
}

/** YMODEM block 0: name, NUL, then size, mtime and mode the way lrzsz writes them. */
export function ymodemHeader(file: OutgoingFile, filesLeft: number, bytesLeft: number): Buffer {
  const mtime = Math.floor((file.mtimeMs ?? Date.now()) / 1000);
  const fields = `${file.size} ${mtime.toString(8)} 100644 0 ${filesLeft} ${bytesLeft}`;
  return Buffer.concat([Buffer.from(baseName(file.name), 'utf8'), Buffer.from([0]), Buffer.from(fields, 'ascii'), Buffer.from([0])]);
}

/** Send a batch with YMODEM, ending with the empty block 0. */
export async function ymodemSend(ctx: TransferContext, files: OutgoingFile[]): Promise<void> {
  const timing = timingOf(ctx);
  let bytesLeft = files.reduce((sum, file) => sum + file.size, 0);
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const check = await awaitStart(ctx, index === 0 ? timing.start : timing.reply);
    const header = ymodemHeader(file, files.length - index, bytesLeft);
    const headerSize: 128 | 1024 = header.length > 128 ? 1024 : 128;
    if (header.length > 1024) throw new Error(`The file name ${file.name} is too long for YMODEM.`);
    ctx.progress({ fileName: file.name, fileIndex: index + 1, fileCount: files.length, bytes: 0, total: file.size });
    await sendUntilAcked(ctx, timing, buildBlock(0, header, headerSize, check, 0), 'the file header');
    const dataCheck = await awaitStart(ctx, timing.reply);
    await sendData(ctx, timing, file, dataCheck, 1024, (bytes) =>
      ctx.progress({
        fileName: file.name,
        fileIndex: index + 1,
        fileCount: files.length,
        bytes,
        total: file.size,
      }),
    );
    bytesLeft -= file.size;
  }
  // Some receivers (U-Boot among them) leave once the last file is in and
  // never ask for, or acknowledge, the closing empty header.
  try {
    const check = await awaitStart(ctx, timing.reply);
    await sendUntilAcked(ctx, timing, buildBlock(0, Buffer.alloc(0), 128, check, 0), 'the end of the batch', 2);
  } catch (error) {
    if (!(error instanceof TransferTimeoutError)) throw error;
  }
}

type Block =
  | { kind: 'block'; number: number; data: Buffer }
  | { kind: 'eot' }
  | { kind: 'bad' };

/** Read one block, EOT or a cancel. Garbage before the header is skipped. */
async function readBlock(ctx: TransferContext, timing: TransferTiming, check: Check, timeoutMs: number): Promise<Block> {
  const deadline = Date.now() + timeoutMs;
  let first: number;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new TransferTimeoutError();
    first = await ctx.input.byte(left);
    if (first === SOH || first === STX || first === EOT) break;
    if (first === CAN) {
      const next = await ctx.input.byte(timing.byte).catch(() => undefined);
      if (next === CAN) throw new RemoteCancelError();
      return { kind: 'bad' };
    }
  }
  if (first === EOT) return { kind: 'eot' };
  const size = first === STX ? 1024 : 128;
  let rest: Buffer;
  try {
    rest = await ctx.input.bytes(2 + size + (check === 'crc' ? 2 : 1), timing.byte);
  } catch (error) {
    if (error instanceof TransferTimeoutError) return { kind: 'bad' };
    throw error;
  }
  if (rest[0]! + rest[1]! !== 0xff) return { kind: 'bad' };
  if (check === 'crc') {
    const crc = crc16(rest, 0, 2, 2 + size);
    if (rest[2 + size] !== crc >> 8 || rest[3 + size] !== (crc & 0xff)) return { kind: 'bad' };
  } else {
    let sum = 0;
    for (let i = 2; i < 2 + size; i++) sum += rest[i]!;
    if (rest[2 + size] !== (sum & 0xff)) return { kind: 'bad' };
  }
  return { kind: 'block', number: rest[0]!, data: rest.subarray(2, 2 + size) };
}

/** Let a garbled block finish arriving, then forget it. */
async function purge(ctx: TransferContext, timing: TransferTiming): Promise<void> {
  ctx.input.discard();
  while (await ctx.input.optional(() => true, Math.min(timing.byte, 250))) ctx.input.discard();
}

/**
 * Receive data blocks until EOT. `firstEot` decides whether the first EOT is
 * NAKed (YMODEM's confirmation) or accepted at once (XMODEM).
 */
async function receiveData(
  ctx: TransferContext,
  timing: TransferTiming,
  check: Check,
  target: IncomingFile,
  size: number | undefined,
  confirmEot: boolean,
  report: (bytes: number) => void,
  start: () => void,
): Promise<number> {
  let expected = 1;
  let received = 0;
  let errors = 0;
  let sawEot = false;
  let started = false;
  for (;;) {
    let block: Block;
    try {
      block = await readBlock(ctx, timing, check, started ? timing.reply : timing.startInterval);
    } catch (error) {
      if (!(error instanceof TransferTimeoutError)) throw error;
      if (++errors > (started ? timing.retries : Math.ceil(timing.start / timing.startInterval))) {
        throw new TransferTimeoutError();
      }
      if (started) ctx.output.write(Buffer.from([NAK]));
      else start();
      continue;
    }
    if (block.kind === 'bad') {
      if (++errors > timing.retries) throw new TransferTimeoutError('Too many damaged blocks.');
      await purge(ctx, timing);
      ctx.output.write(Buffer.from([NAK]));
      continue;
    }
    if (block.kind === 'eot') {
      if (confirmEot && !sawEot) {
        sawEot = true;
        ctx.output.write(Buffer.from([NAK]));
        continue;
      }
      ctx.output.write(Buffer.from([ACK]));
      return received;
    }
    started = true;
    sawEot = false;
    if (block.number === expected) {
      const keep = size === undefined ? block.data.length : Math.max(0, Math.min(block.data.length, size - received));
      if (keep > 0) await target.write(block.data.subarray(0, keep));
      received += keep;
      expected = (expected + 1) & 0xff;
      errors = 0;
      ctx.output.write(Buffer.from([ACK]));
      report(received);
    } else if (block.number === ((expected - 1) & 0xff)) {
      // Our ACK was lost and the sender repeated the block.
      ctx.output.write(Buffer.from([ACK]));
    } else {
      throw new Error('The transfer lost block synchronisation.');
    }
  }
}

/** Receive one file with XMODEM. Its length is a whole number of blocks. */
export async function xmodemReceive(
  ctx: TransferContext,
  target: IncomingFile,
  options: XmodemReceiveOptions & { fileName?: string },
): Promise<void> {
  const timing = timingOf(ctx);
  const check: Check = options.crc ? 'crc' : 'checksum';
  const request = () => ctx.output.write(Buffer.from([options.crc ? CRC_REQUEST : NAK]));
  request();
  await receiveData(
    ctx,
    timing,
    check,
    target,
    undefined,
    false,
    (bytes) => ctx.progress({ fileName: options.fileName, fileIndex: 1, fileCount: 1, bytes }),
    request,
  );
  await target.finish();
}

export function parseYmodemHeader(data: Buffer): IncomingFileInfo | undefined {
  const nul = data.indexOf(0);
  if (nul <= 0) return undefined;
  const name = data.subarray(0, nul).toString('utf8');
  const end = data.indexOf(0, nul + 1);
  const fields = data
    .subarray(nul + 1, end < 0 ? data.length : end)
    .toString('ascii')
    .trim()
    .split(/\s+/);
  const size = fields[0] ? Number.parseInt(fields[0], 10) : Number.NaN;
  const mtime = fields[1] ? Number.parseInt(fields[1], 8) : Number.NaN;
  const filesLeft = fields[4] ? Number.parseInt(fields[4], 10) : Number.NaN;
  const bytesLeft = fields[5] ? Number.parseInt(fields[5], 10) : Number.NaN;
  return {
    name,
    ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    ...(Number.isFinite(mtime) && mtime > 0 ? { mtimeMs: mtime * 1000 } : {}),
    ...(Number.isSafeInteger(filesLeft) && filesLeft > 0 ? { filesLeft } : {}),
    ...(Number.isSafeInteger(bytesLeft) && bytesLeft >= 0 ? { bytesLeft } : {}),
  };
}

/** Receive a YMODEM batch; `open` is asked for a target per announced file. */
export async function ymodemReceive(
  ctx: TransferContext,
  open: (info: IncomingFileInfo, index: number) => Promise<IncomingFile>,
): Promise<void> {
  const timing = timingOf(ctx);
  const request = () => ctx.output.write(Buffer.from([CRC_REQUEST]));
  for (let index = 1; ; index++) {
    request();
    let attempts = 0;
    let header: Buffer | undefined;
    const tries = Math.ceil((index === 1 ? timing.start : timing.reply) / timing.startInterval);
    while (!header) {
      let block: Block;
      try {
        block = await readBlock(ctx, timing, 'crc', timing.startInterval);
      } catch (error) {
        if (!(error instanceof TransferTimeoutError)) throw error;
        if (++attempts > tries) throw new TransferTimeoutError('The remote side did not start sending.');
        request();
        continue;
      }
      if (block.kind === 'eot') {
        // The previous file's final EOT again: our ACK was lost.
        ctx.output.write(Buffer.from([ACK]));
        continue;
      }
      if (block.kind === 'bad' || block.number !== 0) {
        if (++attempts > tries) throw new TransferTimeoutError('The remote side did not start sending.');
        await purge(ctx, timing);
        ctx.output.write(Buffer.from([NAK]));
        continue;
      }
      header = block.data;
    }
    const info = parseYmodemHeader(header);
    ctx.output.write(Buffer.from([ACK]));
    if (!info) return;
    const target = await open(info, index);
    try {
      request();
      const fileCount = info.filesLeft === undefined ? undefined : index - 1 + info.filesLeft;
      const report = (bytes: number) =>
        ctx.progress({ fileName: info.name, fileIndex: index, fileCount, bytes, total: info.size });
      report(0);
      await receiveData(ctx, timing, 'crc', target, info.size, true, report, request);
      await target.finish(info.size);
    } catch (error) {
      await target.discard();
      throw error;
    }
  }
}
