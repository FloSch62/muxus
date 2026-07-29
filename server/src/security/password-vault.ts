import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto';
import { open as openFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
  type PasswordVaultCredential,
  type PasswordVaultStatus,
  type PasswordVaultUnlockPolicy,
} from '@muxus/shared';
import type {
  EncryptedCredentialRecord,
  MuxusDatabase,
  PasswordVaultConfigRecord,
} from '../persistence/database.js';
import {
  MemoryVaultKeyStore,
  SystemVaultKeyStore,
  type VaultKeyStore,
  VaultKeyStoreUnavailableError,
} from './vault-key-store.js';

export const PASSWORD_VAULT_PROVIDER = 'muxus-master-vault';
export const SSH_PASSWORD_SERVICE = 'muxus/ssh-password/v1';
export const MASTER_PASSWORD_MIN_LENGTH = 12;
export const MASTER_PASSWORD_MAX_BYTES = 1024;
export const SSH_PASSWORD_MAX_BYTES = 8192;

const FORMAT_VERSION = 3 as const;
const CREDENTIAL_FORMAT_VERSION = 1 as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const LEGACY_MASTER_PASSWORD_MIN_LENGTH = 8;
const LEGACY_DEVICE_KEY_FILENAME = 'muxus-vault-device.key';
const LEGACY_MASTER_KEY_AAD = Buffer.from(
  'muxus:password-vault:master-key:v2',
  'utf8',
);
const MASTER_KEY_AAD = Buffer.from(
  'muxus:password-vault:master-key:v3',
  'utf8',
);

export interface PasswordVaultKdf {
  cost: number;
  blockSize: number;
  parallelism: number;
}

const DEFAULT_KDF: PasswordVaultKdf = {
  cost: 128 * 1024,
  blockSize: 8,
  parallelism: 1,
};

interface SealedValue {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

interface CredentialKey {
  key: Buffer;
  ephemeral: boolean;
}

export class VaultNotConfiguredError extends Error {
  constructor() {
    super('Password vault is not configured.');
  }
}

export class VaultAlreadyConfiguredError extends Error {
  constructor() {
    super('Password vault is already configured.');
  }
}

export class VaultPolicyMismatchError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class VaultUnlockRequiredError extends Error {
  constructor(readonly policy: PasswordVaultUnlockPolicy) {
    super('Enter the master password to unlock the saved credential.');
  }
}

/** Kept as an alias for callers that still distinguish automatic access. */
export class VaultAutomaticAccessError extends VaultUnlockRequiredError {
  constructor() {
    super('never');
    this.message =
      'The OS credential-store copy is unavailable. Enter the master password to restore it.';
  }
}

export class InvalidMasterPasswordError extends Error {
  constructor() {
    super('The master password is incorrect.');
  }
}

export class InvalidMasterPasswordFormatError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidSavedPasswordFormatError extends Error {
  constructor() {
    super('The SSH password is too long to save.');
  }
}

export class CredentialVaultCorruptError extends Error {
  constructor() {
    super('A saved password could not be decrypted.');
  }
}

/**
 * A random data key encrypts each saved SSH password with AES-256-GCM. The
 * database contains only a master-password-wrapped copy. With the "never"
 * policy, the raw data key is additionally stored in the native OS credential
 * store. Other policies keep it only in process memory or derive it for one
 * operation.
 */
export class PasswordVault {
  private key: Buffer | undefined;
  private osKeyStoreAvailable = true;
  private initialized = false;
  private readonly keyStore: VaultKeyStore;

  constructor(
    private readonly database: MuxusDatabase,
    private readonly options: {
      kdf?: PasswordVaultKdf;
      keyStore?: VaultKeyStore;
    } = {},
  ) {
    this.keyStore =
      options.keyStore ??
      (database.filename === ':memory:'
        ? new MemoryVaultKeyStore()
        : new SystemVaultKeyStore());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await removeLegacyDeviceKey(this.database.filename);
    const config = this.database.passwordVaultConfig();
    if (!config || config.unlockPolicy !== 'never') return;
    try {
      const key = await this.keyStore.get(config.vaultId);
      if (key) {
        this.setKey(key);
        key.fill(0);
      }
    } catch (err) {
      if (!(err instanceof VaultKeyStoreUnavailableError)) throw err;
      this.osKeyStoreAvailable = false;
    }
  }

