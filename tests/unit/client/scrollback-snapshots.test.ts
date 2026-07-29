import { describe, expect, it } from 'vitest';
import {
  serializeScrollback,
  snapshotBodyBytes,
  SNAPSHOT_SCROLLBACK_LADDER,
  stripTerminalHistoryDividers,
  TERMINAL_HISTORY_DIVIDER,
  trimReplayTail,
} from '../../../client/src/terminal/scrollback-snapshots.js';
import { PAGE_KEEPALIVE_BODY_LIMIT_BYTES } from '../../../client/src/unload-keepalive.js';

/** Stand-in addon whose output shrinks with the requested scrollback depth.
 *  Typed off serializeScrollback so the tests package needs no xterm dependency. */
type Addon = Parameters<typeof serializeScrollback>[0];

function fakeAddon(charsPerLine: number, options: { escapes?: boolean } = {}): Addon {
  const unit = options.escapes ? '\u001b[31mx\u001b[0m' : 'x';
  return {
    serialize: ({ scrollback = 0 }: { scrollback?: number } = {}) =>
      unit.repeat(scrollback * charsPerLine),
  } as unknown as Addon;
}

function literalAddon(data: string): Addon {
  return {
    serialize: () => data,
  } as unknown as Addon;
}

describe('replay tail trimming', () => {
  it('drops the blank viewport remainder and the cursor repositioning', () => {
    const serialized =
      'deploy@web-01:~$ echo hi\r\nhi\r\n\u001b[38;5;114mdeploy@web-01\u001b[0m$ ' +
      '\r\n'.repeat(37) +
      '\u001b[37A\u001b[17C';

    expect(trimReplayTail(serialized)).toBe(
      'deploy@web-01:~$ echo hi\r\nhi\r\n\u001b[38;5;114mdeploy@web-01\u001b[0m$ ',
    );
  });

  it('leaves content without a trailing tail untouched', () => {
    expect(trimReplayTail('plain output')).toBe('plain output');
    expect(trimReplayTail('')).toBe('');
  });

  it('strips interleaved newline and cursor-move runs completely', () => {
    expect(trimReplayTail('kept\r\n\u001b[2A\r\n\u001b[5;7H')).toBe('kept');
  });

  it('keeps colours and non-movement sequences in place', () => {
    const colored = '\u001b[31mred\u001b[0m';
    expect(trimReplayTail(colored)).toBe(colored);
  });

  it('keeps plain text ending in a cursor-move letter', () => {
    expect(trimReplayTail('cd /srv && make USA')).toBe('cd /srv && make USA');
    expect(trimReplayTail('PATH')).toBe('PATH');
    expect(trimReplayTail('[17C')).toBe('[17C');
  });

  it('handles long interior newline runs in linear time', () => {
    const pathological = ('\r\n'.repeat(1_000) + 'x').repeat(20);
    const started = Date.now();
    expect(trimReplayTail(pathological)).toBe(pathological);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('history divider', () => {
  it('is a dim single line between restored and live output', () => {
    expect(TERMINAL_HISTORY_DIVIDER).toContain('[end of restored output]');
    expect(TERMINAL_HISTORY_DIVIDER.startsWith('\r\n')).toBe(true);
    expect(TERMINAL_HISTORY_DIVIDER.endsWith('\r\n')).toBe(true);
  });

  it('does not retain injected dividers in the next snapshot', () => {
    const nested =
      `first restore${TERMINAL_HISTORY_DIVIDER}` +
      `second restore${TERMINAL_HISTORY_DIVIDER}` +
      'live output';

    expect(stripTerminalHistoryDividers(nested)).toBe(
      'first restore\r\nsecond restore\r\nlive output',
    );
    expect(serializeScrollback(literalAddon(nested))).toBe(
      'first restore\r\nsecond restore\r\nlive output',
    );
  });

  it('recognizes serialized divider rows independent of their SGR encoding', () => {
    const serialized =
      'before\r\n\x1b[38;5;8m[end of restored output]\x1b[39m\r\nafter';

    expect(stripTerminalHistoryDividers(serialized)).toBe('before\r\nafter');
  });

  it('keeps terminal output that merely mentions the divider text', () => {
    const output = 'echo [end of restored output]\r\n[end of restored output] from remote';

    expect(stripTerminalHistoryDividers(output)).toBe(output);
  });
});

describe('snapshot size budgeting', () => {
  it('measures the JSON body, not the buffer — escapes inflate ESC sixfold', () => {
    expect(snapshotBodyBytes('ab')).toBe('{"data":"ab"}'.length);
    // One ESC becomes the six characters \u001b in the JSON body.
    expect(snapshotBodyBytes('\u001b')).toBe('{"data":""}'.length + 6);
  });

  it('serializes at the deepest scrollback that fits the wire budget', () => {
    const data = serializeScrollback(fakeAddon(40), { maxBodyBytes: 8_000 });
    expect(data).toBeDefined();
    expect(snapshotBodyBytes(data!)).toBeLessThanOrEqual(8_000);
    // Deeper than the smallest rung: the ladder stepped down, it did not bottom out.
    expect(data!.length).toBeGreaterThan(SNAPSHOT_SCROLLBACK_LADDER.at(-1)! * 40);
  });

  it('keeps a colour-heavy buffer under the keepalive cap', () => {
    const data = serializeScrollback(fakeAddon(80, { escapes: true }), {
      maxBodyBytes: PAGE_KEEPALIVE_BODY_LIMIT_BYTES,
    });
    expect(data).toBeDefined();
    expect(snapshotBodyBytes(data!)).toBeLessThanOrEqual(PAGE_KEEPALIVE_BODY_LIMIT_BYTES);
  });

  it('takes the full depth when no budget is imposed', () => {
    const data = serializeScrollback(fakeAddon(40));
    expect(data).toBe('x'.repeat(SNAPSHOT_SCROLLBACK_LADDER[0]! * 40));
  });

  it('reports nothing for an empty buffer', () => {
    expect(serializeScrollback(fakeAddon(0))).toBeUndefined();
  });
});
