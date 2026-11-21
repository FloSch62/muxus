import {
  DEFAULT_HOST_MONITOR_INTERVAL_MS,
  HOST_MONITOR_INTERVALS_MS,
  type HostStatsSample,
  type MonitoredHost,
  type MonitoredHostState,
} from '@muxus/shared';
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatUptime,
  hostStatsView,
  memoryUsed,
  type HostStatsView,
  type TimedSample,
} from './host-stats.js';

/**
 * The host monitor's table, kept free of React so it can be tested: which
 * columns exist, how two readings become rates, what a cell says and how
 * rows are ordered.
 */

/** Columns after the host's name, in table order. */
export const MONITOR_COLUMNS = [
  'latency',
  'cpu',
  'load',
  'memory',
  'swap',
  'disk',
  'diskIo',
  'network',
  'gpu',
  'uptime',
  'users',
  'os',
  'kernel',
] as const;

export type MonitorColumn = (typeof MONITOR_COLUMNS)[number];

/** What a column sorts by, the host's name included. */
export type MonitorSortKey = MonitorColumn | 'host';

export const MONITOR_COLUMN_LABELS: Record<MonitorColumn, string> = {
  latency: 'Latency',
  cpu: 'CPU',
  load: 'Load',
  memory: 'Memory',
  swap: 'Swap',
  disk: 'Disk',
  diskIo: 'Disk I/O',
  network: 'Network',
  gpu: 'GPU',
  uptime: 'Uptime',
  users: 'Users',
  os: 'System',
  kernel: 'Kernel',
};

/** What each column shows, for the column menu. */
export const MONITOR_COLUMN_HINTS: Record<MonitorColumn, string> = {
  latency: 'How long the host takes to start answering',
  cpu: 'Busy share of all cores',
  load: 'Load average over 1, 5 and 15 minutes',
  memory: 'Memory in use',
  swap: 'Swap in use',
  disk: 'Space used on the root filesystem',
  diskIo: 'Bytes read and written per second, all disks',
  network: 'Traffic on the default route’s interface',
  gpu: 'NVIDIA GPU load and memory, read with nvidia-smi',
  uptime: 'Time since boot',
  users: 'Logged-in users',
  os: 'Operating system',
  kernel: 'Kernel release',
};

/** Shown until the user chooses: the numbers one watches, without the ones that cost extra. */
export const DEFAULT_MONITOR_COLUMNS: readonly MonitorColumn[] = [
  'latency',
  'cpu',
  'load',
  'memory',
  'disk',
  'diskIo',
  'network',
  'uptime',
];

/** Numbers line up on the right; text reads from the left. */
export const MONITOR_TEXT_COLUMNS: ReadonlySet<MonitorColumn> = new Set(['os', 'kernel', 'users']);

export function isMonitorColumnList(value: unknown): value is MonitorColumn[] {
  return (
    Array.isArray(value) &&
    value.every((item) => (MONITOR_COLUMNS as readonly unknown[]).includes(item)) &&
    new Set(value).size === value.length
  );
}

/** Turn a column on or off, keeping the table's order. */
export function withMonitorColumn(
  columns: readonly MonitorColumn[],
  column: MonitorColumn,
  shown: boolean,
): MonitorColumn[] {
  const next = new Set(columns);
  if (shown) next.add(column);
  else next.delete(column);
  return MONITOR_COLUMNS.filter((entry) => next.has(entry));
}

export interface MonitorSort {
  key: MonitorSortKey;
  descending: boolean;
}

export const DEFAULT_MONITOR_SORT: MonitorSort = { key: 'host', descending: false };

export function isMonitorSort(value: unknown): value is MonitorSort {
  if (value === null || typeof value !== 'object') return false;
  const { key, descending } = value as Partial<MonitorSort>;
  return (
    typeof descending === 'boolean' &&
    (key === 'host' || (MONITOR_COLUMNS as readonly unknown[]).includes(key))
  );
}

/**
 * A header click: the same column turns around, another one starts with what
 * one looks for there, the busiest host first and names from A.
 */
export function nextMonitorSort(current: MonitorSort, key: MonitorSortKey): MonitorSort {
  if (current.key === key) return { key, descending: !current.descending };
  const text = key === 'host' || key === 'os' || key === 'kernel';
  return { key, descending: !text };
}

export function isMonitorInterval(value: unknown): value is number {
  return (HOST_MONITOR_INTERVALS_MS as readonly unknown[]).includes(value);
}

