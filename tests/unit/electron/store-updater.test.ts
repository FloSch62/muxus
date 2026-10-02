import { afterEach, expect, it, vi } from 'vitest';
import { StoreUpdater } from '../../../electron/src/store-updater.js';
import type { StoreResult } from '../../../electron/src/store-bridge.js';

vi.mock('../../../electron/src/main-log.js', () => ({ mainLog: vi.fn() }));

function setup() {
  const run = vi.fn(async (_command: 'check' | 'install', _progress: (percent: number) => void): Promise<StoreResult> => 'available');
  const broadcast = vi.fn();
  const beforeInstall = vi.fn();
  const updater = new StoreUpdater({ version: '0.9.1', bridge: { run }, broadcast, beforeInstall });
  return { updater, run, broadcast, beforeInstall };
}

afterEach(() => vi.useRealTimers());

it('checks without downloading, deduplicates checks and requires an available update before installation', async () => {
  const { updater, run, beforeInstall } = setup();
  expect(updater.requestInstall()).toBe(false);
  const first = updater.check();
  expect(updater.check()).toBe(first);
  expect(updater.requestInstall()).toBe(false);
  await first;
  expect(run).toHaveBeenCalledExactlyOnceWith('check', expect.any(Function));
  expect(beforeInstall).not.toHaveBeenCalled();
  expect(updater.getState()).toEqual({ currentVersion: '0.9.1', source: 'store', status: 'available' });
});

it('persists before installation, broadcasts progress, prevents concurrent operations and reports completion separately', async () => {
  const { updater, run, broadcast, beforeInstall } = setup();
  await updater.check();
  let finish!: (result: StoreResult) => void;
  run.mockImplementationOnce((_command, progress) => {
    expect(beforeInstall).toHaveBeenCalledOnce();
    progress(42);
    const count = broadcast.mock.calls.length;
    progress(42);
    expect(broadcast).toHaveBeenCalledTimes(count);
    return new Promise(resolve => { finish = resolve; });
  });
  expect(updater.requestInstall()).toBe(true);
  expect(updater.requestInstall()).toBe(false);
  const pending = updater.check();
  expect(run).toHaveBeenCalledTimes(2);
  expect(updater.getState()).toMatchObject({ status: 'installing', percent: 42 });
  finish('updated');
  await pending;
  expect(updater.getState()).toMatchObject({ status: 'updated' });
  expect(updater.getState().percent).toBeUndefined();
  await updater.check();
  expect(run).toHaveBeenCalledTimes(2);
});

it('leaves cancellation available for another explicit attempt and never retries installation automatically', async () => {
  const { updater, run } = setup();
  await updater.check();
  run.mockResolvedValueOnce('canceled');
  updater.requestInstall();
  await updater.check();
  expect(updater.getState().status).toBe('available');
  expect(run).toHaveBeenCalledTimes(2);
  run.mockRejectedValueOnce(new Error('offline'));
  updater.requestInstall();
  await updater.check();
  expect(updater.getState()).toMatchObject({ status: 'error', error: expect.stringContaining('could not complete') });
  expect(updater.requestInstall()).toBe(false);
  run.mockResolvedValueOnce('up-to-date');
  await updater.check();
  expect(updater.getState().status).toBe('up-to-date');
});

it('surfaces failed checks and failed persistence without starting an installation', async () => {
  const { updater, run, beforeInstall } = setup();
  run.mockRejectedValueOnce(new Error('unavailable'));
  await updater.check();
  expect(updater.getState()).toMatchObject({ status: 'error', error: expect.stringContaining('could not check') });
  await updater.check();
  beforeInstall.mockImplementationOnce(() => { throw new Error('disk full'); });
  updater.requestInstall();
  await updater.check();
  expect(run).toHaveBeenCalledTimes(2);
  expect(updater.getState().status).toBe('error');
});

it('runs delayed and periodic checks while automatic checks are on, without opening the Store or installing', async () => {
  vi.useFakeTimers();
  const { updater, run } = setup();
  updater.setAutomaticChecks(true);
  updater.setAutomaticChecks(true);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.every(([command]) => command === 'check')).toBe(true);
  updater.stop();
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(run).toHaveBeenCalledTimes(2);
});

it('stops background checks when notifications are turned off', async () => {
  vi.useFakeTimers();
  const { updater, run } = setup();
  updater.setAutomaticChecks(true);
  updater.setAutomaticChecks(false);
  await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
  expect(run).not.toHaveBeenCalled();
});
