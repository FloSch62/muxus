import { parseGnmiPath, stripModulePrefix, tryParseGnmiPath, type GnmiNotification } from '@muxus/shared';
import { guessListKeys, KeyRegistry } from './data-tree.js';

/**
 * The latest value of every leaf a subscription delivered, with what makes
 * telemetry readable: per-second rates for counters, a short history for a
 * sparkline, and when each value last changed. Updates are applied to
 * plain data here; the view samples it a few times a second.
 */

export const HISTORY_POINTS = 60;

export interface LiveRow {
  path: string;
  value: unknown;
  /** Device timestamp of the last update, in milliseconds. */
  updatedAt: number;
  /** Local clock when the last update arrived (devices' clocks drift). */
  receivedAt: number;
  updates: number;
  /** Numeric reading of the value, when it has one. */
  numeric?: number;
  /** Per second, for values that only ever grew (counters). */
  rate?: number;
  /** Rates for counters, values for everything else numeric. */
  history: number[];
  /** Has only increased so far: treated as a counter. */
  counter: boolean;
  /** performance.now() when the value last changed, for the change highlight. */
  changedAt?: number;
  deleted?: boolean;
  /** Device time of the previous numeric sample, for the rate. */
  sampleTime?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nanosToMillis(timestamp: string): number {
  try {
    return Number(BigInt(timestamp) / 1_000_000n);
  } catch {
    return Date.now();
  }
}

function escapeKey(value: string): string {
  return value.replace(/[\\\]]/g, (char) => `\\${char}`);
}

/**
 * Leaves of a value delivered at `base`: telemetry often sends a container
 * path with a small JSON object rather than one update per leaf.
 */
export function flattenValue(
  base: string,
  value: unknown,
  registry: KeyRegistry,
  out: Array<[string, unknown]> = [],
): Array<[string, unknown]> {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) out.push([base, value]);
    for (const [name, child] of entries) flattenValue(`${base === '/' ? '' : base}/${name}`, child, registry, out);
    return out;
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
    const parsed = tryParseGnmiPath(base);
    const schema = parsed ? `/${parsed.elems.map((elem) => stripModulePrefix(elem.name)).join('/')}` : base;
    const keys = registry.lookup(schema) ?? guessListKeys(value);
    for (const entry of value) {
      const predicate = keys
        .map((key) => {
          const field = key in entry ? key : Object.keys(entry).find((name) => stripModulePrefix(name) === key);
          return `[${stripModulePrefix(key)}=${escapeKey(String(field === undefined ? '' : entry[field]))}]`;
        })
        .join('');
      const rest = Object.fromEntries(Object.entries(entry).filter(([name]) => !keys.includes(stripModulePrefix(name))));
      flattenValue(`${base}${predicate}`, rest, registry, out);
    }
    return out;
  }
  out.push([base, value]);
  return out;
}

export class LiveTable {
  readonly rows = new Map<string, LiveRow>();
  readonly registry = new KeyRegistry();
  notifications = 0;
  leafUpdates = 0;
  bytes = 0;
  startedAt = Date.now();
  /** The device has sent the initial state (sync_response). */
  synced = false;
  version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  markSynced(): void {
    this.synced = true;
    this.changed();
  }

  clear(): void {
    this.rows.clear();
    this.notifications = 0;
    this.leafUpdates = 0;
    this.bytes = 0;
    this.startedAt = Date.now();
    this.changed();
  }

  apply(notifications: readonly GnmiNotification[], bytes: number): void {
    const now = performance.now();
    this.bytes += bytes;
    for (const notification of notifications) {
      this.notifications += 1;
      const time = nanosToMillis(notification.timestamp);
      for (const update of notification.updates) {
        try {
          this.registry.learn(parseGnmiPath(update.path));
        } catch {
          /* keep the update even if its path does not parse */
        }
        for (const [path, value] of flattenValue(update.path, update.value.value, this.registry)) {
          this.leafUpdates += 1;
          this.update(path, value, time, now);
        }
      }
      for (const path of notification.deletes) {
        for (const [key, row] of this.rows) {
          if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}[`)) {
            row.deleted = true;
            row.changedAt = now;
            row.updatedAt = time;
          }
        }
      }
    }
    if (notifications.length) this.changed();
  }

  private update(path: string, value: unknown, time: number, now: number): void {
    const numeric = numericValue(value);
    const row = this.rows.get(path);
    if (!row) {
      this.rows.set(path, {
        path,
        value,
        updatedAt: time,
        receivedAt: Date.now(),
        updates: 1,
        ...(numeric !== undefined ? { numeric, sampleTime: time } : {}),
        history: numeric !== undefined ? [numeric] : [],
        counter: numeric !== undefined,
      });
      return;
    }
    row.updates += 1;
    row.deleted = false;
    if (!Object.is(row.value, value) && JSON.stringify(row.value) !== JSON.stringify(value)) row.changedAt = now;
    if (numeric !== undefined && row.numeric !== undefined && row.sampleTime !== undefined) {
      const seconds = (time - row.sampleTime) / 1000;
      if (row.counter && numeric < row.numeric) {
        // It went down: a gauge after all, or a counter that was cleared.
        row.counter = false;
        row.rate = undefined;
        row.history = [row.numeric];
      }
      if (row.counter) {
        if (seconds > 0) {
          // A counter's first sample is its raw value; from the first rate on, the history holds rates.
          if (row.rate === undefined) row.history = [];
          row.rate = (numeric - row.numeric) / seconds;
          row.history.push(row.rate);
        }
      } else {
        row.history.push(numeric);
      }
      if (row.history.length > HISTORY_POINTS) row.history.splice(0, row.history.length - HISTORY_POINTS);
    }
    row.value = value;
    row.updatedAt = time;
    row.receivedAt = Date.now();
    if (numeric !== undefined && (row.sampleTime === undefined || time >= row.sampleTime)) {
      row.numeric = numeric;
      row.sampleTime = time;
    }
  }
}

const SI = ['', 'k', 'M', 'G', 'T', 'P'];

/** 1234567 → "1.23 M". */
export function formatSi(value: number, digits = 3): string {
  const sign = value < 0 ? '-' : '';
  let magnitude = Math.abs(value);
  let unit = 0;
  while (magnitude >= 1000 && unit < SI.length - 1) {
    magnitude /= 1000;
    unit += 1;
  }
  const text = magnitude === 0 ? '0' : magnitude >= 100 ? magnitude.toFixed(0) : magnitude.toPrecision(digits);
  return `${sign}${text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}${SI[unit] ? ` ${SI[unit]}` : ''}`;
}

function withUnit(si: string, unit: string): string {
  // "1.2 M" + "bit/s" → "1.2 Mbit/s"; "512" + "bit/s" → "512 bit/s".
  return si.includes(' ') ? `${si}${unit}` : `${si} ${unit}`;
}

/** A counter rate in the units its leaf name suggests. */
export function formatRate(path: string, rate: number): string {
  const leaf = stripModulePrefix(path.slice(path.lastIndexOf('/') + 1)).toLowerCase();
  if (/octets|bytes/.test(leaf)) return withUnit(formatSi(rate * 8), 'bit/s');
  if (/packets|pkts|frames/.test(leaf)) return withUnit(formatSi(rate), 'pkt/s');
  return withUnit(formatSi(rate), '/s');
}
