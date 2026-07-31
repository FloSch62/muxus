import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  developmentVaultId,
  developmentUserDataPath,
  seedDevelopmentDatabase,
  type DevelopmentVaultKeyStore,
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

class TestVaultKeyStore implements DevelopmentVaultKeyStore {
  readonly values = new Map<string, Buffer>();

  async get(vaultId: string): Promise<Buffer | undefined> {
    const value = this.values.get(vaultId);
    return value ? Buffer.from(value) : undefined;
  }

  async set(vaultId: string, key: Buffer): Promise<void> {
    this.values.set(vaultId, Buffer.from(key));
  }
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
      await expect(seedDevelopmentDatabase(installed, development)).resolves.toMatchObject({
        databaseCopied: true,
      });
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

    await expect(seedDevelopmentDatabase(installed, development)).resolves.toMatchObject({
      databaseCopied: false,
    });

    const unchanged = openDatabase(development);
    try {
      expect(unchanged.prepare('SELECT value FROM example').get()).toEqual({ value: 'kept' });
    } finally {
      unchanged.close();
    }
  });

  it('forces copied session history into development storage', async () => {
    const { installed, development } = directories();
    const source = openDatabase(installed);
    source.exec(`
      CREATE TABLE session_history_settings(
        singleton INTEGER PRIMARY KEY,
        storage_location TEXT
      );
      INSERT INTO session_history_settings VALUES (1, '/production/history');
    `);
    source.close();

    await seedDevelopmentDatabase(installed, development);

    const copy = openDatabase(development);
    try {
      expect(
        copy.prepare('SELECT storage_location FROM session_history_settings').get(),
      ).toEqual({ storage_location: null });
    } finally {
      copy.close();
    }
  });

  it('namespaces automatic vault keys and drops copied cleanup work', async () => {
    const { installed, development } = directories();
    const sourceVaultId = 'production-vault-id';
    const sourceKey = Buffer.alloc(32, 0x5a);
    const keyStore = new TestVaultKeyStore();
    keyStore.values.set(sourceVaultId, Buffer.from(sourceKey));

    const source = openDatabase(installed);
    source.exec(`
      CREATE TABLE password_vault(
        singleton INTEGER PRIMARY KEY,
        vault_id TEXT NOT NULL,
        unlock_policy TEXT NOT NULL
      );
      CREATE TABLE password_vault_key_cleanup(vault_id TEXT PRIMARY KEY);
      INSERT INTO password_vault VALUES (1, '${sourceVaultId}', 'never');
      INSERT INTO password_vault_key_cleanup VALUES ('production-old-vault');
    `);
    source.close();

    await expect(
      seedDevelopmentDatabase(installed, development, keyStore),
    ).resolves.toEqual({ databaseCopied: true, automaticVaultKey: 'copied' });

    const namespacedVaultId = developmentVaultId(sourceVaultId);
    const copy = openDatabase(development);
    try {
      expect(copy.prepare('SELECT vault_id FROM password_vault').get()).toEqual({
        vault_id: namespacedVaultId,
      });
      expect(copy.prepare('SELECT vault_id FROM password_vault_key_cleanup').all()).toEqual(
        [],
      );
    } finally {
      copy.close();
    }
    expect(keyStore.values.get(sourceVaultId)).toEqual(sourceKey);
    expect(keyStore.values.get(namespacedVaultId)).toEqual(sourceKey);
  });
});
