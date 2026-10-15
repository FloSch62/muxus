import type { IBufferLine } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { bufferText } from '../../../client/src/terminal/buffer-text.js';

/** A buffer of `cols`-wide rows; a row starting with `>` continues the one above. */
function buffer(cols: number, rows: string[]) {
  const lines = rows.map((row) => {
    const isWrapped = row.startsWith('>');
    const cells = isWrapped ? row.slice(1) : row;
    return {
      isWrapped,
      length: cols,
      translateToString: (...args: [trimRight?: boolean, start?: number, end?: number]) => {
        const [trimRight = false, start = 0, end = cols] = args;
        const text = cells.padEnd(cols, '\0').slice(start, end);
        if (!trimRight) return text.replaceAll('\0', ' ');
        // Like xterm's line cache, a canonical trimmed request also drops real spaces.
        if (args.length < 3) return text.replaceAll('\0', ' ').trimEnd();
        return text.replace(/\0+$/, '').replaceAll('\0', ' ');
      },
    } as unknown as IBufferLine;
  });
  return { length: lines.length, getLine: (index: number) => lines[index] };
}

describe('bufferText', () => {
  it('joins soft-wrapped rows back into one line', () => {
    expect(bufferText(buffer(8, ['interfac', '>e Gi0/1', ' shut', '', '']))).toBe('interface Gi0/1\n shut\n');
  });

  it('keeps a real space that ends a row before the wrap', () => {
    expect(bufferText(buffer(5, ['word ', '>2']))).toBe('word 2\n');
  });

  it('is empty for a blank buffer', () => {
    expect(bufferText(buffer(4, ['', '']))).toBe('');
  });
});
