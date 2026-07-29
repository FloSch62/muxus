import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import {
  InvalidMasterPasswordError,
  InvalidMasterPasswordFormatError,
  PasswordVault,
  VaultAutomaticAccessError,
  sshPasswordAccount,
} from '../../../server/src/security/password-vault.js';

const MASTER = 'master-8';
const NEXT_MASTER = 'new-pass';
const REMOTE_PASSWORD = 'remote-password-that-must-not-leak';
const TEST_KDF = { cost: 1024, blockSize: 8, parallelism: 1 };

let database: MuxusDatabase | undefined;
let vault: PasswordVault | undefined;

afterEach(() => {
  vault?.dispose();
  database?.close();
  vault = undefined;
  database = undefined;
});

function setup(filename = ':memory:'): PasswordVault {
  database = new MuxusDatabase(filename);
  vault = new PasswordVault(database, { kdf: TEST_KDF });
  return vault;
}

function account(): string {
  return sshPasswordAccount({
    user: 'alice',
    host: 'router.example',
    port: 22,
  });
}

describe('automatic password vault', () => {
  it('uses passwords automatically while the master password gates reveal and edit', async () => {
    const store = setup();

    await store.create(MASTER);
    store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );
    expect(store.status()).toMatchObject({
      configured: true,
      automaticAccess: true,
      credentialCount: 1,
    });

    store.lock();
    expect(store.sshPassword(account())).toBe(REMOTE_PASSWORD);

    const [credential] = store.status().credentials;
    expect(credential).toBeDefined();
    await expect(
      store.revealCredential(credential!.id, 'incorrect'),
    ).rejects.toThrow(InvalidMasterPasswordError);
    await expect(store.revealCredential(credential!.id, MASTER)).resolves.toBe(
      REMOTE_PASSWORD,
    );

    await expect(
      store.updateCredential(credential!.id, 'incorrect', 'changed-password'),
    ).rejects.toThrow(InvalidMasterPasswordError);
    await expect(
      store.updateCredential(credential!.id, MASTER, 'changed-password'),
    ).resolves.toBe(true);
    expect(store.sshPassword(account())).toBe('changed-password');

    await store.changeMasterPassword(MASTER, NEXT_MASTER);
    await expect(
      store.revealCredential(credential!.id, MASTER),
    ).rejects.toThrow(InvalidMasterPasswordError);
    await expect(
      store.revealCredential(credential!.id, NEXT_MASTER),
    ).resolves.toBe('changed-password');
    expect(store.sshPassword(account())).toBe('changed-password');
  });

  it('restores automatic access after a complete application restart', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-vault-restart-'));
    const file = path.join(dir, 'muxus.sqlite3');
    try {
      const first = setup(file);
      await first.create(MASTER);
      first.rememberSshPassword(
        account(),
        'alice@router.example:22',
        REMOTE_PASSWORD,
      );
      first.dispose();
      database!.close();
      vault = undefined;
      database = undefined;

      database = new MuxusDatabase(file);
      vault = new PasswordVault(database, { kdf: TEST_KDF });
      expect(vault.status().automaticAccess).toBe(true);
      expect(vault.sshPassword(account())).toBe(REMOTE_PASSWORD);
      if (process.platform !== 'win32') {
        expect(
          statSync(path.join(dir, 'muxus-vault-device.key')).mode & 0o777,
        ).toBe(0o600);
      }
    } finally {
      vault?.dispose();
      database?.close();
      vault = undefined;
      database = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairs automatic access with the master password if the device key is lost', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-vault-repair-'));
    const file = path.join(dir, 'muxus.sqlite3');
    try {
      const first = setup(file);
      await first.create(MASTER);
      first.rememberSshPassword(
        account(),
        'alice@router.example:22',
        REMOTE_PASSWORD,
      );
      first.dispose();
      database!.close();
      vault = undefined;
      database = undefined;
      rmSync(path.join(dir, 'muxus-vault-device.key'));

      database = new MuxusDatabase(file);
      vault = new PasswordVault(database, { kdf: TEST_KDF });
      expect(vault.status().automaticAccess).toBe(false);
      expect(() => vault!.sshPassword(account())).toThrow(
        VaultAutomaticAccessError,
      );
      await expect(
        vault.repairAutomaticAccess('incorrect'),
      ).rejects.toThrow(InvalidMasterPasswordError);
      await vault.repairAutomaticAccess(MASTER);
      expect(vault.sshPassword(account())).toBe(REMOTE_PASSWORD);
    } finally {
      vault?.dispose();
      database?.close();
      vault = undefined;
      database = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never writes the master or remote password in the database', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-vault-plaintext-'));
    const file = path.join(dir, 'muxus.sqlite3');
    try {
      const store = setup(file);
      await store.create(MASTER);
      store.rememberSshPassword(
        account(),
        'alice@router.example:22',
        REMOTE_PASSWORD,
      );
      store.dispose();
      database!.close();
      database = undefined;
      vault = undefined;

      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(MASTER))).toBe(false);
      expect(bytes.includes(Buffer.from(REMOTE_PASSWORD))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forgets individual credentials or resets the whole vault', async () => {
    const store = setup();
    await store.create(MASTER);
    store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );
    const [credential] = store.status().credentials;
    expect(credential).toBeDefined();
    expect(store.deleteCredential(credential!.id)).toBe(true);
    expect(store.hasSshPassword(account())).toBe(false);

    store.deleteAll();
    expect(store.status()).toMatchObject({
      configured: false,
      automaticAccess: false,
      credentialCount: 0,
    });
  });

  it('accepts eight-character master passwords and rejects seven', async () => {
    const store = setup();
    await expect(store.create('1234567')).rejects.toThrow(
      InvalidMasterPasswordFormatError,
    );
    await expect(store.create('12345678')).resolves.toBeUndefined();
  });
});
