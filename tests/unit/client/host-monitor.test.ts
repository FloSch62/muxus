import { describe, expect, it } from 'vitest';
import type { HostStatsSample, MonitoredHost } from '@muxus/shared';
import { timedSample } from '../../../client/src/host-stats.js';
import {
  DEFAULT_MONITOR_COLUMNS,
  MONITOR_COLUMNS,
  formatLatency,
  isMonitorColumnList,
  isMonitorInterval,
  isMonitorSort,
  monitorCell,
  monitorIntervalLabel,
  monitorSortValue,
  monitorView,
  monitoredHostAddress,
  monitoredHostFallbackLabel,
  nextMonitorSort,
  sortMonitorRows,
  withMonitorColumn,
  type MonitorReading,
} from '../../../client/src/host-monitor.js';

const GIB = 1024 ** 3;

const SAMPLE: HostStatsSample = {
  hostname: 'web-01',
  os: 'Ubuntu 24.04.1 LTS',
  kernel: 'Linux 6.8.0-45-generic',
  uptimeSeconds: 1000,
  cpuTime: { total: 1000, idle: 800 },
  cores: 4,
  loadAverage: [0.5, 0.25, 0.1],
  memory: { totalBytes: 8 * GIB, availableBytes: 6 * GIB, swapTotalBytes: 2 * GIB, swapFreeBytes: 1 * GIB },
  network: { interface: 'eth0', receivedBytes: 1_000_000, sentBytes: 500_000 },
  users: ['alice', 'alice', 'bob'],
  disk: { mount: '/', totalBytes: 100 * GIB, usedBytes: 90 * GIB, availableBytes: 10 * GIB },
  diskIo: { readBytes: 10_000_000, writtenBytes: 20_000_000 },
};

/** The same host ten seconds later. */
const LATER: HostStatsSample = {
  ...SAMPLE,
  uptimeSeconds: 1010,
  cpuTime: { total: 1400, idle: 1100 },
  network: { interface: 'eth0', receivedBytes: 1_020_480, sentBytes: 505_120 },
  diskIo: { readBytes: 10_102_400, writtenBytes: 22_048_000 },
};

