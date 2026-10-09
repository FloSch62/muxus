import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ZmodemDetector } from '../../../server/src/file-transfer/zmodem-detector.js';
import { encodeHexHeader } from '../../../server/src/file-transfer/zmodem.js';

const ZRQINIT = encodeHexHeader(0, Buffer.alloc(4));
const ZRINIT = encodeHexHeader(1, Buffer.from([0, 0, 0, 0x23]));

/** Feed chunks, collecting the terminal output and the first detection. */
function run(chunks: Buffer[], detector = new ZmodemDetector()) {
  const output: Buffer[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const result = detector.feed(chunk);
    output.push(result.output);
    if (result.detection) {
      return { output: Buffer.concat(output).toString('latin1'), detection: result.detection, at: index };
    }
  }
  return { output: Buffer.concat(output).toString('latin1'), detection: undefined, held: detector.flush() };
}

describe('ZMODEM auto-start detection', () => {
  it('recognises sz and rz and hands over what follows the header', () => {
    const sz = run([Buffer.concat([Buffer.from('$ sz f.bin\r\n'), ZRQINIT, Buffer.from('more')])]);
    expect(sz.detection).toMatchObject({ type: 0 });
    expect(sz.output).toBe('$ sz f.bin\r\n');
    expect(sz.detection!.rest.toString('latin1')).toBe('\r\x8a\x11more');

    const rz = run([Buffer.concat([Buffer.from('rz waiting to receive.'), ZRINIT])]);
    expect(rz.detection).toMatchObject({ type: 1, data: Buffer.from([0, 0, 0, 0x23]) });
    expect(rz.output).toBe('rz waiting to receive.');
  });

  it('finds a header split at every possible point', () => {
    const stream = Buffer.concat([Buffer.from('prompt$ sz x\r\n'), ZRQINIT, Buffer.from('tail')]);
    for (let split = 1; split < stream.length; split++) {
      const result = run([stream.subarray(0, split), stream.subarray(split)]);
      expect(result.detection, `split at ${split}`).toBeDefined();
      // The header itself never reaches the terminal, except a "**" shown
      // before its continuation arrived.
      expect(result.output.replace(/\*+$/, '')).toBe('prompt$ sz x\r\n');
    }
  });

  it('finds a header delivered one byte at a time', () => {
    const stream = Buffer.concat([Buffer.from('x'), ZRINIT]);
    const result = run([...stream].map((byte) => Buffer.from([byte])));
    expect(result.detection).toMatchObject({ type: 1 });
  });

  it('keeps the "rz" that sz types off the screen', () => {
    expect(run([Buffer.concat([Buffer.from('rz\r'), ZRQINIT])]).output).toBe('');
    // Already shown by an earlier chunk: erase the line instead.
    expect(run([Buffer.from('rz\r'), ZRQINIT]).output).toBe('rz\r\x1b[2K');
  });

  it('finds a header after extra stars', () => {
    const result = run([Buffer.concat([Buffer.from('***'), ZRQINIT])]);
    expect(result.detection).toBeDefined();
    expect(result.output).toBe('***');
  });

  it('ignores look-alikes: bad CRC, other frame types, ordinary text', () => {
    const badCrc = Buffer.from(ZRQINIT);
    badCrc[17] = 0x31;
    const zfin = encodeHexHeader(8, Buffer.alloc(4));
    for (const text of [
      badCrc,
      zfin,
      Buffer.from('**bold** and **\x18B0 cut short\r\n'),
      Buffer.from('**\x18B00zz'),
      Buffer.from('ls *.bin **/*.c\r\n'),
    ]) {
      const result = run([text]);
      expect(result.detection).toBeUndefined();
      expect(result.output + result.held!.toString('latin1')).toBe(text.toString('latin1'));
    }
  });

  it('never fires on random binary output', () => {
    const detector = new ZmodemDetector();
    let seen = 0;
    for (let i = 0; i < 200; i++) {
      const chunk = randomBytes(8192);
      const result = detector.feed(chunk);
      expect(result.detection).toBeUndefined();
      seen += result.output.length;
    }
    expect(seen + detector.flush().length).toBe(200 * 8192);
  });

  it('holds a partial header back until it resolves or is flushed', () => {
    const detector = new ZmodemDetector();
    expect(detector.feed(Buffer.from('a**\x18B0')).output.toString('latin1')).toBe('a');
    expect(detector.holding).toBe(true);
    expect(detector.flush().toString('latin1')).toBe('**\x18B0');
    expect(detector.holding).toBe(false);
    // Text that only ends in stars is shown straight away.
    expect(detector.feed(Buffer.from('b')).output.toString('latin1')).toBe('b');
    expect(detector.feed(Buffer.from('c**')).output.toString('latin1')).toBe('c**');
    expect(detector.holding).toBe(false);
  });
});
