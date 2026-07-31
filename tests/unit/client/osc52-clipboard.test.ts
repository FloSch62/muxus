import { describe, expect, it, vi } from 'vitest';
import { WriteOnlyClipboardProvider } from '../../../client/src/terminal/osc52-clipboard-provider.js';

describe('WriteOnlyClipboardProvider', () => {
  it('writes decoded OSC 52 text when terminal clipboard writes are allowed', () => {
    const writer = vi.fn();
    const provider = new WriteOnlyClipboardProvider(writer, () => true);

    provider.writeText('c', 'copied through zellij ✓');

    expect(writer).toHaveBeenCalledWith('copied through zellij ✓');
  });

  it('checks the current preference for every write', () => {
    const writer = vi.fn();
    let allowed = false;
    const provider = new WriteOnlyClipboardProvider(writer, () => allowed);

    provider.writeText('c', 'blocked');
    allowed = true;
    provider.writeText('c', 'allowed');

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith('allowed');
  });

  it('never exposes clipboard contents to OSC 52 read queries', () => {
    const provider = new WriteOnlyClipboardProvider(vi.fn(), () => true);

    expect(provider.readText('c')).toBe('');
    expect(provider.readText('p')).toBe('');
  });
});

describe('OSC 52 clipboard addon wiring', () => {
  it('decodes a real UTF-8 OSC 52 write and blocks readback', async () => {
    vi.stubGlobal('self', globalThis);
    try {
      const { attachOsc52Clipboard } = await import(
        '../../../client/src/terminal/osc52-clipboard.js'
      );
      let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
      const input = vi.fn();
      const term = {
        parser: {
          registerOscHandler(
            id: number,
            callback: (data: string) => boolean | Promise<boolean>,
          ) {
            expect(id).toBe(52);
            handler = callback;
            return { dispose: vi.fn() };
          },
        },
        input,
        loadAddon(addon: { activate(value: unknown): void }) {
          addon.activate(this);
        },
      };
      const writer = vi.fn();

      attachOsc52Clipboard(
        term as unknown as Parameters<typeof attachOsc52Clipboard>[0],
        writer,
        () => true,
      );
      expect(handler).toBeDefined();

      const text = 'copied through zellij ✓';
      const payload = Buffer.from(text, 'utf8').toString('base64');
      await handler!(`c;${payload}`);
      expect(writer).toHaveBeenCalledWith(text);

      await handler!('c;?');
      expect(input).toHaveBeenCalledWith('\x1b]52;c;\x07', false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
