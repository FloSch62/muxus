import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CANCEL_SEQUENCE,
  TransferInput,
  type IncomingFile,
  type OutgoingFile,
  type TransferContext,
} from '../../../server/src/file-transfer/transfer-io.js';
import {
  xmodemReceive,
  xmodemSend,
  ymodemReceive,
  ymodemSend,
} from '../../../server/src/file-transfer/xymodem.js';
import { hexHeaderFrom, zmodemReceive, zmodemSend } from '../../../server/src/file-transfer/zmodem.js';
import { ZmodemDetector, type ZmodemDetection } from '../../../server/src/file-transfer/zmodem-detector.js';

/**
 * Interoperability with lrzsz, the reference implementation. Runs when its
 * programs are on PATH or in LRZSZ_DIR (Debian/Ubuntu: sz, rz, sx, rx, sb,
 * rb; Fedora prefixes them with "l").
 */
function findLrzsz(): ((name: string) => string) | undefined {
  const dirs = [process.env.LRZSZ_DIR, ...(process.env.PATH ?? '').split(path.delimiter)].filter(
    (dir): dir is string => !!dir,
  );
  for (const prefix of ['', 'l']) {
    const dir = dirs.find((candidate) => existsSync(path.join(candidate, `${prefix}sz`)) && existsSync(path.join(candidate, `${prefix}rb`)));
    if (dir) return (name) => path.join(dir, `${prefix}${name}`);
  }
  return undefined;
}

const program = findLrzsz();
const work = mkdtempSync(path.join(os.tmpdir(), 'muxus-lrzsz-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function peer(name: string, args: string[], cwd: string) {
  const child = spawn(program!(name), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const abort = new AbortController();
  const input = new TransferInput(abort.signal);
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString('latin1');
  });
  child.stdin.on('error', () => undefined);
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const ctx: TransferContext = {
    input,
    output: {
      write: (data) => {
        if (child.stdin.writable) child.stdin.write(data);
      },
      drain: () =>
        child.stdin.writableNeedDrain && child.stdin.writable
          ? new Promise((resolve) => {
              child.stdin.once('drain', () => resolve());
              child.stdin.once('close', () => resolve());
            })
          : Promise.resolve(),
    },
    signal: abort.signal,
    progress: () => undefined,
  };
  return { child, ctx, input, exited, stderr: () => stderr };
}

/** Feed the program's output through auto-start detection, as a terminal would. */
function detect(proc: ReturnType<typeof peer>): Promise<ZmodemDetection> {
  const detector = new ZmodemDetector();
  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      const { detection } = detector.feed(data);
      if (!detection) return;
      proc.child.stdout.off('data', onData);
      proc.child.stdout.on('data', (more: Buffer) => proc.input.push(more));
      proc.input.push(detection.rest);
      resolve(detection);
    };
    proc.child.stdout.on('data', onData);
  });
}

function wire(proc: ReturnType<typeof peer>): void {
  proc.child.stdout.on('data', (data: Buffer) => proc.input.push(data));
}

function memoryTarget() {
  const files: Array<{ name: string; data: Buffer[] }> = [];
  return {
    files,
    open(name: string): IncomingFile {
      const entry = { name, data: [] as Buffer[] };
      files.push(entry);
      let size: number | undefined;
      return {
        write: async (data) => {
          entry.data.push(Buffer.from(data));
        },
        finish: async (keep) => {
          size = keep;
          if (size !== undefined) entry.data = [Buffer.concat(entry.data).subarray(0, size)];
        },
        discard: async () => undefined,
      };
    },
    content: (index: number) => Buffer.concat(files[index]!.data),
  };
}

function outgoing(file: string): OutgoingFile {
  const data = readFileSync(file);
  return {
    name: path.basename(file),
    size: data.length,
    read: async (position, length) => data.subarray(position, position + length),
  };
}

function fixture(name: string, size: number): { file: string; data: Buffer } {
  const data = randomBytes(size);
  // Bytes that need escaping somewhere: IAC, ZDLE, XON/XOFF, CR after '@'.
  const special = [0xff, 0xff, 0x18, 0x11, 0x13, 0x40, 0x0d, 0x1a];
  data.set(special.slice(0, size), 0);
  const file = path.join(work, name);
  writeFileSync(file, data);
  return { file, data };
}

