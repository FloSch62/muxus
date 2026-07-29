import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, scryptSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import {
  InvalidMasterPasswordError,
  InvalidMasterPasswordFormatError,
  PasswordVault,
  VaultAutomaticAccessError,
  VaultUnlockRequiredError,
  sshPasswordAccount,
} from '../../../server/src/security/password-vault.js';
import {
  MemoryVaultKeyStore,
  type VaultKeyStore,
  VaultKeyStoreUnavailableError,
} from '../../../server/src/security/vault-key-store.js';

const MASTER = 'master-pass-12';
const NEXT_MASTER = 'next-master-12';
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

async function setup(
  filename = ':memory:',
  keyStore = new MemoryVaultKeyStore(),
): Promise<PasswordVault> {
  database = new MuxusDatabase(filename);
  vault = new PasswordVault(database, { kdf: TEST_KDF, keyStore });
  await vault.initialize();
  return vault;
}

function account(): string {
  return sshPasswordAccount({
    user: 'alice',
    host: 'router.example',
    port: 22,
  });
}

class ToggleVaultKeyStore
  extends MemoryVaultKeyStore
  implements VaultKeyStore
{
  unavailable = false;

  override async get(vaultId: string): Promise<Buffer | undefined> {
    this.assertAvailable();
    return super.get(vaultId);
  }

  override async set(vaultId: string, key: Buffer): Promise<void> {
    this.assertAvailable();
    await super.set(vaultId, key);
  }

  override async delete(vaultId: string): Promise<void> {
    this.assertAvailable();
    await super.delete(vaultId);
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new VaultKeyStoreUnavailableError();
  }
}