function reading(sample: HostStatsSample, previous?: HostStatsSample, latencyMs?: number): MonitorReading {
  return {
    status: 'ok',
    view: monitorView(timedSample(sample, 0), previous ? timedSample(previous, 0) : undefined),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

describe('monitor columns', () => {
  it('accepts lists of known columns without repeats', () => {
    expect(isMonitorColumnList([...DEFAULT_MONITOR_COLUMNS])).toBe(true);
    expect(isMonitorColumnList([])).toBe(true);
    expect(isMonitorColumnList(['cpu', 'cpu'])).toBe(false);
    expect(isMonitorColumnList(['cpu', 'temperature'])).toBe(false);
    expect(isMonitorColumnList('cpu')).toBe(false);
  });

  it('leaves the column that costs every host a moment off until it is asked for', () => {
    expect(DEFAULT_MONITOR_COLUMNS).not.toContain('gpu');
  });

  it('turns a column on or off without disturbing the table order', () => {
    expect(withMonitorColumn(['cpu', 'uptime'], 'memory', true)).toEqual(['cpu', 'memory', 'uptime']);
    expect(withMonitorColumn(['cpu', 'memory', 'uptime'], 'memory', false)).toEqual(['cpu', 'uptime']);
    expect(withMonitorColumn(['uptime', 'cpu'], 'cpu', true)).toEqual(['cpu', 'uptime']);
  });

  it('knows the intervals a monitor can run at', () => {
    expect(isMonitorInterval(5000)).toBe(true);
    expect(isMonitorInterval(1234)).toBe(false);
    expect(monitorIntervalLabel(2000)).toBe('2 s');
    expect(monitorIntervalLabel(60_000)).toBe('1 min');
  });
});

describe('rates between two readings', () => {
  it('adds disk rates to the status bar’s CPU and network rates', () => {
    const view = monitorView(timedSample(LATER, 0), timedSample(SAMPLE, 0));
    expect(view.cpu).toBeCloseTo(0.25);
    expect(view.receiveRate).toBeCloseTo(2048);
    expect(view.diskReadRate).toBeCloseTo(10_240);
    expect(view.diskWriteRate).toBeCloseTo(204_800);
  });

  it('has no rates from one reading, or from counters that went backwards', () => {
    expect(monitorView(timedSample(SAMPLE, 0)).diskReadRate).toBeUndefined();
    const rebooted = monitorView(timedSample({ ...LATER, diskIo: { readBytes: 5, writtenBytes: 30_000_000 } }, 0), timedSample(SAMPLE, 0));
    expect(rebooted.diskReadRate).toBeUndefined();
    expect(rebooted.diskWriteRate).toBeGreaterThan(0);
  });
});

describe('what a cell shows', () => {
  const now = reading(LATER, SAMPLE, 42);

  it('draws usage as a meter with the amounts behind it', () => {
    expect(monitorCell('cpu', now)).toEqual({ kind: 'meter', meter: { fraction: 0.25, text: '25%' }, detail: '4 cores' });
    expect(monitorCell('memory', now)).toEqual({ kind: 'meter', meter: { fraction: 0.25, text: '25%' }, detail: '2 GB of 8 GB' });
    expect(monitorCell('swap', now)).toMatchObject({ kind: 'meter', meter: { text: '50%' } });
    expect(monitorCell('disk', now)).toMatchObject({ kind: 'meter', meter: { text: '90%' }, detail: '90 GB of 100 GB on /, 10 GB free' });
  });

  it('writes rates, load, uptime and latency as text', () => {
    expect(monitorCell('latency', now)).toEqual({ kind: 'text', text: '42 ms' });
    expect(monitorCell('load', now)).toMatchObject({ kind: 'text', text: '0.50' });
    expect(monitorCell('diskIo', now)).toMatchObject({ kind: 'text', text: 'R 10 KB/s  W 200 KB/s' });
    expect(monitorCell('network', now)).toMatchObject({ kind: 'text', text: '↓ 2 KB/s  ↑ 512 B/s' });
    expect(monitorCell('uptime', now)).toEqual({ kind: 'text', text: '16m' });
    expect(monitorCell('users', now)).toEqual({ kind: 'text', text: '3', detail: 'alice, bob' });
    expect(monitorCell('os', now)).toEqual({ kind: 'text', text: 'Ubuntu 24.04.1 LTS' });
  });

  it('shows nothing where nothing is known', () => {
    const first = reading(SAMPLE);
    expect(monitorCell('cpu', first)).toEqual({ kind: 'empty' });
    expect(monitorCell('diskIo', first)).toEqual({ kind: 'empty' });
    expect(monitorCell('gpu', first)).toEqual({ kind: 'empty' });
    expect(monitorCell('latency', first)).toEqual({ kind: 'empty' });
    expect(monitorCell('cpu', { status: 'waiting' })).toEqual({ kind: 'empty' });
  });

  it('says a host has no swap rather than leaving the cell blank', () => {
    const noSwap = reading({ ...SAMPLE, memory: { totalBytes: GIB, availableBytes: GIB, swapTotalBytes: 0, swapFreeBytes: 0 } });
    expect(monitorCell('swap', noSwap)).toEqual({ kind: 'text', text: 'none' });
  });

  it('shows the busiest GPU and lists every card behind it', () => {
    const gpus = reading({
      ...SAMPLE,
      gpus: [
        { index: 0, name: 'RTX 4090', utilization: 0.2, memoryUsedBytes: 2 * GIB, memoryTotalBytes: 24 * GIB, temperatureCelsius: 50 },
        { index: 1, name: 'RTX 4090', utilization: 0.9 },
      ],
    });
    const cell = monitorCell('gpu', gpus);
    expect(cell).toMatchObject({ kind: 'meter', meter: { fraction: 0.9, text: '90%' } });
    expect(cell.kind === 'meter' && cell.detail).toBe('RTX 4090 · 20% · 2 GB of 24 GB · 50 °C\nRTX 4090 · 90%');
  });

  it('formats latency in the unit that reads best', () => {
    expect(formatLatency(8.4)).toBe('8 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1400)).toBe('1.4 s');
  });
});

describe('sorting the table', () => {
  const rows = [
    { label: 'web-10', reading: reading({ ...LATER, cpuTime: { total: 2000, idle: 1000 } }, SAMPLE, 30) },
    { label: 'web-2', reading: reading(LATER, SAMPLE, 300) },
    { label: 'router', reading: { status: 'idle' } as MonitorReading },
    { label: 'This computer', reading: reading(LATER, SAMPLE), pinned: true },
  ];
  const names = (sorted: typeof rows) => sorted.map((row) => row.label);

  it('orders names the way a person would, with this computer first', () => {
    expect(names(sortMonitorRows(rows, { key: 'host', descending: false }))).toEqual(['This computer', 'router', 'web-2', 'web-10']);
    expect(names(sortMonitorRows(rows, { key: 'host', descending: true }))).toEqual(['This computer', 'web-10', 'web-2', 'router']);
  });

  it('puts hosts without a value last in either direction', () => {
    expect(names(sortMonitorRows(rows, { key: 'latency', descending: true }))).toEqual(['This computer', 'web-2', 'web-10', 'router']);
    expect(names(sortMonitorRows(rows, { key: 'latency', descending: false }))).toEqual(['This computer', 'web-10', 'web-2', 'router']);
  });

  it('orders by the number behind a cell, not by its text', () => {
    expect(monitorSortValue('cpu', 'web-10', rows[0]!.reading)).toBeCloseTo(0.8);
    expect(names(sortMonitorRows(rows, { key: 'cpu', descending: true })).slice(1)).toEqual(['web-10', 'web-2', 'router']);
  });

  it('starts a number column with the busiest host and a name column from A, and turns around on the second click', () => {
    expect(nextMonitorSort({ key: 'host', descending: false }, 'cpu')).toEqual({ key: 'cpu', descending: true });
    expect(nextMonitorSort({ key: 'cpu', descending: true }, 'cpu')).toEqual({ key: 'cpu', descending: false });
    expect(nextMonitorSort({ key: 'cpu', descending: true }, 'host')).toEqual({ key: 'host', descending: false });
    expect(nextMonitorSort({ key: 'cpu', descending: true }, 'os')).toEqual({ key: 'os', descending: false });
  });

  it('accepts only sorts over columns that exist', () => {
    expect(isMonitorSort({ key: 'host', descending: false })).toBe(true);
    for (const key of MONITOR_COLUMNS) expect(isMonitorSort({ key, descending: true })).toBe(true);
    expect(isMonitorSort({ key: 'temperature', descending: true })).toBe(false);
    expect(isMonitorSort({ key: 'cpu' })).toBe(false);
    expect(isMonitorSort(null)).toBe(false);
  });
});

describe('naming a host nobody saved', () => {
  const host: MonitoredHost = { id: 'x', kind: 'ssh', connIds: ['c1'], target: 'admin@10.0.0.9:2222', host: '10.0.0.9', port: 2222, user: 'admin' };

  it('falls back to what was dialed', () => {
    expect(monitoredHostFallbackLabel(host)).toBe('admin@10.0.0.9:2222');
    expect(monitoredHostFallbackLabel({ id: 'local', kind: 'local', connIds: [] })).toBe('This computer');
  });

  it('writes the address with its port only when that is not 22', () => {
    expect(monitoredHostAddress(host)).toBe('admin@10.0.0.9:2222');
    expect(monitoredHostAddress({ ...host, port: 22 })).toBe('admin@10.0.0.9');
    expect(monitoredHostAddress({ ...host, host: 'fe80::1', port: 22 })).toBe('admin@[fe80::1]');
    expect(monitoredHostAddress({ id: 'local', kind: 'local', connIds: [] })).toBeUndefined();
  });
});
