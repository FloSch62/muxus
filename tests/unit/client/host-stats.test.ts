import { describe, expect, it } from 'vitest';
import type { HostStatsSample } from '@muxus/shared';
import {
  describeUsers,
  formatBytes,
  formatPercent,
  formatRate,
  formatUptime,
  hostStatsView,
  isStatusBarItemList,
  meterLevel,
  timedSample,
  withStatusBarItem,
} from '../../../client/src/host-stats.js';

function reading(at: number, patch: Partial<HostStatsSample> = {}) {
  return timedSample({ uptimeSeconds: at, ...patch }, 0);
}

describe('status bar rates', () => {
  it('has no rates from a single reading', () => {
    const view = hostStatsView(
      reading(100, { cpuTime: { total: 1000, idle: 800 } }),
    );
    expect(view.cpu).toBeUndefined();
    expect(view.receiveRate).toBeUndefined();
  });

  it('measures CPU as the busy share of the time between two readings', () => {
    const view = hostStatsView(
      reading(103, { cpuTime: { total: 1400, idle: 1100 } }),
      reading(100, { cpuTime: { total: 1000, idle: 800 } }),
    );
    expect(view.cpu).toBeCloseTo(0.25);
  });

  it('divides traffic by the seconds the host itself counted', () => {
    const network = (receivedBytes: number, sentBytes: number) => ({
      network: { interface: 'eth0', receivedBytes, sentBytes },
    });
    const view = hostStatsView(reading(104, network(9000, 2000)), reading(100, network(1000, 0)));
    expect(view.receiveRate).toBe(2000);
    expect(view.sendRate).toBe(500);
  });

  it('falls back to the server clock when the host reports no uptime', () => {
    const view = hostStatsView(
      timedSample({ network: { interface: 'en0', receivedBytes: 300, sentBytes: 0 } }, 5_000),
      timedSample({ network: { interface: 'en0', receivedBytes: 100, sentBytes: 0 } }, 3_000),
    );
    expect(view.receiveRate).toBe(100);
  });

  it('gives no rate for counters that went backwards or moved to another interface', () => {
    const reset = hostStatsView(
      reading(5, {
        cpuTime: { total: 10, idle: 5 },
        network: { interface: 'eth0', receivedBytes: 10, sentBytes: 10 },
      }),
      reading(100_000, {
        cpuTime: { total: 9_000, idle: 8_000 },
        network: { interface: 'eth0', receivedBytes: 900, sentBytes: 900 },
      }),
    );
    expect(reset.cpu).toBeUndefined();
    expect(reset.receiveRate).toBeUndefined();

    const moved = hostStatsView(
      reading(10, { network: { interface: 'wlan0', receivedBytes: 900, sentBytes: 900 } }),
      reading(5, { network: { interface: 'eth0', receivedBytes: 100, sentBytes: 100 } }),
    );
    expect(moved.receiveRate).toBeUndefined();
  });
});

describe('status bar formatting', () => {
  it('writes sizes in binary units with one decimal below 100', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(3.84 * 1024 ** 3)).toBe('3.8 GB');
    expect(formatBytes(250 * 1024 ** 3)).toBe('250 GB');
    expect(formatRate(2048)).toBe('2 KB/s');
  });

  it('clamps percentages', () => {
    expect(formatPercent(0.254)).toBe('25%');
    expect(formatPercent(1.2)).toBe('100%');
    expect(formatPercent(-0.1)).toBe('0%');
  });

  it('writes uptime with its two largest units', () => {
    expect(formatUptime(59)).toBe('0m');
    expect(formatUptime(5 * 60)).toBe('5m');
    expect(formatUptime(3 * 3600 + 20 * 60 + 5)).toBe('3h 20m');
    expect(formatUptime(2 * 3600)).toBe('2h');
    expect(formatUptime(12 * 86400 + 4 * 3600 + 59 * 60)).toBe('12d 4h');
    expect(formatUptime(3 * 86400 + 30 * 60)).toBe('3d');
  });

  it('lists users by how many sessions they have', () => {
    expect(describeUsers(['bob', 'alice', 'alice', 'carol'])).toBe('alice (2), bob, carol');
    expect(describeUsers([])).toBe('');
  });

  it('warns at 80% and turns critical at 95%', () => {
    expect(meterLevel(0.5)).toBe('normal');
    expect(meterLevel(0.8)).toBe('warning');
    expect(meterLevel(0.95)).toBe('critical');
  });
});

describe('status bar items', () => {
  it('keeps the bar order when an item is switched on', () => {
    expect(withStatusBarItem(['users', 'cpu'], 'hostname', true)).toEqual([
      'hostname',
      'cpu',
      'users',
    ]);
    expect(withStatusBarItem(['hostname', 'cpu'], 'cpu', false)).toEqual(['hostname']);
    expect(withStatusBarItem(['cpu'], 'cpu', true)).toEqual(['cpu']);
  });

  it('accepts only known, unrepeated items', () => {
    expect(isStatusBarItemList(['cpu', 'disk'])).toBe(true);
    expect(isStatusBarItemList([])).toBe(true);
    expect(isStatusBarItemList(['cpu', 'cpu'])).toBe(false);
    expect(isStatusBarItemList(['gpu'])).toBe(false);
    expect(isStatusBarItemList('cpu')).toBe(false);
  });
});
