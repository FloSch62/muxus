import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crc16, crc32 } from '../../../server/src/file-transfer/crc.js';
import {
  CANCEL_SEQUENCE,
  RemoteCancelError,
  TransferCancelledError,
  TransferInput,
  type IncomingFile,
  type OutgoingFile,
  type TransferContext,
  type TransferProgress,
} from '../../../server/src/file-transfer/transfer-io.js';
import {
  parseYmodemHeader,
  xmodemReceive,
  xmodemSend,
  ymodemReceive,
  ymodemSend,
} from '../../../server/src/file-transfer/xymodem.js';
import {
  encodeHexHeader,
  parseFileInfo,
  zmodemReceive,
  zmodemSend,
} from '../../../server/src/file-transfer/zmodem.js';

const FAST = { start: 2_000, startInterval: 200, reply: 500, byte: 200, retries: 10 };

interface Side {
  ctx: TransferContext;
  abort: AbortController;
  progress: TransferProgress[];
}

/**
 * Two protocol endpoints joined by an asynchronous in-memory line. `tamper`
 * may rewrite or drop bytes on their way from A to B.
 */
function line(tamper?: (data: Buffer, direction: 'ab' | 'ba') => Buffer) {
  const make = (): Side => {
    const abort = new AbortController();
    const progress: TransferProgress[] = [];
    return {
      abort,
      progress,
      ctx: {
        input: new TransferInput(abort.signal),
        output: { write: () => undefined, drain: async () => undefined },
        signal: abort.signal,
        progress: (update) => progress.push(update),
        timing: FAST,
      },
    };
  };
  const a = make();
  const b = make();
  const wire = (from: Side, to: Side, direction: 'ab' | 'ba') => {
    from.ctx.output.write = (data) => {
      const copy = Buffer.from(data);
      setImmediate(() => to.ctx.input.push(tamper ? tamper(copy, direction) : copy));
    };
  };
  wire(a, b, 'ab');
  wire(b, a, 'ba');
  return { a, b };
}

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function outgoing(name: string, data: Buffer): OutgoingFile {
  return {
    name,
    size: data.length,
    mtimeMs: 1_700_000_000_000,
    read: async (position, length) => data.subarray(position, position + length),
  };
}

function collector() {
  const files: Array<{ name?: string; data: Buffer; finished: boolean }> = [];
  const open = (name?: string): IncomingFile => {
    const entry = { name, data: Buffer.alloc(0), finished: false };
    files.push(entry);
    return {
      write: async (data) => {
        entry.data = Buffer.concat([entry.data, data]);
      },
      finish: async (size) => {
        if (size !== undefined) entry.data = entry.data.subarray(0, size);
        entry.finished = true;
      },
      discard: async () => {
        entry.data = Buffer.alloc(0);
      },
    };
  };
  return { files, open };
}

