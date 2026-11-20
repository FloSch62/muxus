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

  it('asks for the rest of an interrupted download and adds it to what was received', async () => {
    const fetch = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response('load', { status: 206, headers: { 'content-length': '4', etag: '"v1"' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const progress = vi.fn();
    const onInterrupted = vi.fn();

    const blob = await downloadBlobWithProgress('/download', progress, undefined, undefined, {
      partial: { blob: new Blob(['pay']), etag: '"v1"' },
      onInterrupted,
    });

    expect(await blob.text()).toBe('payload');
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('range')).toBe('bytes=3-');
    expect(headers.get('if-range')).toBe('"v1"');
    expect(progress).toHaveBeenNthCalledWith(1, { loaded: 3, total: 7, bytesPerSecond: 0 });
    expect(progress).toHaveBeenLastCalledWith({ loaded: 7, total: 7, bytesPerSecond: expect.any(Number) });
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  it('takes the whole file when it changed since the interrupted download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('changed', { headers: { 'content-length': '7', etag: '"v2"' } })),
    );

    const blob = await downloadBlobWithProgress('/download', vi.fn(), undefined, undefined, {
      partial: { blob: new Blob(['pay']), etag: '"v1"' },
      onInterrupted: vi.fn(),
    });

    expect(await blob.text()).toBe('changed');
  });

  it('hands over what it received when the download breaks off', async () => {
    let sent = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent) controller.error(new TypeError('network error'));
                else controller.enqueue(new TextEncoder().encode('pay'));
                sent = true;
              },
            }),
            { headers: { 'content-length': '7', etag: '"v1"' } },
          ),
      ),
    );
    const onInterrupted = vi.fn();

    await expect(
      downloadBlobWithProgress('/download', vi.fn(), undefined, undefined, { onInterrupted }),
    ).rejects.toThrow('network error');

    expect(onInterrupted).toHaveBeenCalledOnce();
    const [partial] = onInterrupted.mock.calls[0]!;
    expect(partial.etag).toBe('"v1"');
    expect(await partial.blob.text()).toBe('pay');
  });
});