  status(): PasswordVaultStatus {
    const config = this.database.passwordVaultConfig();
    const credentials = this.database
      .listEncryptedCredentials(PASSWORD_VAULT_PROVIDER, SSH_PASSWORD_SERVICE)
      .map(
        (record): PasswordVaultCredential => ({
          id: record.id,
          label: record.label ?? 'Saved SSH password',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }),
      );
    return {
      configured: config !== undefined,
      ...(config ? { unlockPolicy: config.unlockPolicy } : {}),
      locked: this.key === undefined,
      osKeyStoreAvailable: this.osKeyStoreAvailable,
      credentialCount: credentials.length,
      credentials,
    };
  }

  async create(
    masterPassword: string,
    unlockPolicy: PasswordVaultUnlockPolicy =
      DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
  ): Promise<void> {
    validateMasterPassword(masterPassword);
    if (this.database.passwordVaultConfig()) {
      throw new VaultAlreadyConfiguredError();
    }

    const vaultKey = randomBytes(KEY_BYTES);
    const vaultId = randomBytes(16).toString('base64url');
    const salt = randomBytes(SALT_BYTES);
    let masterKey: Buffer | undefined;
    let osKeyStored = false;
    try {
      const kdf = this.options.kdf ?? DEFAULT_KDF;
      masterKey = await deriveKey(masterPassword, salt, kdf);
      const masterWrapped = seal(vaultKey, masterKey, MASTER_KEY_AAD);
      if (unlockPolicy === 'never') {
        await this.storeOsKey(vaultId, vaultKey);
        osKeyStored = true;
      }
      this.database.createPasswordVaultConfig({
        formatVersion: FORMAT_VERSION,
        vaultId,
        unlockPolicy,
        kdfAlgorithm: 'scrypt',
        kdfSalt: salt,
        kdfCost: kdf.cost,
        kdfBlockSize: kdf.blockSize,
        kdfParallelism: kdf.parallelism,
        masterKeyNonce: masterWrapped.nonce,
        masterKeyCiphertext: masterWrapped.ciphertext,
        masterKeyTag: masterWrapped.authTag,
      });
      if (unlockPolicy !== 'credential') this.setKey(vaultKey);
    } catch (err) {
      if (osKeyStored) {
        await this.keyStore.delete(vaultId).catch(() => undefined);
      }
      throw err;
    } finally {
      vaultKey.fill(0);
      masterKey?.fill(0);
    }
  }

  async unlockForSession(masterPassword: string): Promise<void> {
    const config = this.requireConfig();
    if (config.unlockPolicy !== 'startup') {
      throw new VaultPolicyMismatchError(
        'Session unlock is available only with the startup prompt policy.',
      );
    }
    const vaultKey = await unwrapMasterKey(masterPassword, config);
    try {
      this.setKey(vaultKey);
    } finally {
      vaultKey.fill(0);
    }
  }

  /**
   * Restores "never prompt" access after a database or OS-keyring restore.
   */
  async repairAutomaticAccess(masterPassword: string): Promise<void> {
    const config = this.requireConfig();
    const vaultKey = await unwrapMasterKey(masterPassword, config);
    try {
      await this.storeOsKey(config.vaultId, vaultKey);
      try {
        this.database.updatePasswordVaultConfig({
          ...config,
          unlockPolicy: 'never',
        });
      } catch (err) {
        await this.keyStore.delete(config.vaultId).catch(() => undefined);
        throw err;
      }
      this.setKey(vaultKey);
    } finally {
      vaultKey.fill(0);
    }
  }

