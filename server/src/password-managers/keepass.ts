import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { argon2d, argon2id } from 'hash-wasm';
import * as kdbxwebModule from 'kdbxweb';
import type { PasswordManagerConfig, PasswordManagerEntry } from '@muxus/shared';
import {
  PasswordManagerError,
  sortEntries,
  type PasswordManagerProvider,
  type ProviderStatus,
} from './provider.js';

// kdbxweb ships one CommonJS bundle; under ESM its exports sit on `default`.
const kdbxweb: typeof kdbxwebModule =
  (kdbxwebModule as unknown as { default?: typeof kdbxwebModule }).default ?? kdbxwebModule;

type Kdbx = kdbxwebModule.Kdbx;
type KdbxEntry = kdbxwebModule.KdbxEntry;
type KdbxGroup = kdbxwebModule.KdbxGroup;

// KDBX 4 derives its key with Argon2, which kdbxweb leaves to its host. The
// WebAssembly build runs the same in Node and in Electron, whose BoringSSL has
// no Argon2 of its own.
kdbxweb.CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type) => {
    const hash = await (type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d)({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      hashLength: length,
      parallelism,
      outputType: 'binary',
    });
    return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
  },
);

interface OpenDatabase {
  db: Kdbx;
  credentials: kdbxwebModule.KdbxCredentials;
  /** The file as it was when read, to notice a save from KeePass. */
  mtimeMs: number;
  size: number;
}

/**
 * Reads a KeePass database file directly, so it works with KeePass, KeePassXC
 * and every other program that writes .kdbx, whether or not one is running.
 * The database is opened with its own password (and key file) and kept open
 * in memory until it is locked or Muxus quits; nothing is ever written back.
 */
export class KeePassProvider implements PasswordManagerProvider {
  readonly kind = 'keepass';
  private open: OpenDatabase | undefined;
  private readonly file: string;
  private readonly keyFile: string | undefined;

  constructor(config: PasswordManagerConfig) {
    this.file = expandHome(config.path?.trim() ?? '');
    this.keyFile = config.keyFile?.trim() ? expandHome(config.keyFile.trim()) : undefined;
  }

  async status(): Promise<ProviderStatus> {
    if (!this.file) return { state: 'unavailable', message: 'No database file is set.' };
    try {
      await stat(this.file);
    } catch {
      return { state: 'unavailable', message: `The database ${this.file} was not found.` };
    }
    return this.open
      ? { state: 'ready' }
      : { state: 'locked', message: 'Enter the database password to unlock it.' };
  }

  async unlock(password: string): Promise<void> {
    let keyFile: ArrayBuffer | undefined;
    if (this.keyFile) {
      try {
        keyFile = toArrayBuffer(await readFile(this.keyFile));
      } catch {
        throw new PasswordManagerError('unavailable', `The key file ${this.keyFile} could not be read.`);
      }
    }
    // A database protected by a key file alone has no password component.
    const credentials = new kdbxweb.Credentials(
      password === '' && keyFile ? null : kdbxweb.ProtectedValue.fromString(password),
      keyFile ?? null,
    );
    this.open = await this.load(credentials);
  }

  lock(): Promise<void> {
    this.open = undefined;
    return Promise.resolve();
  }

  dispose(): void {
    this.open = undefined;
  }

  async entries(): Promise<PasswordManagerEntry[]> {
    const db = await this.database();
    const entries: PasswordManagerEntry[] = [];
    for (const entry of liveEntries(db)) {
      // An entry without a password has nothing to log in with.
      if (!fieldText(entry, 'Password')) continue;
      const username = resolvedField(db, entry, 'UserName');
      const url = fieldText(entry, 'URL');
      const group = groupPath(db, entry.parentGroup);
      entries.push({
        id: entry.uuid.id,
        title: fieldText(entry, 'Title') || username || url || 'Untitled entry',
        ...(username ? { username } : {}),
        ...(url ? { url } : {}),
        ...(group ? { group } : {}),
      });
    }
    return sortEntries(entries);
  }

  async password(entryId: string): Promise<string> {
    const db = await this.database();
    const entry = liveEntries(db).find((candidate) => candidate.uuid.id === entryId);
    if (!entry) {
      throw new PasswordManagerError('entry-missing', 'The entry is no longer in the KeePass database.');
    }
    return resolvedField(db, entry, 'Password');
  }

