import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PASTE_ERROR_PATTERN,
  DEFAULT_PASTE_PROMPT_PATTERN,
  type PastePromptWait,
} from '@muxus/shared';
import { PastePacer, type PasteProgress } from '../../../server/src/ws/paste-pacer.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A pacer whose writes are recorded with the fake clock's time. */
function recordingPacer(write?: (data: Buffer) => Promise<void> | void) {
  const writes: Array<{ at: number; data: string }> = [];
  const reports: PasteProgress[] = [];
  const start = Date.now();
  const pacer = new PastePacer(
    (data) => {
      writes.push({ at: Date.now() - start, data: data.toString('utf8') });
      return write?.(data);
    },
    (progress) => reports.push(progress),
  );
  return { pacer, writes, reports };
}

const paste = (text: string, lineDelayMs: number, charDelayMs = 0, bracketed = false) => ({
  text,
  bracketed,
  lineDelayMs,
  charDelayMs,
});

describe('paced pastes', () => {
  it('types a line at a time with the line delay between them', async () => {
    const { pacer, writes, reports } = recordingPacer();

    pacer.enqueue(paste('interface ge-0/0/1\ndescription uplink\nexit\n', 250));
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'interface ge-0/0/1\r' },
      { at: 250, data: 'description uplink\r' },
      { at: 500, data: 'exit\r' },
    ]);
    expect(reports[0]).toEqual({ state: 'running', line: 2, lines: 3, sent: 19, total: 43 });
    expect(reports.at(-1)).toEqual({ state: 'done', line: 3, lines: 3, sent: 43, total: 43 });
  });

  it('types a character at a time with a character delay', async () => {
    const { pacer, writes } = recordingPacer();

    pacer.enqueue(paste('ab\nc', 100, 10));
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'a' },
      { at: 10, data: 'b' },
      { at: 20, data: '\r' },
      { at: 130, data: 'c' },
    ]);
  });

  it('encloses the whole paste in one pair of bracketed-paste markers', async () => {
    const { pacer, writes } = recordingPacer();

    pacer.enqueue(paste('one\ntwo\nthree\x1b[201~\n', 100, 0, true));
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual([
      '\x1b[200~one\r',
      'two\r',
      'three\u241b[201~\r\x1b[201~',
    ]);
  });

  it('starts each wait only once the transport has taken the write', async () => {
    let release!: () => void;
    const { pacer, writes } = recordingPacer((data) =>
      data.toString() === 'slow\r'
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined,
    );

    pacer.enqueue(paste('slow\nnext\n', 100));
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.map((write) => write.data)).toEqual(['slow\r']);

    release();
    await vi.advanceTimersByTimeAsync(99);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes.at(-1)).toEqual({ at: 1100, data: 'next\r' });
  });

  it('queues a second paste behind the first and reports progress over both', async () => {
    const { pacer, writes, reports } = recordingPacer();

    pacer.enqueue(paste('a\nb\n', 100));
    pacer.enqueue(paste('c\nd\n', 300));
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'a\r' },
      { at: 100, data: 'b\r' },
      { at: 100, data: 'c\r' },
      { at: 400, data: 'd\r' },
    ]);
    expect(reports.every((report) => report.lines === 4 && report.total === 8)).toBe(true);
    expect(reports.at(-1)).toMatchObject({ state: 'done', sent: 8 });
  });

  it('reports a long paste at most every 200 ms', async () => {
    const { pacer, reports } = recordingPacer();

    pacer.enqueue(paste('x\n'.repeat(100), 10));
    await vi.runAllTimersAsync();

    // 990 ms of waits: the first report, one per 200 ms, and the final one.
    expect(reports.filter((report) => report.state === 'running').length).toBeLessThanOrEqual(6);
    expect(reports.at(-1)).toMatchObject({ state: 'done', line: 100, lines: 100 });
  });

  it('sends nothing to report for a paste that needs no wait', async () => {
    const { pacer, writes, reports } = recordingPacer();

    pacer.enqueue(paste('single line', 500));
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual(['single line']);
    expect(reports).toEqual([]);
  });

  it('stops on cancel, closing the bracket so the shell leaves paste mode', async () => {
    const { pacer, writes, reports } = recordingPacer();

    pacer.enqueue(paste('a\nb\nc\nd\n', 100, 0, true));
    pacer.enqueue(paste('queued\n', 100));
    await vi.advanceTimersByTimeAsync(150);
    pacer.cancel();
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual(['\x1b[200~a\r', 'b\r', '\x1b[201~']);
    expect(reports.at(-1)).toMatchObject({ state: 'cancelled', sent: 4, total: 15 });

    // The next paste starts afresh.
    pacer.enqueue(paste('e\nf\n', 100));
    await vi.runAllTimersAsync();
    expect(writes.slice(3).map((write) => write.data)).toEqual(['e\r', 'f\r']);
    expect(reports.at(-1)).toMatchObject({ state: 'done', lines: 2, total: 4 });
  });

  it('keeps a paste sent in the same tick as a cancel', async () => {
    const { pacer, writes, reports } = recordingPacer();

    pacer.enqueue(paste('a\nb\nc\n', 100, 0, true));
    await vi.advanceTimersByTimeAsync(150);
    // The ws library emits frames that arrive together in one tick.
    pacer.cancel();
    pacer.enqueue(paste('d\ne\n', 100));
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual([
      '\x1b[200~a\r',
      'b\r',
      '\x1b[201~',
      'd\r',
      'e\r',
    ]);
    expect(reports.find((report) => report.state === 'cancelled')).toMatchObject({
      lines: 3,
      sent: 4,
      total: 6,
    });
    expect(reports.at(-1)).toMatchObject({ state: 'done', lines: 2, sent: 4, total: 4 });
  });

  it('stops without writing or reporting anything more once the session is gone', async () => {
    const { pacer, writes, reports } = recordingPacer();

    pacer.enqueue(paste('a\nb\nc\n', 100, 0, true));
    await vi.advanceTimersByTimeAsync(50);
    const reported = reports.length;
    pacer.close();
    pacer.enqueue(paste('late\n', 100));
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual(['\x1b[200~a\r']);
    expect(reports).toHaveLength(reported);
  });

  it('gives up when the transport fails a write', async () => {
    const { pacer, writes, reports } = recordingPacer((data) =>
      data.toString() === 'b\r' ? Promise.reject(new Error('port closed')) : undefined,
    );

    pacer.enqueue(paste('a\nb\nc\n', 100));
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual(['a\r', 'b\r']);
    expect(reports.at(-1)).toMatchObject({ state: 'cancelled' });
  });
});

