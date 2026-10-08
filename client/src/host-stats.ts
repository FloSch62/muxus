import type { HostStatsSample } from '@muxus/shared';

/**
 * Status bar statistics, kept free of React so they can be tested: which
 * items exist, how two readings become rates, and how values are written.
 */

/** Status bar items, in the order the bar shows them. */
export const STATUS_BAR_ITEMS = [
  'hostname',
  'os',
  'cpu',
  'memory',
  'disk',
  'network',
  'uptime',
  'users',
] as const;

export type StatusBarItem = (typeof STATUS_BAR_ITEMS)[number];

export const STATUS_BAR_ITEM_LABELS: Record<StatusBarItem, string> = {
  hostname: 'Host name',
  os: 'Operating system',
  cpu: 'CPU usage',
  memory: 'Memory usage',
  disk: 'Disk usage',
  network: 'Network traffic',
  uptime: 'Uptime',
  users: 'Logged-in users',
};

export function isStatusBarItemList(value: unknown): value is StatusBarItem[] {
  return (
    Array.isArray(value) &&
    value.every((item) => (STATUS_BAR_ITEMS as readonly unknown[]).includes(item)) &&
    new Set(value).size === value.length
  );
}

/** Turn an item on or off, keeping the bar's order. */
export function withStatusBarItem(
  items: readonly StatusBarItem[],
  item: StatusBarItem,
  shown: boolean,
): StatusBarItem[] {
  const next = new Set(items);
  if (shown) next.add(item);
  else next.delete(item);
  return STATUS_BAR_ITEMS.filter((entry) => next.has(entry));
}

/** A reading with the time it describes, in seconds. */
export interface TimedSample {
  sample: HostStatsSample;
  /** The host's uptime when it reports one, else the server clock. */
  at: number;
}

export function timedSample(sample: HostStatsSample, sampledAt: number): TimedSample {
  return { sample, at: sample.uptimeSeconds ?? sampledAt / 1000 };
}

/** What the bar shows: the latest reading plus the rates since the one before. */
export interface HostStatsView {
  sample: HostStatsSample;
  /** Busy share of all cores since the previous reading, 0–1. */
  cpu?: number;
  /** Bytes per second since the previous reading. */
  receiveRate?: number;
  sendRate?: number;
}

/**
 * Rates need two readings of the same host. A counter that went backwards (a
 * reboot, an interface that was reset or replaced) gives no rate this round
 * instead of a negative or absurd one.
 */
export function hostStatsView(current: TimedSample, previous?: TimedSample): HostStatsView {
  const view: HostStatsView = { sample: current.sample };
  if (!previous) return view;
  const before = previous.sample;
  const now = current.sample;
  if (now.cpuTime && before.cpuTime) {
    const total = now.cpuTime.total - before.cpuTime.total;
    const idle = now.cpuTime.idle - before.cpuTime.idle;
    if (total > 0 && idle >= 0 && idle <= total) view.cpu = 1 - idle / total;
  }
  const seconds = current.at - previous.at;
  if (
    seconds > 0 &&
    now.network &&
    before.network &&
    now.network.interface === before.network.interface
  ) {
    const received = now.network.receivedBytes - before.network.receivedBytes;
    const sent = now.network.sentBytes - before.network.sentBytes;
    if (received >= 0) view.receiveRate = received / seconds;
    if (sent >= 0) view.sendRate = sent / seconds;
  }
  return view;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Binary multiples with the familiar short names: 1.5 GB, 820 MB, 12 KB. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const text = value.toFixed(digits).replace(/\.0$/, '');
  return `${text} ${BYTE_UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** Two largest units, the way `uptime` reads: 12d 4h, 3h 20m, 5m. */
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

export function memoryUsed(memory: NonNullable<HostStatsSample['memory']>): number {
  return Math.max(0, memory.totalBytes - memory.availableBytes);
}

/** Login sessions per user, busiest first: "alice (2), bob". */
export function describeUsers(users: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const user of users) counts.set(user, (counts.get(user) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([user, count]) => (count > 1 ? `${user} (${count})` : user))
    .join(', ');
}

/** Usage at which a meter turns to a warning, and to an error. */
export const METER_WARNING = 0.8;
export const METER_CRITICAL = 0.95;

export type MeterLevel = 'normal' | 'warning' | 'critical';

export function meterLevel(fraction: number): MeterLevel {
  if (fraction >= METER_CRITICAL) return 'critical';
  if (fraction >= METER_WARNING) return 'warning';
  return 'normal';
}