export function monitorIntervalLabel(intervalMs: number): string {
  const seconds = intervalMs / 1000;
  return seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`;
}

export { DEFAULT_HOST_MONITOR_INTERVAL_MS, HOST_MONITOR_INTERVALS_MS };

/** The latest reading with the rates since the one before. */
export interface MonitorView extends HostStatsView {
  /** Bytes per second since the previous reading, over all disks. */
  diskReadRate?: number;
  diskWriteRate?: number;
}

/** {@link hostStatsView} plus the disk rates the monitor shows. */
export function monitorView(current: TimedSample, previous?: TimedSample): MonitorView {
  const view: MonitorView = hostStatsView(current, previous);
  const now = current.sample.diskIo;
  const before = previous?.sample.diskIo;
  const seconds = previous ? current.at - previous.at : 0;
  if (now && before && seconds > 0) {
    const read = now.readBytes - before.readBytes;
    const written = now.writtenBytes - before.writtenBytes;
    // Counters that went backwards mean a reboot or a disk that left.
    if (read >= 0) view.diskReadRate = read / seconds;
    if (written >= 0) view.diskWriteRate = written / seconds;
  }
  return view;
}

/** Where a row stands: waiting for its first reading, read, or why it is not. */
export type MonitorRowStatus = 'waiting' | 'ok' | MonitoredHostState;

/** What is known about one host of the monitor. */
export interface MonitorReading {
  status: MonitorRowStatus;
  /** Why the host has no reading, in the backend's words. */
  message?: string;
  view?: MonitorView;
  latencyMs?: number;
  /** When the shown values were read, by this computer's clock. */
  sampledAt?: number;
}

export const WAITING_READING: MonitorReading = { status: 'waiting' };

function fraction(used: number, total: number): number | undefined {
  return total > 0 ? Math.min(1, Math.max(0, used / total)) : undefined;
}

export function memoryFraction(sample: HostStatsSample): number | undefined {
  return sample.memory ? fraction(memoryUsed(sample.memory), sample.memory.totalBytes) : undefined;
}

export function swapFraction(sample: HostStatsSample): number | undefined {
  const { swapTotalBytes, swapFreeBytes } = sample.memory ?? {};
  if (!swapTotalBytes || swapFreeBytes === undefined) return undefined;
  return fraction(swapTotalBytes - swapFreeBytes, swapTotalBytes);
}

export function diskFraction(sample: HostStatsSample): number | undefined {
  return sample.disk ? fraction(sample.disk.usedBytes, sample.disk.totalBytes) : undefined;
}

/** The busiest card stands for a host with several. */
export function gpuUtilization(sample: HostStatsSample): number | undefined {
  const values = (sample.gpus ?? [])
    .map((gpu) => gpu.utilization)
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function sum(first: number | undefined, second: number | undefined): number | undefined {
  return first === undefined && second === undefined ? undefined : (first ?? 0) + (second ?? 0);
}

/** What a column orders a row by; `undefined` sorts last either way. */
export function monitorSortValue(
  key: MonitorSortKey,
  label: string,
  reading: MonitorReading,
): number | string | undefined {
  if (key === 'host') return label.toLowerCase();
  if (key === 'latency') return reading.latencyMs;
  const view = reading.view;
  if (!view) return undefined;
  const { sample } = view;
  switch (key) {
    case 'cpu':
      return view.cpu;
    case 'load':
      return sample.loadAverage?.[0];
    case 'memory':
      return memoryFraction(sample);
    case 'swap':
      return swapFraction(sample);
    case 'disk':
      return diskFraction(sample);
    case 'diskIo':
      return sum(view.diskReadRate, view.diskWriteRate);
    case 'network':
      return sum(view.receiveRate, view.sendRate);
    case 'gpu':
      return gpuUtilization(sample);
    case 'uptime':
      return sample.uptimeSeconds;
    case 'users':
      return sample.users?.length;
    case 'os':
      return sample.os?.toLowerCase();
    case 'kernel':
      return sample.kernel?.toLowerCase();
  }
}

export interface SortableMonitorRow {
  label: string;
  reading: MonitorReading;
  /** This computer's row stays first whatever the order. */
  pinned?: boolean;
}

/** Order rows by a column. Hosts without a value there go last, and equal ones by name. */
export function sortMonitorRows<T extends SortableMonitorRow>(rows: readonly T[], sort: MonitorSort): T[] {
  const byName = (a: T, b: T) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
  return [...rows].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const left = monitorSortValue(sort.key, a.label, a.reading);
    const right = monitorSortValue(sort.key, b.label, b.reading);
    if (left === undefined || right === undefined) {
      if (left === right) return byName(a, b);
      return left === undefined ? 1 : -1;
    }
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true });
    if (order === 0) return byName(a, b);
    return sort.descending ? -order : order;
  });
}

/** 8 ms, 240 ms, 1.4 s. */
export function formatLatency(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/** Latency at which a host reads as slow, and as very slow. */
export const LATENCY_WARNING_MS = 400;
export const LATENCY_CRITICAL_MS = 1500;

/** A value shown as a bar with its number beside it. */
export interface MonitorMeter {
  fraction: number;
  text: string;
}

/** What a cell shows: a meter, plain text, or nothing known. */
export type MonitorCell =
  | { kind: 'meter'; meter: MonitorMeter; detail?: string }
  | { kind: 'text'; text: string; detail?: string }
  | { kind: 'empty' };

const EMPTY: MonitorCell = { kind: 'empty' };

function meterCell(value: number | undefined, detail?: string): MonitorCell {
  return value === undefined
    ? EMPTY
    : { kind: 'meter', meter: { fraction: value, text: formatPercent(value) }, ...(detail ? { detail } : {}) };
}

function textCell(text: string | undefined, detail?: string): MonitorCell {
  return text ? { kind: 'text', text, ...(detail ? { detail } : {}) } : EMPTY;
}

function ratePair(down: number | undefined, up: number | undefined, downMark: string, upMark: string): string | undefined {
  if (down === undefined && up === undefined) return undefined;
  return `${downMark} ${down === undefined ? '–' : formatRate(down)}  ${upMark} ${up === undefined ? '–' : formatRate(up)}`;
}

/** A cell's content, with the longer story (`detail`) for its tooltip. */
export function monitorCell(column: MonitorColumn, reading: MonitorReading): MonitorCell {
  if (column === 'latency') {
    return reading.latencyMs === undefined ? EMPTY : textCell(formatLatency(reading.latencyMs));
  }
  const view = reading.view;
  if (!view) return EMPTY;
  const { sample } = view;
  switch (column) {
    case 'cpu':
      return meterCell(view.cpu, sample.cores ? `${sample.cores} core${sample.cores === 1 ? '' : 's'}` : undefined);
    case 'load': {
      const load = sample.loadAverage;
      if (!load) return EMPTY;
      return textCell(load[0].toFixed(2), `${load.map((value) => value.toFixed(2)).join('  ')} over 1, 5 and 15 minutes`);
    }
    case 'memory': {
      const { memory } = sample;
      if (!memory) return EMPTY;
      return meterCell(
        memoryFraction(sample),
        `${formatBytes(memoryUsed(memory))} of ${formatBytes(memory.totalBytes)}`,
      );
    }
    case 'swap': {
      const { swapTotalBytes, swapFreeBytes } = sample.memory ?? {};
      if (swapTotalBytes === 0) return textCell('none');
      if (!swapTotalBytes || swapFreeBytes === undefined) return EMPTY;
      return meterCell(
        swapFraction(sample),
        `${formatBytes(swapTotalBytes - swapFreeBytes)} of ${formatBytes(swapTotalBytes)}`,
      );
    }
    case 'disk': {
      const { disk } = sample;
      if (!disk) return EMPTY;
      return meterCell(
        diskFraction(sample),
        `${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)} on ${disk.mount}, ${formatBytes(disk.availableBytes)} free`,
      );
    }
    case 'diskIo':
      return textCell(ratePair(view.diskReadRate, view.diskWriteRate, 'R', 'W'), 'Read and written per second, all disks');
    case 'network':
      return textCell(
        ratePair(view.receiveRate, view.sendRate, '↓', '↑'),
        sample.network ? `Received and sent per second on ${sample.network.interface}` : undefined,
      );
    case 'gpu': {
      const gpus = sample.gpus;
      if (!gpus?.length) return EMPTY;
      const detail = gpus
        .map((gpu) =>
          [
            gpu.name ?? `GPU ${gpu.index}`,
            gpu.utilization !== undefined ? formatPercent(gpu.utilization) : undefined,
            gpu.memoryUsedBytes !== undefined && gpu.memoryTotalBytes !== undefined
              ? `${formatBytes(gpu.memoryUsedBytes)} of ${formatBytes(gpu.memoryTotalBytes)}`
              : undefined,
            gpu.temperatureCelsius !== undefined ? `${gpu.temperatureCelsius} °C` : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
        )
        .join('\n');
      const busiest = gpuUtilization(sample);
      return busiest === undefined ? textCell(`${gpus.length} GPU${gpus.length === 1 ? '' : 's'}`, detail) : meterCell(busiest, detail);
    }
    case 'uptime':
      return sample.uptimeSeconds === undefined ? EMPTY : textCell(formatUptime(sample.uptimeSeconds));
    case 'users': {
      const users = sample.users;
      if (!users) return EMPTY;
      const names = [...new Set(users)];
      return textCell(String(users.length), names.length > 0 ? names.join(', ') : undefined);
    }
    case 'os':
      return textCell(sample.os);
    case 'kernel':
      return textCell(sample.kernel);
  }
}

/** A row's host as shown when no saved host or tab names it. */
export function monitoredHostFallbackLabel(host: MonitoredHost): string {
  if (host.kind === 'local') return 'This computer';
  return host.target ?? host.host ?? host.id;
}

/** `deploy@10.0.0.4:2222`, with the port only when it is not 22. */
export function monitoredHostAddress(host: MonitoredHost): string | undefined {
  if (host.kind === 'local' || !host.host) return undefined;
  const address = host.host.includes(':') ? `[${host.host}]` : host.host;
  return `${host.user ? `${host.user}@` : ''}${address}${host.port && host.port !== 22 ? `:${host.port}` : ''}`;
}