  async changeUnlockPolicy(
    masterPassword: string,
    unlockPolicy: PasswordVaultUnlockPolicy,
  ): Promise<void> {
    const config = this.requireConfig();
    const vaultKey = await unwrapMasterKey(masterPassword, config);
    try {
      if (unlockPolicy === 'never') {
        await this.storeOsKey(config.vaultId, vaultKey);
        try {
          this.database.updatePasswordVaultConfig({
            ...config,
            unlockPolicy,
          });
        } catch (err) {
          await this.keyStore.delete(config.vaultId).catch(() => undefined);
          throw err;
        }
        this.setKey(vaultKey);
        return;
      }

      if (config.unlockPolicy === 'never') {
        await this.keyStore.delete(config.vaultId);
      }
      this.database.updatePasswordVaultConfig({
        ...config,
        unlockPolicy,
      });
      if (unlockPolicy === 'startup') this.setKey(vaultKey);
      else this.lock();
    } finally {
      vaultKey.fill(0);
    }
  }

  lock(): void {
    this.key?.fill(0);
    this.key = undefined;
  }

  dispose(): void {
    this.lock();
  }

  async changeMasterPassword(
    currentPassword: string,
    nextPassword: string,
  ): Promise<void> {
    validateMasterPassword(nextPassword);
    const config = this.requireConfig();
    const vaultKey = await unwrapMasterKey(currentPassword, config);
    const nextSalt = randomBytes(SALT_BYTES);
    let nextMasterKey: Buffer | undefined;
    try {
      const kdf = this.options.kdf ?? DEFAULT_KDF;
      nextMasterKey = await deriveKey(nextPassword, nextSalt, kdf);
      const masterWrapped = seal(vaultKey, nextMasterKey, MASTER_KEY_AAD);
      if (config.unlockPolicy === 'never') {
        await this.storeOsKey(config.vaultId, vaultKey);
      }
      this.database.updatePasswordVaultConfig({
        ...config,
        formatVersion: FORMAT_VERSION,
        kdfAlgorithm: 'scrypt',
        kdfSalt: nextSalt,
        kdfCost: kdf.cost,
        kdfBlockSize: kdf.blockSize,
        kdfParallelism: kdf.parallelism,
        masterKeyNonce: masterWrapped.nonce,
        masterKeyCiphertext: masterWrapped.ciphertext,
        masterKeyTag: masterWrapped.authTag,
      });
      if (config.unlockPolicy !== 'credential') this.setKey(vaultKey);
    } finally {
      vaultKey.fill(0);
      nextMasterKey?.fill(0);
    }
  }

  hasSshPassword(account: string): boolean {
    return (
      this.database.encryptedCredential(
        PASSWORD_VAULT_PROVIDER,
        SSH_PASSWORD_SERVICE,
        account,
      ) !== undefined
    );
  }

  async sshPassword(
    account: string,
    masterPassword?: string,
  ): Promise<string | undefined> {
    const record = this.database.encryptedCredential(
      PASSWORD_VAULT_PROVIDER,
      SSH_PASSWORD_SERVICE,
      account,
    );
    if (!record) return undefined;
    const access = await this.credentialKey(masterPassword);
    try {
      return this.decryptRecord(record, access.key);
    } finally {
      if (access.ephemeral) access.key.fill(0);
    }
  }

  async rememberSshPassword(
    account: string,
    label: string,
    password: string,
    masterPassword?: string,
  ): Promise<void> {
    validateSavedPassword(password);
    const access = await this.credentialKey(masterPassword);
    const ref = this.database.upsertCredentialRef({
      provider: PASSWORD_VAULT_PROVIDER,
      service: SSH_PASSWORD_SERVICE,
      account,
      label,
    });
    const plaintext = Buffer.from(password, 'utf8');
    try {
      const encrypted = seal(
        plaintext,
        access.key,
        credentialAad(ref.id),
      );
      this.database.upsertEncryptedCredential({
        provider: PASSWORD_VAULT_PROVIDER,
        service: SSH_PASSWORD_SERVICE,
        account,
        label,
        formatVersion: CREDENTIAL_FORMAT_VERSION,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
      });
    } finally {
      plaintext.fill(0);
      if (access.ephemeral) access.key.fill(0);
    }
  }

