import { describe, expect, it, vi } from 'vitest';
import {
  isCurrentTerminalImagePasteTarget,
  pasteTerminalClipboard,
  TerminalClipboardPasteQueue,
} from '../../../client/src/terminal/clipboard-paste.js';

describe('terminal clipboard paste', () => {
  it('waits for text paste confirmation before completing', async () => {
    const confirmation = Promise.withResolvers<void>();
    const pasteText = vi.fn(() => confirmation.promise);
    const operation = pasteTerminalClipboard(
      { kind: 'text', text: 'one\ntwo' },
      {
        uploadImage: vi.fn(),
        pasteText,
        pasteImagePath: vi.fn(),
      },
    );
    let settled = false;
    void operation.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(pasteText).toHaveBeenCalledWith('one\ntwo');
    expect(settled).toBe(false);
    confirmation.resolve();
    await expect(operation).resolves.toEqual({ status: 'pasted', kind: 'text' });
  });

  it('reports captured unavailable clipboard access without applying input', async () => {
    await expect(
      pasteTerminalClipboard(
        { kind: 'unavailable' },
        {
          uploadImage: vi.fn(),
          pasteText: vi.fn(),
          pasteImagePath: vi.fn(),
        },
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'unavailable' });
  });

  it('accepts an input-ready SSH target before its display status settles', () => {
    expect(
      isCurrentTerminalImagePasteTarget({
        connectionId: 'connection-1',
        expectedConnectionId: 'connection-1',
        inputReady: true,
        socketOpen: true,
        ssh: true,
      }),
    ).toBe(true);
    expect(
      isCurrentTerminalImagePasteTarget({
        connectionId: 'connection-1',
        expectedConnectionId: 'connection-1',
        inputReady: false,
        socketOpen: true,
        ssh: true,
      }),
    ).toBe(false);
  });

  it('pastes an uploaded image path through the non-broadcast callback', async () => {
    const png = new Uint8Array([1]);
    const pasteText = vi.fn();
    const pasteImagePath = vi.fn();

    await expect(
      pasteTerminalClipboard(
        { kind: 'image', png },
        {
          uploadImage: async () => '/tmp/muxus-paste.png',
          pasteText,
          pasteImagePath,
        },
      ),
    ).resolves.toEqual({ status: 'pasted', kind: 'image-path' });
    expect(pasteImagePath).toHaveBeenCalledWith('/tmp/muxus-paste.png');
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('does not hide image upload failures', async () => {
    const failure = new Error('SFTP is disabled');
    await expect(
      pasteTerminalClipboard(
        { kind: 'image', png: new Uint8Array([1]) },
        {
          uploadImage: async () => {
            throw failure;
          },
          pasteText: vi.fn(),
          pasteImagePath: vi.fn(),
        },
      ),
    ).rejects.toBe(failure);
  });

  it('applies captured clipboard payloads in invocation order', async () => {
    const queue = new TerminalClipboardPasteQueue();
    const applied: string[] = [];
    const firstStarted = Promise.withResolvers<void>();
    const firstGate = Promise.withResolvers<void>();

    const first = queue.enqueue(
      () => Promise.resolve({ kind: 'text' as const, text: 'first' }),
      async (payload) => {
        if (payload.kind !== 'text') throw new Error('expected text payload');
        applied.push(`start:${payload.text}`);
        firstStarted.resolve();
        await firstGate.promise;
        applied.push(`finish:${payload.text}`);
      },
    );
    const second = queue.enqueue(
      () => Promise.resolve({ kind: 'text' as const, text: 'second' }),
      async (payload) => {
        if (payload.kind !== 'text') throw new Error('expected text payload');
        applied.push(`start:${payload.text}`);
        applied.push(`finish:${payload.text}`);
      },
    );

    await firstStarted.promise;
    expect(applied).toEqual(['start:first']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(applied).toEqual([
      'start:first',
      'finish:first',
      'start:second',
      'finish:second',
    ]);
  });

  it('rejects image payloads beyond the pending byte budget', async () => {
    const queue = new TerminalClipboardPasteQueue({
      maxPendingImageBytes: 4,
      maxPendingPastes: 2,
    });
    const firstStarted = Promise.withResolvers<void>();
    const firstGate = Promise.withResolvers<void>();
    const first = queue.enqueue(
      () => Promise.resolve({ kind: 'image' as const, png: new Uint8Array(3) }),
      async () => {
        firstStarted.resolve();
        await firstGate.promise;
      },
    );
    const second = queue.enqueue(
      () => Promise.resolve({ kind: 'image' as const, png: new Uint8Array(3) }),
      async () => undefined,
    );

    await firstStarted.promise;
    firstGate.resolve();
    await first;
    await expect(second).rejects.toThrow('Too much clipboard image data is waiting.');
  });

  it('rejects clipboard input beyond the pending operation limit', async () => {
    const queue = new TerminalClipboardPasteQueue({
      maxPendingImageBytes: 4,
      maxPendingPastes: 1,
    });
    const firstGate = Promise.withResolvers<void>();
    const first = queue.enqueue(
      () => Promise.resolve({ kind: 'text' as const, text: 'first' }),
      async () => firstGate.promise,
    );

    const rejectedCapture = vi.fn(
      async () => ({ kind: 'text' as const, text: 'second' }),
    );
    await expect(
      queue.enqueue(rejectedCapture, async () => undefined),
    ).rejects.toThrow('Too many clipboard pastes are waiting.');
    expect(rejectedCapture).not.toHaveBeenCalled();
    firstGate.resolve();
    await first;
  });

  it('aborts an active clipboard operation when the queue is cancelled', async () => {
    const queue = new TerminalClipboardPasteQueue();
    const started = Promise.withResolvers<void>();
    const operation = queue.enqueue(
      () => Promise.resolve({ kind: 'text' as const, text: 'waiting' }),
      async (_payload, signal) => {
        const aborted = Promise.withResolvers<void>();
        signal.addEventListener(
          'abort',
          () => aborted.reject(signal.reason),
          { once: true },
        );
        started.resolve();
        return aborted.promise;
      },
    );

    await started.promise;
    queue.cancelAll();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('prioritizes cancellation over a late clipboard capture error', async () => {
    const queue = new TerminalClipboardPasteQueue();
    const capture = Promise.withResolvers<{ kind: 'text'; text: string }>();
    const operation = queue.enqueue(
      () => capture.promise,
      async () => undefined,
    );

    await Promise.resolve();
    queue.cancelAll();
    capture.reject(new Error('clipboard permission denied'));
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  });
});
