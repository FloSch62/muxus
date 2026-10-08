import type {} from '../../../client/src/desktop.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalOpenTarget } from '@muxus/shared';
import {
  canOpenLocally,
  chooseLocalProgram,
  openDownloadedFile,
  openWithChooser,
  type LocalCopyBridge,
} from '../../../client/src/local-open.js';

type Desktop = NonNullable<Window['muxusDesktop']>;

function bridge(overrides: Partial<LocalCopyBridge> = {}) {
  const chunks: number[] = [];
  const calls = {
    beginLocalCopy: vi.fn(async () => 'copy-1'),
    writeLocalCopy: vi.fn(async (_id: string, chunk: Uint8Array) => {
      chunks.push(chunk.byteLength);
      return true;
    }),
    cancelLocalCopy: vi.fn(async () => undefined),
    openLocalCopy: vi.fn(async (_id: string, _target: LocalOpenTarget) => ({ ok: true as const })),
    ...overrides,
  };
  return { calls, chunks };
}

function desktop(platform: string, extra: Partial<Desktop> = {}): Desktop {
  return { platform, ...bridge().calls, ...extra } as unknown as Desktop;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opening remote files locally', () => {
  it('is offered only by a desktop bridge that can stage copies', () => {
    vi.stubGlobal('window', {});
    expect(canOpenLocally()).toBe(false);
    expect(canOpenLocally({ platform: 'linux' } as Desktop)).toBe(false);
    expect(canOpenLocally(desktop('linux'))).toBe(true);
  });

  it('picks the chooser each platform supports', () => {
    const chooseLocalProgram = vi.fn();
    const listLocalApplications = vi.fn();
    expect(openWithChooser(desktop('win32'))).toBe('system');
    expect(openWithChooser(desktop('darwin', { chooseLocalProgram }))).toBe('program-picker');
    expect(openWithChooser(desktop('linux', { chooseLocalProgram, listLocalApplications }))).toBe(
      'application-list',
    );
    expect(openWithChooser(desktop('darwin'))).toBeUndefined();
    vi.stubGlobal('window', {});
    expect(openWithChooser()).toBeUndefined();
  });

  it('sends a large download in slices before opening it', async () => {
    const { calls, chunks } = bridge();
    const blob = new Blob([new Uint8Array(20 * 1024 * 1024)]);

    await expect(openDownloadedFile('dump.bin', blob, { kind: 'default' }, calls)).resolves.toBe('copy-1');

    expect(calls.beginLocalCopy).toHaveBeenCalledWith('dump.bin');
    expect(chunks).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024]);
    expect(calls.openLocalCopy).toHaveBeenCalledWith('copy-1', { kind: 'default' });
    expect(calls.cancelLocalCopy).not.toHaveBeenCalled();
  });

  it('opens an empty file without writing anything', async () => {
    const { calls, chunks } = bridge();
    await openDownloadedFile('empty.txt', new Blob([]), { kind: 'system-chooser' }, calls);
    expect(chunks).toEqual([]);
    expect(calls.openLocalCopy).toHaveBeenCalledWith('copy-1', { kind: 'system-chooser' });
  });

  it('discards the copy when a slice is refused', async () => {
    const { calls } = bridge({ writeLocalCopy: vi.fn(async () => false) });
    await expect(
      openDownloadedFile('plan.drawio', new Blob(['x']), { kind: 'default' }, calls),
    ).rejects.toThrow('Could not write the local copy of plan.drawio.');
    expect(calls.cancelLocalCopy).toHaveBeenCalledWith('copy-1');
    expect(calls.openLocalCopy).not.toHaveBeenCalled();
  });

  it("reports the desktop app's reason when the program does not start", async () => {
    const { calls } = bridge({
      openLocalCopy: vi.fn(async () => ({ ok: false as const, message: 'spawn drawio ENOENT' })),
    });
    await expect(
      openDownloadedFile('plan.drawio', new Blob(['x']), { kind: 'application', id: 'drawio.desktop' }, calls),
    ).rejects.toThrow('Could not open plan.drawio: spawn drawio ENOENT');
  });

  it('turns an unusable program pick into an error', async () => {
    const application = { id: 'picked:1', name: 'drawio' };
    await expect(
      chooseLocalProgram(desktop('linux', { chooseLocalProgram: async () => ({ application }) })),
    ).resolves.toEqual(application);
    await expect(
      chooseLocalProgram(desktop('linux', { chooseLocalProgram: async () => undefined })),
    ).resolves.toBeUndefined();
    await expect(
      chooseLocalProgram(
        desktop('linux', { chooseLocalProgram: async () => ({ message: 'notes.txt is not an executable program.' }) }),
      ),
    ).rejects.toThrow('notes.txt is not an executable program.');
  });
});