  async revealCredential(
    id: string,
    masterPassword: string,
  ): Promise<string | undefined> {
    const record = this.database.encryptedCredentialById(
      id,
      PASSWORD_VAULT_PROVIDER,
    );
    if (!record) return undefined;
    const managementKey = await unwrapMasterKey(
      masterPassword,
      this.requireConfig(),
    );
    try {
      return this.decryptRecord(record, managementKey);
    } finally {
      managementKey.fill(0);
    }
  }

  async updateCredential(
    id: string,
    masterPassword: string,
    password: string,
  ): Promise<boolean> {
    validateSavedPassword(password);
    const record = this.database.encryptedCredentialById(
      id,
      PASSWORD_VAULT_PROVIDER,
    );
    if (!record) return false;
    const managementKey = await unwrapMasterKey(
      masterPassword,
      this.requireConfig(),
    );
    const plaintext = Buffer.from(password, 'utf8');
    try {
      const encrypted = seal(
        plaintext,
        managementKey,
        credentialAad(record.id),
      );
      this.database.upsertEncryptedCredential({
        provider: record.provider,
        service: record.service,
        account: record.account,
        label: record.label,
        formatVersion: CREDENTIAL_FORMAT_VERSION,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
      });
      return true;
    } finally {
      plaintext.fill(0);
      managementKey.fill(0);
    }
  }

  deleteCredential(id: string): boolean {
    return this.database.deleteEncryptedCredential(
      id,
      PASSWORD_VAULT_PROVIDER,
    );
  }

  async deleteAll(): Promise<void> {
    const config = this.database.passwordVaultConfig();
    if (config?.unlockPolicy === 'never') {
      await this.keyStore.delete(config.vaultId);
    }
    this.lock();
    this.database.deletePasswordVaultData(PASSWORD_VAULT_PROVIDER);
  }

  private requireConfig(): PasswordVaultConfigRecord {
    const config = this.database.passwordVaultConfig();
    if (!config) throw new VaultNotConfiguredError();
    return config;
  }

  private async credentialKey(
    masterPassword?: string,
  ): Promise<CredentialKey> {
    const config = this.requireConfig();
    if (this.key) return { key: this.key, ephemeral: false };
    if (masterPassword === undefined) {
      if (config.unlockPolicy === 'never') {
        throw new VaultAutomaticAccessError();
      }
      throw new VaultUnlockRequiredError(config.unlockPolicy);
    }

    const vaultKey = await unwrapMasterKey(masterPassword, config);
    if (config.unlockPolicy === 'credential') {
      return { key: vaultKey, ephemeral: true };
    }
    if (config.unlockPolicy === 'never') {
      try {
        await this.storeOsKey(config.vaultId, vaultKey);
      } catch (err) {
        vaultKey.fill(0);
        throw err;
      }
    }
    this.setKey(vaultKey);
    vaultKey.fill(0);
    return { key: this.key!, ephemeral: false };
  }

  private decryptRecord(
    record: EncryptedCredentialRecord,
    key: Buffer,
  ): string {
    let plaintext: Buffer;
    try {
      plaintext = open(
        {
          nonce: record.nonce,
          ciphertext: record.ciphertext,
          authTag: record.authTag,
        },
        key,
        credentialAad(record.id),
      );
    } catch {
      throw new CredentialVaultCorruptError();
    }
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  }

  private setKey(key: Buffer): void {
    this.key?.fill(0);
    this.key = Buffer.from(key);
  }

