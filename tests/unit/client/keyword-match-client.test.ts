import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KeywordMatchClient,
  KeywordMatchRetry,
  type KeywordMatchWorker,
} from '../../../client/src/terminal/keyword-match-client.js';
import type { KeywordMatcher } from '../../../client/src/terminal/keyword-matching.js';
import type {
  KeywordMatchRequest,
  KeywordMatchWorkerMessage,
} from '../../../client/src/terminal/keyword-match-worker.js';

class FakeWorker implements KeywordMatchWorker {
  onmessage: KeywordMatchWorker['onmessage'] = null;
  onerror: KeywordMatchWorker['onerror'] = null;
  readonly posted: KeywordMatchRequest[] = [];
  terminated = false;

  postMessage(request: KeywordMatchRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  send(message: KeywordMatchWorkerMessage): void {
    this.onmessage?.({ data: message });
  }
}

const literal: KeywordMatcher = { keyword: 'down', caseSensitive: false, wholeWord: true };
const slow: KeywordMatcher = { keyword: '(a+)+$', caseSensitive: false, wholeWord: false, regex: true };

describe('KeywordMatchClient', () => {
  let workers: FakeWorker[];
  let onSlowPattern: ReturnType<typeof vi.fn<(rule: KeywordMatcher) => void>>;
  let client: KeywordMatchClient;

  beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    onSlowPattern = vi.fn<(rule: KeywordMatcher) => void>();
    client = new KeywordMatchClient(
      () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      onSlowPattern,
      250,
    );
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it('resolves with the worker result and does not blame a slow startup on a pattern', async () => {
    const result = client.match([literal], ['link down']);
    const worker = workers[0]!;
    await vi.advanceTimersByTimeAsync(2000);
    worker.send({ type: 'ready' });
    worker.send({ type: 'result', id: worker.posted[0]!.id, matches: [0, 0, 5, 9] });

    await expect(result).resolves.toEqual([0, 0, 5, 9]);
    expect(worker.terminated).toBe(false);
    expect(onSlowPattern).not.toHaveBeenCalled();
  });

  it('kills a worker stuck on a regex rule, pauses that rule, and asks callers to retry', async () => {
    const result = client.match([literal, slow], ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!']);
    const worker = workers[0]!;
    worker.send({ type: 'ready' });
    worker.send({ type: 'rule', id: worker.posted[0]!.id, rule: 1 });
    const settled = expect(result).rejects.toBeInstanceOf(KeywordMatchRetry);
    await vi.advanceTimersByTimeAsync(250);

    await settled;
    expect(worker.terminated).toBe(true);
    expect(onSlowPattern).toHaveBeenCalledWith(slow);

    // The next request starts a fresh worker.
    void client.match([literal], ['down']).catch(() => undefined);
    expect(workers).toHaveLength(2);
    expect(client.available).toBe(true);
  });

  it('keeps waiting while the worker reports progress', async () => {
    const result = client.match([slow, slow], ['a']);
    const worker = workers[0]!;
    const id = worker.posted[0]!.id;
    worker.send({ type: 'ready' });
    worker.send({ type: 'rule', id, rule: 0 });
    await vi.advanceTimersByTimeAsync(200);
    worker.send({ type: 'rule', id, rule: 1 });
    await vi.advanceTimersByTimeAsync(200);
    worker.send({ type: 'result', id, matches: [] });

    await expect(result).resolves.toEqual([]);
    expect(onSlowPattern).not.toHaveBeenCalled();
  });

  it('does not give a stalled worker more time when other terminals send work', async () => {
    const first = client.match([slow], ['a']);
    const worker = workers[0]!;
    worker.send({ type: 'ready' });
    worker.send({ type: 'rule', id: worker.posted[0]!.id, rule: 0 });
    await vi.advanceTimersByTimeAsync(200);
    const second = client.match([literal], ['down']);
    const settled = Promise.all([
      expect(first).rejects.toBeInstanceOf(KeywordMatchRetry),
      expect(second).rejects.toBeInstanceOf(KeywordMatchRetry),
    ]);
    await vi.advanceTimersByTimeAsync(60);

    await settled;
    expect(onSlowPattern).toHaveBeenCalledWith(slow);
  });

  it('gives up after repeated worker failures and recovers the count on success', async () => {
    const fail = async () => {
      const result = client.match([slow], ['a']);
      const settled = expect(result).rejects.toBeInstanceOf(KeywordMatchRetry);
      workers.at(-1)!.onerror?.(new Event('error'));
      await settled;
    };

    await fail();
    await fail();
    const recovered = client.match([slow], ['a']);
    const worker = workers.at(-1)!;
    worker.send({ type: 'ready' });
    worker.send({ type: 'result', id: worker.posted[0]!.id, matches: [] });
    await expect(recovered).resolves.toEqual([]);

    await fail();
    await fail();
    await fail();
    expect(client.available).toBe(false);
    await expect(client.match([slow], ['a'])).rejects.toThrow(/unavailable/);
  });
});
