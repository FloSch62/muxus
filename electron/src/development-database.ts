import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const DATABASE_FILENAME = 'muxus.sqlite3';
const DEVELOPMENT_VAULT_PREFIX = 'development:';

export interface DevelopmentVaultKeyStore {
  get(vaultId: string): Promise<Buffer | undefined>;
  set(vaultId: string, key: Buffer): Promise<void>;
}

export interface DevelopmentDatabaseSeedResult {
  databaseCopied: boolean;
  automaticVaultKey: 'not-needed' | 'copied' | 'missing' | 'unavailable';
}

interface VaultKeyRemap {
  sourceVaultId: string;
  developmentVaultId: string;
  automatic: boolean;
}

/** Keep source launches isolated from the profile used by an installed build. */
export function developmentUserDataPath(installedUserDataPath: string): string {
  return `${installedUserDataPath}-development`;
}

/** Vault IDs double as OS credential-store account names. */
export function developmentVaultId(installedVaultId: string): string {
  const digest = createHash('sha256').update(installedVaultId, 'utf8').digest('base64url');
  return `${DEVELOPMENT_VAULT_PREFIX}${digest}`;
}

/**
 * Refresh the development database from the installed application database.
 * SQLite's backup API is required here: copying the main file directly can
 * omit committed transactions which still live in its WAL file.
 */
export async function seedDevelopmentDatabase(
  installedUserDataPath: string,
  developmentUserDataPath: string,
  keyStore?: DevelopmentVaultKeyStore,
): Promise<DevelopmentDatabaseSeedResult> {
  const sourcePath = path.join(installedUserDataPath, DATABASE_FILENAME);
  const destinationPath = path.join(developmentUserDataPath, DATABASE_FILENAME);
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    throw new Error('development database path must differ from the installed database path');
  }

  mkdirSync(developmentUserDataPath, { recursive: true, mode: 0o700 });
  if (!existsSync(sourcePath)) {
    const remap = existsSync(destinationPath)
      ? isolateDevelopmentData(destinationPath, false)
      : undefined;
    return {
      databaseCopied: false,
      automaticVaultKey: await copyAutomaticVaultKey(remap, keyStore),
    };
  }

  const temporaryDirectory = mkdtempSync(
    path.join(developmentUserDataPath, '.database-seed-'),
  );
  const temporaryDatabase = path.join(temporaryDirectory, DATABASE_FILENAME);
  let source: DatabaseSync | undefined;

  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
    await backup(source, temporaryDatabase);
    const remap = isolateDevelopmentData(temporaryDatabase, true);
    const automaticVaultKey = await copyAutomaticVaultKey(remap, keyStore);
    try {
      chmodSync(temporaryDatabase, 0o600);
    } catch {
      /* permissions may be controlled by the platform/filesystem */
    }

    // No development process is running: the single-instance lock is already
    // held before this function is called. Discard sidecars from the previous
    // seed before atomically replacing its main database file.
    rmSync(`${destinationPath}-wal`, { force: true });
    rmSync(`${destinationPath}-shm`, { force: true });
    renameSync(temporaryDatabase, destinationPath);
    return { databaseCopied: true, automaticVaultKey };
  } finally {
    source?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function isolateDevelopmentData(
  databasePath: string,
  copiedFromInstalledApp: boolean,
): VaultKeyRemap | undefined {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    // Ensure the changes below live in the main file before it is renamed.
    database.exec('PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE;');
    try {
      if (tableExists(database, 'session_history_settings')) {
        database.exec('UPDATE session_history_settings SET storage_location = NULL;');
      }

      if (tableExists(database, 'password_vault_key_cleanup')) {
        if (copiedFromInstalledApp) {
          database.exec('DELETE FROM password_vault_key_cleanup;');
        } else {
          database
            .prepare('DELETE FROM password_vault_key_cleanup WHERE vault_id NOT LIKE ?')
            .run(`${DEVELOPMENT_VAULT_PREFIX}%`);
        }
      }

      let remap: VaultKeyRemap | undefined;
      if (tableExists(database, 'password_vault')) {
        const vault = database
          .prepare('SELECT vault_id, unlock_policy FROM password_vault WHERE singleton = 1')
          .get();
        if (vault) {
          const sourceVaultId = String(vault.vault_id);
          if (copiedFromInstalledApp || !sourceVaultId.startsWith(DEVELOPMENT_VAULT_PREFIX)) {
            const nextVaultId = developmentVaultId(sourceVaultId);
            database
              .prepare('UPDATE password_vault SET vault_id = ? WHERE singleton = 1')
              .run(nextVaultId);
            remap = {
              sourceVaultId,
              developmentVaultId: nextVaultId,
              automatic: String(vault.unlock_policy) === 'never',
            };
          }
        }
      }

      database.exec('COMMIT;');
      return remap;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    database.close();
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return !!database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

async function copyAutomaticVaultKey(
  remap: VaultKeyRemap | undefined,
  keyStore: DevelopmentVaultKeyStore | undefined,
): Promise<DevelopmentDatabaseSeedResult['automaticVaultKey']> {
  if (!remap?.automatic || !keyStore) return 'not-needed';
  let key: Buffer | undefined;
  try {
    key = await keyStore.get(remap.sourceVaultId);
    if (!key) return 'missing';
    await keyStore.set(remap.developmentVaultId, key);
    return 'copied';
  } catch {
    return 'unavailable';
  } finally {
    key?.fill(0);
  }
}