  /** The open database, read again when KeePass has saved the file since. */
  private async database(): Promise<Kdbx> {
    const open = this.open;
    if (!open) {
      throw new PasswordManagerError('locked', 'The KeePass database is locked.');
    }
    let info;
    try {
      info = await stat(this.file);
    } catch {
      throw new PasswordManagerError('unavailable', `The database ${this.file} was not found.`);
    }
    if (info.mtimeMs === open.mtimeMs && info.size === open.size) return open.db;
    try {
      this.open = await this.load(open.credentials);
    } catch (err) {
      // Its password was changed in KeePass: the remembered one no longer opens it.
      if (err instanceof PasswordManagerError && err.problem === 'invalid-unlock') {
        this.open = undefined;
        throw new PasswordManagerError('locked', 'The KeePass database password has changed.');
      }
      throw err;
    }
    return this.open.db;
  }

  private async load(credentials: kdbxwebModule.KdbxCredentials): Promise<OpenDatabase> {
    let data: Buffer;
    let info;
    try {
      info = await stat(this.file);
      data = await readFile(this.file);
    } catch {
      throw new PasswordManagerError('unavailable', `The database ${this.file} could not be read.`);
    }
    try {
      const db = await kdbxweb.Kdbx.load(toArrayBuffer(data), credentials);
      return { db, credentials, mtimeMs: info.mtimeMs, size: info.size };
    } catch (err) {
      const code = err instanceof kdbxweb.KdbxError ? err.code : undefined;
      if (code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
        throw new PasswordManagerError(
          'invalid-unlock',
          this.keyFile
            ? 'The database password or key file is wrong.'
            : 'The database password is wrong.',
        );
      }
      if (code === kdbxweb.Consts.ErrorCodes.BadSignature) {
        throw new PasswordManagerError('failed', `${path.basename(this.file)} is not a KeePass database.`);
      }
      if (code === kdbxweb.Consts.ErrorCodes.InvalidVersion || code === kdbxweb.Consts.ErrorCodes.Unsupported) {
        throw new PasswordManagerError(
          'failed',
          `${path.basename(this.file)} uses a database format or cipher Muxus cannot read.`,
        );
      }
      throw new PasswordManagerError('failed', `${path.basename(this.file)} could not be opened.`);
    }
  }
}

/** Every entry outside the recycle bin. */
function liveEntries(db: Kdbx): KdbxEntry[] {
  const bin = db.meta.recycleBinEnabled ? db.meta.recycleBinUuid : undefined;
  const entries: KdbxEntry[] = [];
  const walk = (group: KdbxGroup): void => {
    if (bin && group.uuid.equals(bin)) return;
    entries.push(...group.entries);
    for (const child of group.groups) walk(child);
  };
  for (const group of db.groups) walk(group);
  return entries;
}

function fieldText(entry: KdbxEntry, name: string): string {
  const value = entry.fields.get(name);
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.getText();
}

/**
 * A field's value with KeePass field references followed: `{REF:P@I:<uuid>}`
 * stands for the password, and `{REF:U@I:<uuid>}` for the user name, of the
 * entry with that UUID. Other placeholders are left as written.
 */
function resolvedField(db: Kdbx, entry: KdbxEntry, name: string, depth = 0): string {
  const text = fieldText(entry, name);
  if (depth > 4) return text;
  return text.replace(/\{REF:([PU])@I:([0-9A-Fa-f]{32})\}/g, (whole, field: string, hex: string) => {
    const id = Buffer.from(hex, 'hex').toString('base64');
    const target = liveEntries(db).find((candidate) => candidate.uuid.id === id);
    return target
      ? resolvedField(db, target, field.toUpperCase() === 'P' ? 'Password' : 'UserName', depth + 1)
      : whole;
  });
}

/** "Servers / Lab", leaving out the database's root group. */
function groupPath(db: Kdbx, group: KdbxGroup | undefined): string {
  const names: string[] = [];
  const root = db.getDefaultGroup();
  for (let current = group; current && current !== root; current = current.parentGroup) {
    if (current.name) names.unshift(current.name);
  }
  return names.join(' / ');
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export function expandHome(file: string): string {
  if (file === '~') return os.homedir();
  return file.startsWith('~/') || file.startsWith('~\\') ? path.join(os.homedir(), file.slice(2)) : file;
}