const PROMPT = 'R1(config)#';
const REJECTED = "% Invalid input detected at '^' marker.";
const prompted = (overrides: Partial<PastePromptWait> = {}) => ({
  promptPattern: DEFAULT_PASTE_PROMPT_PATTERN,
  timeoutMs: 1000,
  errorPattern: DEFAULT_PASTE_ERROR_PATTERN,
  ...overrides,
});

/**
 * A pacer typing into a fake IOS console: each line is echoed, then
 * answered after `answerMs` with the prompt, or rejected first when it
 * starts with "bogus". `answer` replaces that reply, in chunks.
 */
function consolePacer(
  options: { answerMs?: number; answer?: (line: string) => string[] | undefined } = {},
) {
  const answerMs = options.answerMs ?? 30;
  let pacer!: PastePacer;
  const harness = recordingPacer((data) => {
    const text = data.toString('utf8');
    if (!text.endsWith('\r')) return;
    const line = text.slice(0, -1);
    const reply = options.answer?.(line) ?? [
      `${line}\r\n`,
      line.startsWith('bogus') ? `        ^\r\n${REJECTED}\r\n\r\n${PROMPT}` : PROMPT,
    ];
    reply.forEach((chunk, index) => {
      setTimeout(() => pacer.output(Buffer.from(chunk, 'utf8')), answerMs * (index + 1));
    });
  });
  pacer = harness.pacer;
  return harness;
}

