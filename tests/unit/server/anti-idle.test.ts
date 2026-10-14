import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metadataPatchSchema } from '../../../server/src/routes/metadata-schema.js';
import { AntiIdleTimer, antiIdleInput } from '../../../server/src/ws/anti-idle.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function timer(setting = { intervalSeconds: 10, text: ' ', enter: false }) {
  let busy = false;
  const typed: Array<{ at: number; data: string }> = [];
  const start = Date.now();
  const antiIdle = new AntiIdleTimer(setting, {
    write: (data) => typed.push({ at: Date.now() - start, data: data.toString('utf8') }),
    busy: () => busy,
  });
  antiIdle.start();
  return {
    antiIdle,
    typed,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

describe('antiIdleInput', () => {
  it('types the text as is and presses Enter only when asked to', () => {
    expect(antiIdleInput({ intervalSeconds: 60, text: ' ', enter: false })).toEqual(Buffer.from(' '));
    expect(antiIdleInput({ intervalSeconds: 60, text: 'show clock', enter: true })).toEqual(
      Buffer.from('show clock\r'),
    );
    expect(antiIdleInput({ intervalSeconds: 60, text: '', enter: true })).toEqual(Buffer.from('\r'));
  });
});

describe('AntiIdleTimer', () => {
  it('types after each full interval without input', async () => {
    const { antiIdle, typed } = timer();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(typed).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(typed).toEqual([
      { at: 10_000, data: ' ' },
      { at: 20_000, data: ' ' },
      { at: 30_000, data: ' ' },
    ]);
    antiIdle.close();
  });

  it('starts the wait over on any input', async () => {
    const { antiIdle, typed } = timer();
    await vi.advanceTimersByTimeAsync(6_000);
    antiIdle.input();
    await vi.advanceTimersByTimeAsync(6_000);
    antiIdle.input();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(typed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([{ at: 22_000, data: ' ' }]);
    antiIdle.close();
  });

  it('holds while something else types, then waits a full interval', async () => {
    const { antiIdle, typed, setBusy } = timer();
    setBusy(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(typed).toEqual([]);
    setBusy(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(typed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    // A full interval from the first look that found it done, at 61 s.
    expect(typed).toEqual([{ at: 71_000, data: ' ' }]);
    antiIdle.close();
  });

  it('never sends sooner than a full interval after a hold that ends between looks', async () => {
    const { antiIdle, typed, setBusy } = timer();
    setBusy(true);
    await vi.advanceTimersByTimeAsync(60_500);
    setBusy(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(typed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(typed).toEqual([{ at: 71_000, data: ' ' }]);
    antiIdle.close();
  });

  it('keeps its pace when the wall clock is set back', async () => {
    const { antiIdle, typed } = timer();
    await vi.advanceTimersByTimeAsync(5_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(typed.map(({ data }) => data)).toEqual([' ']);
    antiIdle.close();
  });

  it('can wait for the first input before it starts counting', async () => {
    const typed: string[] = [];
    const antiIdle = new AntiIdleTimer(
      { intervalSeconds: 10, text: ' ', enter: false },
      { write: (data) => typed.push(data.toString('utf8')), busy: () => false },
    );
    antiIdle.startAfterFirstInput();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(typed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    antiIdle.input();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(typed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([' ']);
    antiIdle.close();
  });

  it('stops for good once closed', async () => {
    const { antiIdle, typed } = timer();
    await vi.advanceTimersByTimeAsync(10_000);
    antiIdle.close();
    antiIdle.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(typed).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('anti-idle in the host metadata schema', () => {
  const parse = (antiIdle: unknown) => metadataPatchSchema.safeParse({ antiIdle }).success;

  it('takes 10 to 3600 whole seconds', () => {
    expect(parse({ intervalSeconds: 10, text: ' ', enter: false })).toBe(true);
    expect(parse({ intervalSeconds: 3600, text: ' ', enter: false })).toBe(true);
    expect(parse({ intervalSeconds: 9, text: ' ', enter: false })).toBe(false);
    expect(parse({ intervalSeconds: 3601, text: ' ', enter: false })).toBe(false);
    expect(parse({ intervalSeconds: 30.5, text: ' ', enter: false })).toBe(false);
  });

  it('needs text or Enter, and null turns it off', () => {
    expect(parse({ intervalSeconds: 60, text: '', enter: true })).toBe(true);
    expect(parse({ intervalSeconds: 60, text: '', enter: false })).toBe(false);
    expect(parse({ intervalSeconds: 60, text: 'x'.repeat(257), enter: false })).toBe(false);
    expect(parse({ intervalSeconds: 60, text: ' ' })).toBe(false);
    expect(parse(null)).toBe(true);
  });

  it('refuses control characters, so Enter cannot hide in the text', () => {
    expect(parse({ intervalSeconds: 60, text: 'a\rb\u0003', enter: false })).toBe(false);
    expect(parse({ intervalSeconds: 60, text: '\t', enter: false })).toBe(false);
    expect(parse({ intervalSeconds: 60, text: 'x\u007f', enter: false })).toBe(false);
    expect(parse({ intervalSeconds: 60, text: 'show clock ü', enter: false })).toBe(true);
  });
});