describe.skipIf(!program)('file transfers against lrzsz', () => {
  it('receives a batch from sz through auto-start detection', async () => {
    const one = fixture('zsend-one.bin', 1_500_000);
    const two = fixture('zsend-two.bin', 777);
    const sz = peer('sz', [one.file, two.file], work);
    const detection = await detect(sz);
    expect(detection.type).toBe(0);
    const target = memoryTarget();
    await zmodemReceive(sz.ctx, { open: async (info) => target.open(info.name) });
    expect(await sz.exited).toBe(0);
    expect(target.files.map((file) => file.name)).toEqual(['zsend-one.bin', 'zsend-two.bin']);
    expect(digest(target.content(0))).toBe(digest(one.data));
    expect(digest(target.content(1))).toBe(digest(two.data));
  });

  it('sends a batch to rz through auto-start detection', async () => {
    const one = fixture('zrecv-one.bin', 1_200_000);
    const two = fixture('zrecv-two.bin', 0);
    const destination = mkdtempSync(path.join(work, 'rz-'));
    const rz = peer('rz', [], destination);
    const detection = await detect(rz);
    expect(detection.type).toBe(1);
    const result = await zmodemSend(rz.ctx, [outgoing(one.file), outgoing(two.file)], {
      receiverInit: hexHeaderFrom(detection.type, detection.data),
    });
    expect(await rz.exited).toBe(0);
    expect(result).toEqual({ sent: ['zrecv-one.bin', 'zrecv-two.bin'], skipped: [] });
    expect(digest(readFileSync(path.join(destination, 'zrecv-one.bin')))).toBe(digest(one.data));
    expect(readFileSync(path.join(destination, 'zrecv-two.bin')).length).toBe(0);
  });

  it('reports files rz refuses to overwrite as skipped', async () => {
    const one = fixture('exists.bin', 100);
    const destination = mkdtempSync(path.join(work, 'rz-'));
    writeFileSync(path.join(destination, 'exists.bin'), 'old');
    const rz = peer('rz', [], destination);
    wire(rz);
    const result = await zmodemSend(rz.ctx, [outgoing(one.file)]);
    expect(await rz.exited).toBe(0);
    expect(result).toEqual({ sent: [], skipped: ['exists.bin'] });
    expect(readFileSync(path.join(destination, 'exists.bin'), 'utf8')).toBe('old');
  });

  it('sends with YMODEM to rb and receives from sb', async () => {
    const image = fixture('ymodem.img', 300_000);
    const destination = mkdtempSync(path.join(work, 'rb-'));
    const rb = peer('rb', [], destination);
    wire(rb);
    await ymodemSend(rb.ctx, [outgoing(image.file)]);
    expect(await rb.exited).toBe(0);
    expect(digest(readFileSync(path.join(destination, 'ymodem.img')))).toBe(digest(image.data));

    const sb = peer('sb', [image.file], work);
    wire(sb);
    const target = memoryTarget();
    await ymodemReceive(sb.ctx, async (info) => target.open(info.name!));
    expect(await sb.exited).toBe(0);
    expect(target.files[0]!.name).toBe('ymodem.img');
    expect(digest(target.content(0))).toBe(digest(image.data));
  });

  for (const [label, sendArgs, blockSize, crc] of [
    ['checksum', [], 128, false],
    ['CRC', [], 128, true],
    ['1K', ['-k'], 1024, true],
  ] as const) {
    it(`sends and receives XMODEM ${label}`, async () => {
      const payload = fixture(`xmodem-${label}.bin`, 70_000);
      const received = path.join(work, `xmodem-${label}-received.bin`);
      const rx = peer('rx', [...(crc ? ['-c'] : []), received], work);
      wire(rx);
      await xmodemSend(rx.ctx, outgoing(payload.file), { blockSize });
      expect(await rx.exited).toBe(0);
      const got = readFileSync(received);
      expect(digest(got.subarray(0, payload.data.length))).toBe(digest(payload.data));

      const sx = peer('sx', [...sendArgs, payload.file], work);
      wire(sx);
      const target = memoryTarget();
      await xmodemReceive(sx.ctx, target.open('x.bin'), { crc });
      expect(await sx.exited).toBe(0);
      expect(digest(target.content(0).subarray(0, payload.data.length))).toBe(digest(payload.data));
    });
  }

  it('cancels sz and rz with the CAN sequence', async () => {
    const big = fixture('cancel.bin', 30_000_000);
    const sz = peer('sz', [big.file], work);
    await detect(sz);
    const receiving = zmodemReceive(sz.ctx, {
      open: async () => ({ write: async () => undefined, finish: async () => undefined, discard: async () => undefined }),
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    sz.ctx.output.write(CANCEL_SEQUENCE);
    sz.child.stdin.end();
    expect(await sz.exited).not.toBe(0);
    expect(await receiving).toBeInstanceOf(Error);

    const destination = mkdtempSync(path.join(work, 'rz-'));
    const rz = peer('rz', [], destination);
    const detection = await detect(rz);
    const sending = zmodemSend(rz.ctx, [outgoing(big.file)], {
      receiverInit: hexHeaderFrom(detection.type, detection.data),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    rz.ctx.output.write(CANCEL_SEQUENCE);
    await expect(sending).rejects.toThrow(/cancelled/);
    expect(await rz.exited).not.toBe(0);
  });
});
