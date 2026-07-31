import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  developmentUserDataPath,
  seedDevelopmentDatabase,
} from '../../../electron/src/development-database.js';

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

function directories(): { installed: string; development: string } {
  temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'muxus-electron-database-'));
  const installed = path.join(temporaryDirectory, 'Muxus');
  const development = developmentUserDataPath(installed);
  mkdirSync(installed, { recursive: true });
  mkdirSync(development, { recursive: true });
  return { installed, development };
}

function openDatabase(directory: string): DatabaseSync {
  return new DatabaseSync(path.join(directory, 'muxus.sqlite3'));
}

describe('Electron development database', () => {
  it('uses a sibling user-data directory', () => {
    expect(developmentUserDataPath('/profiles/Muxus')).toBe('/profiles/Muxus-development');
  });

  it('copies committed WAL data from the installed database', async () => {
    const { installed, development } = directories();
    const source = openDatabase(installed);
    source.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE example(value TEXT NOT NULL);
      INSERT INTO example VALUES ('installed');
    `);

    try {
      await expect(seedDevelopmentDatabase(installed, development)).resolves.toBe(true);
    } finally {
      source.close();
    }

    const copy = openDatabase(development);
    try {
      expect(copy.prepare('SELECT value FROM example').get()).toEqual({ value: 'installed' });
      expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      copy.close();
    }
  });

  it('refreshes an existing development database on every seed', async () => {
    const { installed, development } = directories();
    const source = openDatabase(installed);
    source.exec('CREATE TABLE example(value TEXT NOT NULL); INSERT INTO example VALUES (\'first\');');
    source.close();
    await seedDevelopmentDatabase(installed, development);

    const stale = openDatabase(development);
    stale.exec("INSERT INTO example VALUES ('development-only');");
    stale.close();

    const updatedSource = openDatabase(installed);
    updatedSource.exec("DELETE FROM example; INSERT INTO example VALUES ('second');");
    updatedSource.close();
    await seedDevelopmentDatabase(installed, development);

    const refreshed = openDatabase(development);
    try {
      expect(refreshed.prepare('SELECT value FROM example').all()).toEqual([
        { value: 'second' },
      ]);
    } finally {
      refreshed.close();
    }
  });

  it('keeps the development database when no installed database exists', async () => {
    const { installed, development } = directories();
    const existing = openDatabase(development);
    existing.exec("CREATE TABLE example(value TEXT NOT NULL); INSERT INTO example VALUES ('kept');");
    existing.close();

    await expect(seedDevelopmentDatabase(installed, development)).resolves.toBe(false);

    const unchanged = openDatabase(development);
    try {
      expect(unchanged.prepare('SELECT value FROM example').get()).toEqual({ value: 'kept' });
    } finally {
      unchanged.close();
    }
  });
});