describe('transfer checksums', () => {
  it('match the standard check values', () => {
    expect(crc16(Buffer.from('123456789'))).toBe(0x31c3);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('XMODEM', () => {
  for (const [label, sendSize, crc] of [
    ['checksum', 128, false],
    ['CRC', 128, true],
    ['1K', 1024, true],
  ] as const) {
    it(`round-trips files with ${label} blocks`, async () => {
      for (const size of [0, 1, 127, 128, 129, 1024, 1025, 5000]) {
        const { a, b } = line();
        const data = randomBytes(size);
        const target = collector();
        await Promise.all([
          xmodemSend(a.ctx, outgoing('x.bin', data), { blockSize: sendSize }),
          xmodemReceive(b.ctx, target.open('x.bin'), { crc }),
        ]);
        const received = target.files[0]!.data;
        // XMODEM pads the last block with SUB.
        expect(received.subarray(0, size)).toEqual(data);
        expect(received.length % 128).toBe(0);
        expect([...received.subarray(size)].every((byte) => byte === 0x1a)).toBe(true);
      }
    });
  }

  it('resends a block the line damaged', async () => {
    let damaged = 0;
    const { a, b } = line((data, direction) => {
      if (direction === 'ab' && data.length > 100 && data[1] === 3 && damaged++ === 0) data[50] = data[50]! ^ 0xff;
      return data;
    });
    const data = randomBytes(1000);
    const target = collector();
    await Promise.all([
      xmodemSend(a.ctx, outgoing('x.bin', data), { blockSize: 128 }),
      xmodemReceive(b.ctx, target.open('x.bin'), { crc: true }),
    ]);
    expect(damaged).toBeGreaterThan(0);
    expect(target.files[0]!.data.subarray(0, 1000)).toEqual(data);
  });

  it('stops when the receiver sends CAN', async () => {
    const { a, b } = line();
    const sending = xmodemSend(a.ctx, outgoing('x.bin', randomBytes(100_000)), { blockSize: 1024 });
    b.ctx.output.write(Buffer.from('C'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    b.ctx.output.write(CANCEL_SEQUENCE);
    await expect(sending).rejects.toBeInstanceOf(RemoteCancelError);
  });

  it('unwinds when cancelled locally', async () => {
    const { a } = line();
    const sending = xmodemSend(a.ctx, outgoing('x.bin', randomBytes(100)), { blockSize: 128 });
    a.abort.abort();
    await expect(sending).rejects.toBeInstanceOf(TransferCancelledError);
  });

  it('gives up when no receiver starts', async () => {
    const { a } = line();
    a.ctx.timing = { ...FAST, start: 100 };
    await expect(xmodemSend(a.ctx, outgoing('x.bin', randomBytes(10)), { blockSize: 128 })).rejects.toThrow(
      /did not start receiving/,
    );
  });
});

describe('YMODEM', () => {
  it('round-trips a batch with exact file sizes and names', async () => {
    const { a, b } = line();
    const files = [
      outgoing('first.bin', randomBytes(3000)),
      outgoing('empty.txt', Buffer.alloc(0)),
      outgoing('dir/third.img', randomBytes(1024)),
    ];
    const target = collector();
    await Promise.all([
      ymodemSend(a.ctx, files),
      ymodemReceive(b.ctx, async (info) => target.open(info.name)),
    ]);
    expect(target.files.map((file) => file.name)).toEqual(['first.bin', 'empty.txt', 'third.img']);
    expect(target.files[0]!.data).toEqual(await files[0]!.read(0, 3000));
    expect(target.files[1]!.data.length).toBe(0);
    expect(target.files[2]!.data).toEqual(await files[2]!.read(0, 1024));
    expect(target.files.every((file) => file.finished)).toBe(true);
  });

  it('parses the header lrzsz and U-Boot use', () => {
    const header = Buffer.concat([
      Buffer.from('image.bin\x00'),
      Buffer.from('4194304 14612346601 100644 0 2 5000000\x00'),
      Buffer.alloc(40),
    ]);
    expect(parseYmodemHeader(header)).toEqual({
      name: 'image.bin',
      size: 4_194_304,
      mtimeMs: 0o14612346601 * 1000,
      filesLeft: 2,
      bytesLeft: 5_000_000,
    });
    expect(parseYmodemHeader(Buffer.alloc(128))).toBeUndefined();
  });
});

describe('ZMODEM', () => {
  it('encodes hex headers the way lrzsz does', () => {
    expect(encodeHexHeader(0, Buffer.alloc(4)).toString('latin1')).toBe('**\x18B00000000000000\r\x8a\x11');
    expect(encodeHexHeader(1, Buffer.from([0, 0, 0, 0x23])).toString('latin1')).toBe(
      '**\x18B0100000023be50\r\x8a\x11',
    );
  });

  it('reads the ZFILE announcement', () => {
    expect(parseFileInfo(Buffer.from('/tmp/f.bin\x001000 15261763327 100664 0 3 9000\x00'))).toEqual({
      name: 'f.bin',
      size: 1000,
      mtimeMs: 0o15261763327 * 1000,
      filesLeft: 3,
      bytesLeft: 9000,
    });
  });

  it('round-trips a batch, every byte value included', async () => {
    const { a, b } = line();
    const allBytes = Buffer.alloc(4096);
    for (let i = 0; i < allBytes.length; i++) allBytes[i] = i & 0xff;
    const files = [
      outgoing('all-bytes.bin', allBytes),
      outgoing('empty', Buffer.alloc(0)),
      outgoing('random.bin', randomBytes(300_000)),
    ];
    const target = collector();
    const [result] = await Promise.all([
      zmodemSend(a.ctx, files, { announce: true }),
      zmodemReceive(b.ctx, { open: async (info) => target.open(info.name) }),
    ]);
    expect(result).toEqual({ sent: ['all-bytes.bin', 'empty', 'random.bin'], skipped: [] });
    expect(target.files.map((file) => file.name)).toEqual(['all-bytes.bin', 'empty', 'random.bin']);
    expect(target.files[0]!.data).toEqual(allBytes);
    expect(target.files[1]!.data.length).toBe(0);
    expect(digest(target.files[2]!.data)).toBe(digest(await files[2]!.read(0, 300_000)));
    expect(b.progress.at(-1)).toMatchObject({ fileName: 'random.bin', fileIndex: 3, fileCount: 3, bytes: 300_000 });
  });

  it('recovers from damaged data with ZRPOS', async () => {
    let damaged = 0;
    const { a, b } = line((data, direction) => {
      if (direction === 'ab' && data.length > 500 && damaged < 3) {
        damaged++;
        data[200] = data[200]! ^ 0x55;
      }
      return data;
    });
    const payload = randomBytes(50_000);
    const target = collector();
    await Promise.all([
      zmodemSend(a.ctx, [outgoing('data.bin', payload)]),
      zmodemReceive(b.ctx, { open: async (info) => target.open(info.name) }),
    ]);
    expect(damaged).toBe(3);
    expect(digest(target.files[0]!.data)).toBe(digest(payload));
  });

  it('lets the receiver skip a file', async () => {
    const { a, b } = line();
    const target = collector();
    const [result] = await Promise.all([
      zmodemSend(a.ctx, [outgoing('keep.bin', randomBytes(10)), outgoing('skip.bin', randomBytes(10))]),
      zmodemReceive(b.ctx, {
        open: async (info) => (info.name === 'skip.bin' ? undefined : target.open(info.name)),
      }),
    ]);
    expect(result).toEqual({ sent: ['keep.bin'], skipped: ['skip.bin'] });
    expect(target.files.map((file) => file.name)).toEqual(['keep.bin']);
  });

  it('stops when the other side sends the abort sequence', async () => {
    const { a, b } = line();
    const receiving = zmodemReceive(b.ctx, { open: async () => collector().open() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    a.ctx.output.write(CANCEL_SEQUENCE);
    await expect(receiving).rejects.toBeInstanceOf(RemoteCancelError);
  });
});
