import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_LOG_CAPACITY,
  appLogEntries,
  appLogPinoSink,
  appendAppLog,
  clearAppLog,
} from '../../../server/src/logging/log-buffer.js';

beforeEach(() => {
  clearAppLog();
});

describe('app log buffer', () => {
  it('stores shell entries with level, source and context', () => {
    appendAppLog('error', 'the embedded server failed to start', { err: 'EADDRINUSE' });

    const entries = appLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      source: 'app',
      msg: 'the embedded server failed to start',
      context: { err: 'EADDRINUSE' },
    });
    expect(entries[0]!.ts).toBeGreaterThan(0);
  });

  it('drops the oldest entries beyond the capacity', () => {
    for (let i = 0; i < APP_LOG_CAPACITY + 10; i++) {
      appendAppLog('info', `entry ${i}`);
    }

    const entries = appLogEntries();
    expect(entries).toHaveLength(APP_LOG_CAPACITY);
    expect(entries[0]!.msg).toBe('entry 10');
    expect(entries[entries.length - 1]!.msg).toBe(`entry ${APP_LOG_CAPACITY + 9}`);
  });

  it('clears on demand', () => {
    appendAppLog('info', 'before');
    clearAppLog();
    expect(appLogEntries()).toEqual([]);
  });

  it('parses serialized pino records into server entries', () => {
    const sink = appLogPinoSink();
    sink.write(
      JSON.stringify({
        level: 40,
        time: 1753862400000,
        pid: 4242,
        hostname: 'box',
        host: 'db.example.com',
        err: { type: 'Error', message: 'agent did not respond' },
        msg: 'ssh dial failed',
      }),
    );

    const entries = appLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      ts: 1753862400000,
      level: 'warn',
      source: 'server',
      msg: 'ssh dial failed',
      context: {
        host: 'db.example.com',
        err: { type: 'Error', message: 'agent did not respond' },
      },
    });
  });

  it('skips fastify per-request noise and unparseable lines', () => {
    const sink = appLogPinoSink();
    sink.write(JSON.stringify({ level: 30, time: 1, msg: 'incoming request', reqId: 'req-1' }));
    sink.write(JSON.stringify({ level: 30, time: 2, msg: 'request completed', reqId: 'req-1' }));
    sink.write('not json\n');
    sink.write(JSON.stringify({ level: 50, time: 3, msg: 'request errored', reqId: 'req-1' }));

    const entries = appLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', msg: 'request errored' });
  });

  it('maps unknown pino levels to sane names', () => {
    const sink = appLogPinoSink();
    sink.write(JSON.stringify({ level: 60, time: 1, msg: 'fatal thing' }));
    sink.write(JSON.stringify({ level: 5, time: 2, msg: 'below trace' }));
    sink.write(JSON.stringify({ level: 'nope', time: 3, msg: 'no level' }));

    expect(appLogEntries().map((e) => e.level)).toEqual(['fatal', 'trace', 'info']);
  });
});