  private async storeOsKey(vaultId: string, key: Buffer): Promise<void> {
    try {
      await this.keyStore.set(vaultId, key);
      this.osKeyStoreAvailable = true;
    } catch (err) {
      this.osKeyStoreAvailable = false;
      throw err;
    }
  }
}

export function sshPasswordAccount(input: {
  user: string;
  host: string;
  port: number;
}): string {
  return Buffer.from(
    JSON.stringify([input.user, input.host.toLowerCase(), input.port]),
    'utf8',
  ).toString('base64url');
}

export function sshPasswordLabel(input: {
  user: string;
  host: string;
  port: number;
}): string {
  return `${input.user}@${input.host}:${input.port}`;
}

export function validateMasterPassword(password: string): void {
  validateMasterPasswordLength(password, MASTER_PASSWORD_MIN_LENGTH);
}

function validateMasterPasswordLength(
  password: string,
  minimumLength: number,
): void {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (Array.from(password).length < minimumLength) {
    throw new InvalidMasterPasswordFormatError(
      `Master password must contain at least ${minimumLength} characters.`,
    );
  }
  if (bytes > MASTER_PASSWORD_MAX_BYTES) {
    throw new InvalidMasterPasswordFormatError('Master password is too long.');
  }
}

function validateSavedPassword(password: string): void {
  if (Buffer.byteLength(password, 'utf8') > SSH_PASSWORD_MAX_BYTES) {
    throw new InvalidSavedPasswordFormatError();
  }
}

function credentialAad(id: string): Buffer {
  return Buffer.from(`muxus:ssh-password:${id}:v1`, 'utf8');
}

function seal(plaintext: Buffer, key: Buffer, aad: Buffer): SealedValue {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function open(value: SealedValue, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, value.nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([
    decipher.update(value.ciphertext),
    decipher.final(),
  ]);
}

function deriveKey(
  password: string,
  salt: Buffer,
  kdf: PasswordVaultKdf,
): Promise<Buffer> {
  const message = Buffer.from(password, 'utf8');
  const requiredMemory = 128 * kdf.cost * kdf.blockSize;
  const maxmem = Math.max(
    32 * 1024 * 1024,
    requiredMemory + 8 * 1024 * 1024,
  );
  return new Promise((resolve, reject) => {
    scrypt(
      message,
      salt,
      KEY_BYTES,
      {
        N: kdf.cost,
        r: kdf.blockSize,
        p: kdf.parallelism,
        maxmem,
      },
      (err, key) => {
        message.fill(0);
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

async function unwrapMasterKey(
  masterPassword: string,
  config: PasswordVaultConfigRecord,
): Promise<Buffer> {
  validateMasterPasswordLength(
    masterPassword,
    config.formatVersion === 2
      ? LEGACY_MASTER_PASSWORD_MIN_LENGTH
      : MASTER_PASSWORD_MIN_LENGTH,
  );
  let masterKey: Buffer | undefined;
  try {
    masterKey = await deriveKey(masterPassword, config.kdfSalt, {
      cost: config.kdfCost,
      blockSize: config.kdfBlockSize,
      parallelism: config.kdfParallelism,
    });
    const key = open(
      {
        nonce: config.masterKeyNonce,
        ciphertext: config.masterKeyCiphertext,
        authTag: config.masterKeyTag,
      },
      masterKey,
      config.formatVersion === 2 ? LEGACY_MASTER_KEY_AAD : MASTER_KEY_AAD,
    );
    if (key.length !== KEY_BYTES) {
      key.fill(0);
      throw new InvalidMasterPasswordError();
    }
    return key;
  } catch (err) {
    if (err instanceof InvalidMasterPasswordFormatError) throw err;
    throw new InvalidMasterPasswordError();
  } finally {
    masterKey?.fill(0);
  }
}

async function removeLegacyDeviceKey(databaseFilename: string): Promise<void> {
  if (databaseFilename === ':memory:') return;
  const filename = path.join(
    path.dirname(databaseFilename),
    LEGACY_DEVICE_KEY_FILENAME,
  );
  let handle;
  try {
    handle = await openFile(filename, 'r+');
    const replacement = Buffer.alloc(KEY_BYTES);
    try {
      await handle.write(replacement, 0, replacement.length, 0);
      await handle.truncate(0);
      await handle.sync();
    } finally {
      replacement.fill(0);
      await handle.close();
      handle = undefined;
    }
    await unlink(filename);
  } catch (err) {
    if (isMissingFileError(err)) return;
    try {
      await handle?.close();
    } catch {
      // Preserve the original cleanup failure.
    }
    throw new Error(
      'Muxus could not remove the obsolete on-disk password-vault key.',
      { cause: err },
    );
  }
}

function isMissingFileError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
