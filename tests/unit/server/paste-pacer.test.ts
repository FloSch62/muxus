import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
