import type {} from '../../../client/src/desktop.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlobWithProgress, uploadRawWithProgress } from '../../../client/src/api/transfers.js';

declare global {
  interface ImportMeta {
    readonly env: { readonly DEV: boolean };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SFTP transfer progress', () => {
  it('does not send an upload that was cancelled before it started', async () => {
    const send = vi.fn();
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        upload = {};
        status = 200;
        responseText = '';
        onload?: () => void;
        open() {}
        setRequestHeader() {}
        abort() {}
        send() {
          send();
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadRawWithProgress('/upload', new Blob(['payload']), { signal: controller.signal, onProgress: vi.fn() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).not.toHaveBeenCalled();
  });

  it('streams downloads and reports their final byte count', async () => {
    const payload = new TextEncoder().encode('payload');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(payload.slice(0, 3));
              controller.enqueue(payload.slice(3));
              controller.close();
            },
          }),
          { headers: { 'content-length': String(payload.length) } },
        ),
      ),
    );
    const progress = vi.fn();

    const blob = await downloadBlobWithProgress('/download', progress);

    expect(await blob.text()).toBe('payload');
    expect(progress).toHaveBeenLastCalledWith({
      loaded: payload.length,
      total: payload.length,
      bytesPerSecond: expect.any(Number),
    });
  });
});
