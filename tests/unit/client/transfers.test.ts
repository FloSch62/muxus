import type {} from '../../../client/src/desktop.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlobWithProgress } from '../../../client/src/api/transfers.js';

declare global {
  interface ImportMeta {
    readonly env: { readonly DEV: boolean };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SFTP transfer progress', () => {
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
