import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';

let directory: string | undefined;
let built: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('session history v6 migration', () => {
  it('imports legacy BLOB events and removes history tables from muxus.sqlite', async () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'muxus-history-migration-'));
    const databasePath = path.join(directory, 'muxus.sqlite');
    const historyPath = path.join(directory, 'history');
    const application = new MuxusDatabase(databasePath);
    application.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.prepare(`
      INSERT INTO session_logs(
        id, profile_key, title, kind, host, started_at, ended_at,
        status, capture_input, event_count, raw_bytes, normalized_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-session',
      'ssh:legacy',
      'Legacy router',
      'ssh',
      'legacy',
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T10:01:00.000Z',
      'completed',
      0,
      1,
      13,
      13,
    );
    legacy.prepare(`
      INSERT INTO session_log_events(
        session_id, part_number, sequence, recorded_at, elapsed_ms,
        direction, raw_data, normalized_text
      ) VALUES (?, 1, 1, ?, 1000, 'output', ?, ?)
    `).run(
      'legacy-session',
      '2026-01-01T10:00:01.000Z',
      Buffer.from('legacy output'),
      'legacy output',
    );
    legacy.close();

    built = await buildApp(resolveConfig({
      databasePath,
      historyPath,
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }));

    const history = await built.ctx.history.sessionHistory({
      query: 'legacy output',
      limit: 10,
    });
    expect(history.sessions).toEqual([
      expect.objectContaining({ id: 'legacy-session', title: 'Legacy router' }),
    ]);
    expect((await built.ctx.history.rawSessionLogEvents('legacy-session'))?.[0]?.raw)
      .toEqual(Buffer.from('legacy output'));

    const compacted = new DatabaseSync(databasePath, { readOnly: true });
    const historyTables = compacted.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('session_logs', 'session_log_events', 'session_log_events_fts')
    `).all();
    compacted.close();
    expect(historyTables).toEqual([]);
  });
});
