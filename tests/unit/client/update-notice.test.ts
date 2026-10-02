import { describe, expect, it } from 'vitest';
import type { DesktopUpdateState } from '@muxus/shared';
import { desktopUpdateNotice, isInAppUpdater } from '../../../client/src/update-notice.js';

const state = (overrides: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  currentVersion: '0.8.0',
  status: 'idle',
  ...overrides,
});

describe('in-app update notices', () => {
  it('falls back to the release check for browsers, development and Linux packages', () => {
    expect(isInAppUpdater(undefined)).toBe(false);
    expect(isInAppUpdater(state({ status: 'disabled', reason: 'package-manager' }))).toBe(false);
    expect(isInAppUpdater(state({}))).toBe(true);
    expect(desktopUpdateNotice(state({ status: 'disabled', reason: 'development' }))).toBeUndefined();
  });

  it('treats availability and a finished download as separate decisions', () => {
    const available = desktopUpdateNotice(state({ status: 'available', version: '0.9.0' }));
    const ready = desktopUpdateNotice(state({ status: 'ready', version: '0.9.0', percent: 100 }));
    expect(available).toMatchObject({ message: 'Muxus 0.9.0 is available. You are running 0.8.0.', persistDismissal: true });
    expect(ready).toMatchObject({ message: 'Muxus 0.9.0 is downloaded and ready to install.', tone: 'info' });
    expect(ready?.key).not.toBe(available?.key);
  });

  it('stays quiet while checking or downloading and for failed background checks', () => {
    for (const status of ['idle', 'checking', 'up-to-date', 'downloading', 'installing'] as const) {
      expect(desktopUpdateNotice(state({ status, version: '0.9.0' }))).toBeUndefined();
    }
    expect(desktopUpdateNotice(state({ status: 'error', error: 'offline' }))).toBeUndefined();
    expect(desktopUpdateNotice(state({ status: 'error', version: '0.9.0', error: 'bad checksum' })))
      .toMatchObject({ message: 'bad checksum', tone: 'warning' });
  });

  it('keeps Store dismissals to this run, since the Store hides the target version', () => {
    const notice = desktopUpdateNotice(state({ source: 'store', status: 'available' }));
    expect(notice).toMatchObject({ persistDismissal: false, message: 'A new version of Muxus is available in Microsoft Store.' });
    expect(desktopUpdateNotice(state({ source: 'store', status: 'updated' }))?.message).toContain('Reopen Muxus');
    expect(desktopUpdateNotice(state({ source: 'store', status: 'up-to-date' }))).toBeUndefined();
  });
});
