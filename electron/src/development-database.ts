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

/** Keep source launches isolated from the profile used by an installed build. */
export function developmentUserDataPath(installedUserDataPath: string): string {
  return `${installedUserDataPath}-development`;
}

/**
 * Refresh the development database from the installed application database.
 * SQLite's backup API is required here: copying the main file directly can
 * omit committed transactions which still live in its WAL file.
 */
export async function seedDevelopmentDatabase(
  installedUserDataPath: string,
  developmentUserDataPath: string,
): Promise<boolean> {
  const sourcePath = path.join(installedUserDataPath, DATABASE_FILENAME);
  if (!existsSync(sourcePath)) return false;

  const destinationPath = path.join(developmentUserDataPath, DATABASE_FILENAME);
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    throw new Error('development database path must differ from the installed database path');
  }

  mkdirSync(developmentUserDataPath, { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(
    path.join(developmentUserDataPath, '.database-seed-'),
  );
  const temporaryDatabase = path.join(temporaryDirectory, DATABASE_FILENAME);
  let source: DatabaseSync | undefined;

  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
    await backup(source, temporaryDatabase);
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
    return true;
  } finally {
    source?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
