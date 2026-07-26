import { describe, expect, it, vi } from 'vitest';
import {
  flushUnloadKeepalives,
  requestBodyBytes,
  type UnloadKeepaliveFlush,
} from '../../../client/src/unload-keepalive.js';

describe('page unload keepalive coordination', () => {
  it('reserves budget for higher-priority work, then shares the remainder fairly', () => {
    const offered: number[] = [];
    const task = (priority: number, consume: (offeredBytes: number) => number) =>
      ({
        priority,
        flush: (maxBodyBytes) => {
          offered.push(maxBodyBytes);
          return consume(maxBodyBytes);
        },
      }) satisfies UnloadKeepaliveFlush;

    const used = flushUnloadKeepalives(
      [
        task(0, (budget) => budget),
        task(100, () => 10_000),
        task(0, (budget) => budget),
      ],
      60_000,
    );

    expect(offered).toEqual([60_000, 25_000, 25_000]);
    expect(used).toBe(60_000);
  });

  it('passes unused shares to the callbacks that remain', () => {
    const offered: number[] = [];
    const tasks: UnloadKeepaliveFlush[] = [0, 0, 0].map((_, index) => ({
      priority: 0,
      flush: (maxBodyBytes) => {
        offered.push(maxBodyBytes);
        return index === 0 ? 0 : maxBodyBytes;
      },
    }));

    expect(flushUnloadKeepalives(tasks, 60_000)).toBe(60_000);
    expect(offered).toEqual([20_000, 30_000, 30_000]);
  });

  it('does not dilute dirty terminals with registered callbacks that have no work', () => {
    const activeFlush = vi.fn((budget: number) => budget);
    const tasks: UnloadKeepaliveFlush[] = [
      { priority: 0, isPending: () => false, flush: vi.fn() },
      { priority: 0, isPending: () => true, flush: activeFlush },
      { priority: 0, isPending: () => false, flush: vi.fn() },
    ];

    expect(flushUnloadKeepalives(tasks, 60_000)).toBe(60_000);
    expect(activeFlush).toHaveBeenCalledWith(60_000);
  });

  it('isolates a failing optional flush', () => {
    const finalFlush = vi.fn(() => 10);
    const tasks: UnloadKeepaliveFlush[] = [
      { priority: 0, flush: () => { throw new Error('teardown'); } },
      { priority: 0, flush: finalFlush },
    ];

    expect(flushUnloadKeepalives(tasks, 100)).toBe(10);
    expect(finalFlush).toHaveBeenCalledWith(100);
  });

  it('measures non-ASCII bodies in UTF-8 bytes', () => {
    expect(requestBodyBytes('a€')).toBe(4);
  });
});
