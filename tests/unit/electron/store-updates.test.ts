import { describe, expect, it, vi } from 'vitest';
import { checkStoreUpdate } from '../../../electron/src/store-updates.js';

const metadata = { muxusUpdateMode: 'store', muxusStoreProductId: '9MUXUS000000' };

describe('Store update routing', () => {
  it('leaves normal desktop update checks to the existing updater', async () => {
    const open = vi.fn();
    expect(await checkStoreUpdate({}, false, '0.7.0', true, open)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it('silences background checks without opening the Store', async () => {
    const open = vi.fn();
    expect(await checkStoreUpdate(metadata, false, '0.7.0', false, open)).toEqual({ available: false, currentVersion: '0.7.0', reason: 'store' });
    expect(open).not.toHaveBeenCalled();
  });

  it('opens only the configured product when explicitly requested', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await checkStoreUpdate(metadata, true, '0.7.0', true, open);
    expect(open).toHaveBeenCalledExactlyOnceWith('ms-windows-store://pdp/?ProductId=9MUXUS000000');
  });

  it('honors Electron Store detection even if package metadata is absent', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await checkStoreUpdate({}, true, '0.7.0', true, open);
    expect(open).toHaveBeenCalledExactlyOnceWith('ms-windows-store://downloadsandupdates');
  });

  it('keeps Store installations on the Store path when opening it fails', async () => {
    expect(await checkStoreUpdate(metadata, true, '0.7.0', true, vi.fn().mockRejectedValue(new Error('offline'))))
      .toMatchObject({ available: false, reason: 'store-open-failed' });
  });
});