// Output is checked on the event-loop turn after it arrives, which fake timers place 1 ms later.
describe('pastes that wait for the prompt', () => {
  it('sends each line once the prompt is back instead of after the line delay', async () => {
    const { pacer, writes, reports } = consolePacer();

    pacer.enqueue({ ...paste('interface ge-0/0/1\ndescription uplink\nexit\n', 5000), prompt: prompted() });
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'interface ge-0/0/1\r' },
      { at: 61, data: 'description uplink\r' },
      { at: 122, data: 'exit\r' },
    ]);
    // The last line waits for its answer too, so an error there is still caught.
    expect(reports.at(-1)).toEqual({ state: 'done', line: 3, lines: 3, sent: 43, total: 43 });
  });

  it('stops at the first rejected line and reports it with the output, dropping queued pastes', async () => {
    const { pacer, writes, reports } = consolePacer();

    pacer.enqueue({ ...paste('interface ge-0/0/1\nbogus command\nshutdown\n', 0), prompt: prompted() });
    pacer.enqueue(paste('queued\n', 100));
    pacer.enqueue(paste('queued too\n', 100));
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual(['interface ge-0/0/1\r', 'bogus command\r']);
    // Progress counts every queued line; the message counts within the paste that stopped.
    expect(reports.at(-1)).toEqual({
      state: 'stopped',
      line: 2,
      lines: 5,
      sent: 33,
      total: 60,
      message: `Line 2 of 3 (“bogus command”) was answered with “${REJECTED}”`,
      stopId: 1,
    });

    // The next paste starts afresh, and a later stop gets a number of its own.
    pacer.enqueue(paste('next\n', 100));
    await vi.runAllTimersAsync();
    expect(writes.at(-1)?.data).toBe('next\r');
    pacer.enqueue({ ...paste('bogus again\n', 0), prompt: prompted() });
    await vi.runAllTimersAsync();
    expect(reports.at(-1)).toMatchObject({
      state: 'stopped',
      message: `Line 1 of 1 (“bogus again”) was answered with “${REJECTED}”`,
      stopId: 2,
    });
  });

  it('stops at a rejection of the last line, which waits for its answer too', async () => {
    const { pacer, writes, reports } = consolePacer();

    pacer.enqueue({ ...paste('interface ge-0/0/1\nbogus command\n', 0), prompt: prompted() });
    await vi.runAllTimersAsync();

    expect(writes).toHaveLength(2);
    expect(reports.at(-1)).toMatchObject({
      state: 'stopped',
      line: 2,
      message: `Line 2 of 2 (“bogus command”) was answered with “${REJECTED}”`,
    });
  });

  it('falls back to the line delay for a line whose prompt does not come in time', async () => {
    const quiet = consolePacer({ answer: (line) => [`${line}\r\n`] });
    quiet.pacer.enqueue({ ...paste('one\ntwo\nthree\n', 0), prompt: prompted({ timeoutMs: 500 }) });
    await vi.runAllTimersAsync();
    expect(quiet.writes.map((write) => write.at)).toEqual([0, 500, 1000]);
    expect(quiet.reports.at(-1)).toMatchObject({ state: 'done' });

    // A line delay longer than the timeout still holds; the next line waits for the prompt again.
    const slow = consolePacer({ answer: (line) => (line === 'one' ? [`${line}\r\n`] : undefined) });
    slow.pacer.enqueue({ ...paste('one\ntwo\nthree\n', 800), prompt: prompted({ timeoutMs: 500 }) });
    await vi.runAllTimersAsync();
    expect(slow.writes.map((write) => write.at)).toEqual([0, 800, 861]);
  });

  it('still stops at a rejection that comes while a line falls back to the line delay', async () => {
    // Every answer comes after the timeout: the echo at 400 ms, the rest at 800 ms.
    const { pacer, writes, reports } = consolePacer({ answerMs: 400 });

    pacer.enqueue({ ...paste('one\nbogus\nthree\n', 1500), prompt: prompted({ timeoutMs: 300 }) });
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'one\r' },
      { at: 1500, data: 'bogus\r' },
    ]);
    expect(reports.at(-1)).toMatchObject({
      state: 'stopped',
      line: 2,
      message: `Line 2 of 3 (“bogus”) was answered with “${REJECTED}”`,
    });
  });

  it('still stops at a rejection that comes while the next line is typed a character at a time', async () => {
    let pacer!: PastePacer;
    let lineEnds = 0;
    const harness = recordingPacer((data) => {
      if (data.toString('utf8') !== '\r') return;
      lineEnds += 1;
      // The second line is rejected only once the next one is being typed.
      const [reply, afterMs] = lineEnds === 2 ? [`\r\n${REJECTED}\r\n`, 1515] : [`\r\n${PROMPT}`, 20];
      setTimeout(() => pacer.output(Buffer.from(reply, 'utf8')), afterMs);
    });
    pacer = harness.pacer;

    pacer.enqueue({ ...paste('a\nb\ncd\n', 1500, 10), prompt: prompted({ timeoutMs: 300 }) });
    await vi.runAllTimersAsync();

    expect(harness.writes).toEqual([
      { at: 0, data: 'a' },
      { at: 10, data: '\r' },
      { at: 31, data: 'b' },
      { at: 41, data: '\r' },
      { at: 1551, data: 'c' },
    ]);
    // The line it answers, not the one being typed.
    expect(harness.reports.at(-1)).toMatchObject({
      state: 'stopped',
      line: 2,
      message: `Line 2 of 3 (“b”) was answered with “${REJECTED}”`,
    });
  });

  it('reads the prompt and errors through escape sequences and chunk boundaries', async () => {
    const { pacer, writes, reports } = consolePacer({
      answer: (line) =>
        line === 'show clock'
          ? [`${line}\r`, '\n\x1b[1mR1(con', 'fig)\x1b[0', 'm#']
          : [`${line}\r\n% Inv`, 'alid input detected\x1b[K\r', `\n${PROMPT}`],
    });

    pacer.enqueue({ ...paste('show clock\nbogus\nexit\n', 0), prompt: prompted() });
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'show clock\r' },
      { at: 121, data: 'bogus\r' },
    ]);
    expect(reports.at(-1)).toMatchObject({
      state: 'stopped',
      line: 2,
      message: 'Line 2 of 3 (“bogus”) was answered with “% Invalid input detected”',
    });
  });

  it('takes neither the echo of a line ending in # nor earlier output for the answer', async () => {
    const { pacer, writes, reports } = consolePacer({
      answer: (line) => [line, '\r\n', PROMPT],
    });
    // Rejected before the paste started: not an answer to anything it sends.
    pacer.output(Buffer.from(`${REJECTED}\r\n`));

    pacer.enqueue({ ...paste('banner motd #\nexit\n', 0), prompt: prompted() });
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'banner motd #\r' },
      { at: 91, data: 'exit\r' },
    ]);
    expect(reports.at(-1)).toMatchObject({ state: 'done' });
  });

  it('waits for the prompt after the line break of a paste typed a character at a time', async () => {
    const { pacer, writes } = consolePacer();

    pacer.enqueue({ ...paste('ab\nc', 1000, 10), prompt: prompted() });
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: 'a' },
      { at: 10, data: 'b' },
      { at: 20, data: '\r' },
      { at: 81, data: 'c' },
    ]);
  });

  it('keeps the delays for a bracketed paste, which shows no prompt after each line', async () => {
    const { pacer, writes, reports } = consolePacer({
      answer: (line) => [`${line}\r\n${REJECTED}\r\n`],
    });

    pacer.enqueue({ ...paste('bogus\nexit\n', 100, 0, true), prompt: prompted() });
    await vi.runAllTimersAsync();

    expect(writes).toEqual([
      { at: 0, data: '\x1b[200~bogus\r' },
      { at: 100, data: 'exit\r\x1b[201~' },
    ]);
    expect(reports.at(-1)).toMatchObject({ state: 'done' });
  });

  it('stops the paste, not the backend, when a pattern backtracks too long', async () => {
    const { pacer, writes, reports } = consolePacer({
      answer: (line) => [`${line}\r\n${'a'.repeat(32)}!`],
    });

    pacer.enqueue({ ...paste('one\ntwo\n', 0), prompt: prompted({ promptPattern: '^(a+)+$' }) });
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.data)).toEqual(['one\r']);
    expect(reports.at(-1)).toMatchObject({
      state: 'stopped',
      line: 1,
      message: 'Line 1 of 2 (“one”): the prompt pattern took too long to match.',
    });
  });

  it('matches the prompt only while it waits for it, not on the echo of a line being typed', async () => {
    let pacer!: PastePacer;
    const harness = recordingPacer((data) => {
      const text = data.toString('utf8');
      // The device echoes each character, and answers a line break with its prompt.
      const reply = text === '\r' ? '\r\nR1#' : text;
      setTimeout(() => pacer.output(Buffer.from(reply, 'utf8')), 1);
    });
    pacer = harness.pacer;

    // Matches R1# at once, but backtracks for ever on the echo of a long word.
    const promptPattern = '(\\w+\\s?)+#\\s*$';
    pacer.enqueue({
      ...paste(`interface Gi0/1\ndescription ${'a'.repeat(40)}\nexit\n`, 0, 5),
      prompt: prompted({ promptPattern }),
    });
    await vi.runAllTimersAsync();

    expect(harness.writes.map((write) => write.data).join('')).toBe(
      `interface Gi0/1\rdescription ${'a'.repeat(40)}\rexit\r`,
    );
    // Each line went on the prompt, not after the timeout.
    expect(harness.writes.at(-1)!.at).toBeLessThan(1000);
    expect(harness.reports.at(-1)).toMatchObject({ state: 'done' });
  });

  it('sends nothing of a paste whose pattern does not compile', async () => {
    const { pacer, writes, reports } = consolePacer();

    pacer.enqueue({ ...paste('one\n', 0), prompt: prompted({ errorPattern: '([' }) });
    await vi.runAllTimersAsync();

    expect(writes).toEqual([]);
    expect(reports.at(-1)).toMatchObject({
      state: 'stopped',
      line: 0,
      message: expect.stringContaining('The prompt or error pattern cannot be used'),
      stopId: 1,
    });
  });

  it.each([
    { end: 'cancel', reported: ['cancelled'] },
    { end: 'close', reported: [] },
  ] as const)('ends a prompt wait and a read of the answer at once on $end', async ({ end, reported }) => {
    // A prompt that never comes, with a line delay longer than the timeout to fall back to.
    const waiting = consolePacer({ answer: (line) => [`${line}\r\n`] });
    waiting.pacer.enqueue({ ...paste('one\ntwo\n', 5000), prompt: prompted() });
    await vi.advanceTimersByTimeAsync(100);
    const waitReports = waiting.reports.length;
    waiting.pacer[end]();
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.writes.map((write) => write.data)).toEqual(['one\r']);
    expect(waiting.reports.slice(waitReports).map((report) => report.state)).toEqual(reported);
    expect(vi.getTimerCount()).toBe(0);

    // The answer to the first line is read while the second is typed a character at a time.
    const typing = consolePacer();
    typing.pacer.enqueue({ ...paste('a\nbc\n', 0, 1000), prompt: prompted() });
    await vi.advanceTimersByTimeAsync(1500);
    expect(typing.writes.map((write) => write.data)).toEqual(['a', '\r', 'b']);
    const readReports = typing.reports.length;
    typing.pacer[end]();
    await vi.advanceTimersByTimeAsync(0);
    expect(typing.reports.slice(readReports).map((report) => report.state)).toEqual(reported);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads an answer that came while the write before it was still pending', async () => {
    /** The transport holds the writes `held` picks for 50 ms; the device rejects the line meanwhile. */
    const holding = (held: (text: string) => boolean) => {
      let pacer!: PastePacer;
      const harness = recordingPacer((data) => {
        if (!held(data.toString('utf8'))) return undefined;
        setTimeout(() => pacer.output(Buffer.from(`\r\n${REJECTED}\r\n`, 'utf8')), 10);
        return new Promise<void>((resolve) => setTimeout(resolve, 50));
      });
      pacer = harness.pacer;
      return harness;
    };

    // Line by line: the wait for the prompt starts once the line has been written.
    const lines = holding(() => true);
    lines.pacer.enqueue({ ...paste('bogus\nexit\n', 0), prompt: prompted() });
    await vi.runAllTimersAsync();
    expect(lines.writes.map((write) => write.data)).toEqual(['bogus\r']);
    expect(lines.reports.at(-1)).toMatchObject({ state: 'stopped', line: 1 });

    // A character at a time: line one has no answer within the timeout, and its rejection
    // comes while the next character is being written.
    const chars = holding((text) => text === 'x');
    chars.pacer.enqueue({ ...paste('a\nxy\n', 0, 20), prompt: prompted({ timeoutMs: 300 }) });
    await vi.runAllTimersAsync();
    expect(chars.writes.map((write) => write.data)).toEqual(['a', '\r', 'x']);
    expect(chars.reports.at(-1)).toMatchObject({
      state: 'stopped',
      line: 1,
      message: `Line 1 of 2 (“a”) was answered with “${REJECTED}”`,
    });
  });

  it('reads no output while no paste waits for the prompt', async () => {
    const { pacer, writes } = consolePacer();

    pacer.enqueue(paste('bogus\nexit\n', 100));
    await vi.runAllTimersAsync();

    expect(writes.map((write) => write.at)).toEqual([0, 100]);
  });
});