describe('password vault', () => {
  it('uses the OS-keyring policy while the master password gates management', async () => {
    const store = await setup();

    await store.create(MASTER, 'never');
    await store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );
    expect(store.status()).toMatchObject({
      configured: true,
      unlockPolicy: 'never',
      locked: false,
      credentialCount: 1,
    });
    expect(database!.passwordVaultConfig()!.keyCheck).toHaveLength(32);
    await expect(store.sshPassword(account())).resolves.toBe(REMOTE_PASSWORD);

    const [credential] = store.status().credentials;
    expect(credential).toBeDefined();
    await expect(
      store.revealCredential(credential!.id, 'incorrect-pass'),
    ).rejects.toThrow(InvalidMasterPasswordError);
    await expect(store.revealCredential(credential!.id, MASTER)).resolves.toBe(
      REMOTE_PASSWORD,
    );

    await store.updateCredential(
      credential!.id,
      MASTER,
      'changed-password',
    );
    await store.changeMasterPassword(MASTER, NEXT_MASTER);
    await expect(
      store.revealCredential(credential!.id, MASTER),
    ).rejects.toThrow(InvalidMasterPasswordError);
    await expect(
      store.revealCredential(credential!.id, NEXT_MASTER),
    ).resolves.toBe('changed-password');
  });

  it('implements startup and per-credential prompt policies', async () => {
    const keyStore = new MemoryVaultKeyStore();
    const store = await setup(':memory:', keyStore);
    await store.create(MASTER, 'startup');
    await store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );

    store.lock();
    expect(store.status()).toMatchObject({
      unlockPolicy: 'startup',
      locked: true,
    });
    await expect(store.sshPassword(account())).rejects.toThrow(
      VaultUnlockRequiredError,
    );
    await store.unlockForSession(MASTER);
    await expect(store.sshPassword(account())).resolves.toBe(REMOTE_PASSWORD);

    await store.changeUnlockPolicy(MASTER, 'credential');
    expect(store.status()).toMatchObject({
      unlockPolicy: 'credential',
      locked: true,
    });
    await expect(store.sshPassword(account())).rejects.toThrow(
      VaultUnlockRequiredError,
    );
    await expect(store.sshPassword(account(), MASTER)).resolves.toBe(
      REMOTE_PASSWORD,
    );
    expect(store.status().locked).toBe(true);

    await store.changeUnlockPolicy(MASTER, 'never');
    expect(store.status()).toMatchObject({
      unlockPolicy: 'never',
      locked: false,
    });
  });

  it('unlocks a draft-v13 vault and upgrades it on master-password change', async () => {
    const store = await setup();
    const legacyMaster = 'old-pass';
    const vaultKey = Buffer.alloc(32, 11);
    const salt = Buffer.alloc(16, 12);
    const masterKey = scryptSync(legacyMaster, salt, 32, {
      N: TEST_KDF.cost,
      r: TEST_KDF.blockSize,
      p: TEST_KDF.parallelism,
    });
    const masterWrap = sealForTest(
      vaultKey,
      masterKey,
      Buffer.from('muxus:password-vault:master-key:v2'),
    );
    database!.createPasswordVaultConfig({
      formatVersion: 2,
      vaultId: 'legacy-vault-id-12345',
      unlockPolicy: 'startup',
      kdfAlgorithm: 'scrypt',
      kdfSalt: salt,
      kdfCost: TEST_KDF.cost,
      kdfBlockSize: TEST_KDF.blockSize,
      kdfParallelism: TEST_KDF.parallelism,
      masterKeyNonce: masterWrap.nonce,
      masterKeyCiphertext: masterWrap.ciphertext,
      masterKeyTag: masterWrap.authTag,
    });
    const ref = database!.upsertCredentialRef({
      provider: 'muxus-master-vault',
      service: 'muxus/ssh-password/v1',
      account: account(),
      label: 'legacy credential',
    });
    const encrypted = sealForTest(
      Buffer.from(REMOTE_PASSWORD),
      vaultKey,
      Buffer.from(`muxus:ssh-password:${ref.id}:v1`),
    );
    database!.upsertEncryptedCredential({
      provider: ref.provider,
      service: ref.service,
      account: ref.account,
      label: ref.label,
      formatVersion: 1,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
      authTag: encrypted.authTag,
    });

    await store.unlockForSession(legacyMaster);
    await expect(store.sshPassword(account())).resolves.toBe(REMOTE_PASSWORD);
    await store.changeMasterPassword(legacyMaster, NEXT_MASTER);
    expect(database!.passwordVaultConfig()!.formatVersion).toBe(3);
    store.lock();
    await store.unlockForSession(NEXT_MASTER);
    await expect(store.sshPassword(account())).resolves.toBe(REMOTE_PASSWORD);

    vaultKey.fill(0);
    masterKey.fill(0);
  });

  it('restores never-prompt access after a complete application restart', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-vault-restart-'));
    const file = path.join(dir, 'muxus.sqlite3');
    const keyStore = new MemoryVaultKeyStore();
    try {
      const first = await setup(file, keyStore);
      await first.create(MASTER, 'never');
      await first.rememberSshPassword(
        account(),
        'alice@router.example:22',
        REMOTE_PASSWORD,
      );
      first.dispose();
      database!.close();
      vault = undefined;
      database = undefined;

      const second = await setup(file, keyStore);
      expect(second.status()).toMatchObject({
        unlockPolicy: 'never',
        locked: false,
      });
      await expect(second.sshPassword(account())).resolves.toBe(
        REMOTE_PASSWORD,
      );
      expect(existsSync(path.join(dir, 'muxus-vault-device.key'))).toBe(false);
    } finally {
      vault?.dispose();
      database?.close();
      vault = undefined;
      database = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairs a missing OS-keyring entry with the master password', async () => {
    const keyStore = new MemoryVaultKeyStore();
    const store = await setup(':memory:', keyStore);
    await store.create(MASTER, 'never');
    await store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );
    const vaultId = database!.passwordVaultConfig()!.vaultId;
    store.lock();
    await keyStore.delete(vaultId);

    await expect(store.sshPassword(account())).rejects.toThrow(
      VaultAutomaticAccessError,
    );
    await expect(store.repairAutomaticAccess('incorrect-pass')).rejects.toThrow(
      InvalidMasterPasswordError,
    );
    await store.repairAutomaticAccess(MASTER);
    await expect(store.sshPassword(account())).resolves.toBe(REMOTE_PASSWORD);
  });

  it('uses a successfully unwrapped key when OS caching is unavailable', async () => {
    const keyStore = new ToggleVaultKeyStore();
    const store = await setup(':memory:', keyStore);
    await store.create(MASTER, 'never');
    const vaultId = database!.passwordVaultConfig()!.vaultId;
    await store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );

    store.lock();
    keyStore.unavailable = true;
    await expect(store.sshPassword(account(), MASTER)).resolves.toBe(
      REMOTE_PASSWORD,
    );
    expect(store.status()).toMatchObject({
      unlockPolicy: 'never',
      locked: false,
      osKeyStoreAvailable: false,
    });

    await expect(
      store.changeMasterPassword(MASTER, NEXT_MASTER),
    ).resolves.toBeUndefined();
    store.lock();
    await expect(
      store.changeUnlockPolicy(NEXT_MASTER, 'startup'),
    ).resolves.toBeUndefined();
    expect(store.status()).toMatchObject({
      unlockPolicy: 'startup',
      locked: false,
      osKeyStoreAvailable: false,
    });
    expect(database!.pendingPasswordVaultKeyCleanup()).toEqual([vaultId]);

    store.dispose();
    keyStore.unavailable = false;
    vault = new PasswordVault(database!, { kdf: TEST_KDF, keyStore });
    await vault.initialize();
    expect(database!.pendingPasswordVaultKeyCleanup()).toEqual([]);
    await expect(keyStore.get(vaultId)).resolves.toBeUndefined();
    expect(vault.status()).toMatchObject({
      unlockPolicy: 'startup',
      locked: true,
      osKeyStoreAvailable: true,
    });
  });

  it('resets a never-policy vault even when OS-key deletion fails', async () => {
    const keyStore = new ToggleVaultKeyStore();
    const store = await setup(':memory:', keyStore);
    await store.create(MASTER, 'never');
    await store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );

    keyStore.unavailable = true;
    await expect(store.deleteAll()).resolves.toBeUndefined();
    expect(store.status()).toMatchObject({
      configured: false,
      locked: true,
      credentialCount: 0,
      osKeyStoreAvailable: false,
    });
  });

  it('rejects a stale 32-byte OS key and repairs it with the master password', async () => {
    const keyStore = new MemoryVaultKeyStore();
    const first = await setup(':memory:', keyStore);
    await first.create(MASTER, 'never');
    await first.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );
    const vaultId = database!.passwordVaultConfig()!.vaultId;
    const correctKey = (await keyStore.get(vaultId))!;
    first.dispose();
    await keyStore.set(vaultId, Buffer.alloc(32, 0x5a));

    vault = new PasswordVault(database!, {
      kdf: TEST_KDF,
      keyStore,
    });
    await vault.initialize();
    expect(vault.status()).toMatchObject({
      unlockPolicy: 'never',
      locked: true,
    });
    await expect(vault.sshPassword(account())).rejects.toThrow(
      VaultAutomaticAccessError,
    );
    await expect(vault.sshPassword(account(), MASTER)).resolves.toBe(
      REMOTE_PASSWORD,
    );
    expect(await keyStore.get(vaultId)).toEqual(correctKey);
    correctKey.fill(0);
  });

  it('does not let obsolete-key cleanup failures block initialization', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-vault-cleanup-'));
    const file = path.join(dir, 'muxus.sqlite3');
    try {
      database = new MuxusDatabase(file);
      mkdirSync(path.join(dir, 'muxus-vault-device.key'));
      vault = new PasswordVault(database, {
        kdf: TEST_KDF,
        keyStore: new MemoryVaultKeyStore(),
      });

      await expect(vault.initialize()).resolves.toBeUndefined();
      expect(vault.status().configured).toBe(false);
    } finally {
      vault?.dispose();
      database?.close();
      vault = undefined;
      database = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves KDF failures instead of reporting an incorrect password', async () => {
    const store = await setup();
    database!.createPasswordVaultConfig({
      formatVersion: 3,
      vaultId: 'invalid-kdf-vault',
      unlockPolicy: 'startup',
      kdfAlgorithm: 'scrypt',
      kdfSalt: Buffer.alloc(16),
      kdfCost: 1025,
      kdfBlockSize: 8,
      kdfParallelism: 1,
      masterKeyNonce: Buffer.alloc(12),
      masterKeyCiphertext: Buffer.alloc(32),
      masterKeyTag: Buffer.alloc(16),
    });

    const error = await store.unlockForSession(MASTER).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidMasterPasswordError);
    expect((error as Error).message).toMatch(/scrypt/i);
  });

  it('does not create a key file or leave deleted secrets in SQLite/WAL', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-vault-delete-'));
    const file = path.join(dir, 'muxus.sqlite3');
    const keyStore = new MemoryVaultKeyStore();
    try {
      writeFileSync(
        path.join(dir, 'muxus-vault-device.key'),
        Buffer.alloc(32, 42),
      );
      const store = await setup(file, keyStore);
      expect(readdirSync(dir)).not.toContain('muxus-vault-device.key');
      await store.create(MASTER, 'never');
      await store.rememberSshPassword(
        account(),
        'unique-label-that-must-be-scrubbed',
        REMOTE_PASSWORD,
      );
      const record = database!.listEncryptedCredentials(
        'muxus-master-vault',
        'muxus/ssh-password/v1',
      )[0]!;
      const ciphertext = Buffer.from(record.ciphertext);
      const vaultId = database!.passwordVaultConfig()!.vaultId;

      await store.deleteAll();
      expect(await keyStore.get(vaultId)).toBeUndefined();
      store.dispose();
      database!.close();
      database = undefined;
      vault = undefined;

      const persisted = Buffer.concat(
        readdirSync(dir)
          .filter((name) => name.startsWith('muxus.sqlite3'))
          .map((name) => readFileSync(path.join(dir, name))),
      );
      expect(
        persisted.includes(
          Buffer.from('unique-label-that-must-be-scrubbed'),
        ),
      ).toBe(false);
      expect(persisted.includes(ciphertext)).toBe(false);
      expect(persisted.includes(Buffer.from(MASTER))).toBe(false);
      expect(persisted.includes(Buffer.from(REMOTE_PASSWORD))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forgets individual credentials or resets the whole vault', async () => {
    const store = await setup();
    await store.create(MASTER, 'startup');
    await store.rememberSshPassword(
      account(),
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );
    const [credential] = store.status().credentials;
    expect(credential).toBeDefined();
    expect(store.deleteCredential(credential!.id)).toBe(true);
    expect(store.hasSshPassword(account())).toBe(false);

    await store.deleteAll();
    expect(store.status()).toMatchObject({
      configured: false,
      locked: true,
      credentialCount: 0,
    });
  });

  it('accepts twelve-character master passwords and rejects eleven', async () => {
    const store = await setup();
    await expect(store.create('12345678901')).rejects.toThrow(
      InvalidMasterPasswordFormatError,
    );
    await expect(store.create('123456789012')).resolves.toBeUndefined();
    expect(store.status().unlockPolicy).toBe('never');
  });
});

function sealForTest(plaintext: Buffer, key: Buffer, aad: Buffer) {
  const nonce = Buffer.alloc(12, 13);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}
