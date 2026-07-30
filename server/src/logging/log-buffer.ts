import type { AppLogEntry, AppLogLevel } from '@muxus/shared';

export const APP_LOG_CAPACITY = 5000;

/** pino numeric levels → names; unknown values round down to 'info'. */
const PINO_LEVELS: Array<[number, AppLogLevel]> = [
  [60, 'fatal'],
  [50, 'error'],
  [40, 'warn'],
  [30, 'info'],
  [20, 'debug'],
  [10, 'trace'],
];

function levelName(value: unknown): AppLogLevel {
  if (typeof value !== 'number') return 'info';
  for (const [threshold, name] of PINO_LEVELS) {
    if (value >= threshold) return name;
  }
  return 'trace';
}

/** Record fields that describe the process, not the event. */
const NOISE_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname']);

class AppLogBuffer {
  private readonly slots: Array<AppLogEntry | undefined> = Array.from({ length: APP_LOG_CAPACITY });
  private next = 0;
  private size = 0;

  append(entry: AppLogEntry): void {
    this.slots[this.next] = entry;
    this.next = (this.next + 1) % APP_LOG_CAPACITY;
    if (this.size < APP_LOG_CAPACITY) this.size++;
  }

  list(): AppLogEntry[] {
    const start = (this.next - this.size + APP_LOG_CAPACITY) % APP_LOG_CAPACITY;
    const out: AppLogEntry[] = [];
    for (let i = 0; i < this.size; i++) {
      const entry = this.slots[(start + i) % APP_LOG_CAPACITY];
      if (entry) out.push(entry);
    }
    return out;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.next = 0;
    this.size = 0;
  }
}

/**
 * One buffer per process. The Electron shell bundles the server into its main
 * process, so shell milestones and backend logs land in the same timeline the
 * log viewer and export read.
 */
const buffer = new AppLogBuffer();

export function appLogEntries(): AppLogEntry[] {
  return buffer.list();
}

export function clearAppLog(): void {
  buffer.clear();
}

/** Direct entry point for the desktop shell (and anything else without pino). */
export function appendAppLog(
  level: AppLogLevel,
  msg: string,
  context?: Record<string, unknown>,
): void {
  buffer.append({
    ts: Date.now(),
    level,
    source: 'app',
    msg,
    ...(context ? { context } : {}),
  });
}

/** A pino destination that mirrors every serialized record into the buffer. */
export function appLogPinoSink(): { write(line: string): void } {
  return {
    write(line: string): void {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      // Fastify's per-request lines would flush real events out of the ring
      // within minutes of routine client polling. Request *errors* stay.
      if (record.msg === 'incoming request' || record.msg === 'request completed') return;
      const context: Record<string, unknown> = {};
      let hasContext = false;
      for (const [key, value] of Object.entries(record)) {
        if (NOISE_KEYS.has(key)) continue;
        context[key] = value;
        hasContext = true;
      }
      buffer.append({
        ts: typeof record.time === 'number' ? record.time : Date.now(),
        level: levelName(record.level),
        source: 'server',
        msg: typeof record.msg === 'string' ? record.msg : '',
        ...(hasContext ? { context } : {}),
      });
    },
  };
}
