import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto';
import type {
  PasswordVaultCredential,
  PasswordVaultStatus,
} from '@muxus/shared';
import type {
  EncryptedCredentialRecord,
  MuxusDatabase,
  PasswordVaultConfigRecord,
} from '../persistence/database.js';

export const PASSWORD_VAULT_PROVIDER = 'muxus-master-vault';
export const SSH_PASSWORD_SERVICE = 'muxus/ssh-password/v1';
export const MASTER_PASSWORD_MIN_LENGTH = 8;
export const MASTER_PASSWORD_MAX_BYTES = 1024;
export const SSH_PASSWORD_MAX_BYTES = 8192;

const FORMAT_VERSION = 2 as const;
const CREDENTIAL_FORMAT_VERSION = 1 as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEVICE_KEY_FILENAME = 'muxus-vault-device.key';
const MASTER_KEY_AAD = Buffer.from(
  'muxus:password-vault:master-key:v2',
  'utf8',
);
const DEVICE_KEY_AAD = Buffer.from(
  'muxus:password-vault:device-key:v2',
  'utf8',
);

export interface PasswordVaultKdf {
  cost: number;
  blockSize: number;
  parallelism: number;
}

const DEFAULT_KDF: PasswordVaultKdf = {
  cost: 32 * 1024,
  blockSize: 8,
  parallelism: 1,
};

interface SealedValue {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
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

export class VaultAutomaticAccessError extends Error {
  constructor() {
    super(
      'Automatic password access is unavailable. Enter the master password in Settings to repair it.',
    );
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
 * Platform-independent encrypted credential vault.
 *
 * A random data key encrypts every SSH password. It is wrapped twice:
 * - with a local device key so SSH connections can use it automatically;
 * - with a scrypt-derived master key so revealing or editing credentials
 *   requires the master password.
 *
 * The device key is a mode-0600 file next to the database. This protects a
 * copied database by itself, but not theft of the complete application-data
 * directory. The master password is deliberately a management gate rather
 * than a requirement for routine SSH connections.
 */
export class PasswordVault {
  private key: Buffer | undefined;
  private readonly deviceKey: Buffer;

  constructor(
    private readonly database: MuxusDatabase,
    private readonly options: {
      kdf?: PasswordVaultKdf;
      deviceKey?: Buffer;
      deviceKeyPath?: string;
    } = {},
  ) {
    this.deviceKey = options.deviceKey
      ? checkedDeviceKey(options.deviceKey)
      : loadOrCreateDeviceKey(
          options.deviceKeyPath ?? defaultDeviceKeyPath(database.filename),
        );
    this.restoreAutomaticAccess();
  }

  status(): PasswordVaultStatus {
    this.restoreAutomaticAccess();
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
      configured: this.database.passwordVaultConfig() !== undefined,
      automaticAccess: this.key !== undefined,
      credentialCount: credentials.length,
      credentials,
    };
  }

  async create(masterPassword: string): Promise<void> {
    validateMasterPassword(masterPassword);
    if (this.database.passwordVaultConfig()) {
      throw new VaultAlreadyConfiguredError();
    }

    const vaultKey = randomBytes(KEY_BYTES);
    const salt = randomBytes(SALT_BYTES);
    let masterKey: Buffer | undefined;
    try {
      const kdf = this.options.kdf ?? DEFAULT_KDF;
      masterKey = await deriveKey(masterPassword, salt, kdf);
      const masterWrapped = seal(vaultKey, masterKey, MASTER_KEY_AAD);
      const deviceWrapped = seal(vaultKey, this.deviceKey, DEVICE_KEY_AAD);
      this.database.createPasswordVaultConfig({
        formatVersion: FORMAT_VERSION,
        kdfAlgorithm: 'scrypt',
        kdfSalt: salt,
        kdfCost: kdf.cost,
        kdfBlockSize: kdf.blockSize,
        kdfParallelism: kdf.parallelism,
        masterKeyNonce: masterWrapped.nonce,
        masterKeyCiphertext: masterWrapped.ciphertext,
        masterKeyTag: masterWrapped.authTag,
        deviceKeyNonce: deviceWrapped.nonce,
        deviceKeyCiphertext: deviceWrapped.ciphertext,
        deviceKeyTag: deviceWrapped.authTag,
      });
      this.setKey(vaultKey);
    } catch (err) {
      vaultKey.fill(0);
      throw err;
    } finally {
      masterKey?.fill(0);
    }
  }

  /**
   * Recreates the automatic wrap after the database was restored without its
   * companion device-key file.
   */
  async repairAutomaticAccess(masterPassword: string): Promise<void> {
    const config = this.requireConfig();
    const vaultKey = await unwrapMasterKey(masterPassword, config);
    try {
      const deviceWrapped = seal(vaultKey, this.deviceKey, DEVICE_KEY_AAD);
      this.database.updatePasswordVaultConfig({
        ...config,
        deviceKeyNonce: deviceWrapped.nonce,
        deviceKeyCiphertext: deviceWrapped.ciphertext,
        deviceKeyTag: deviceWrapped.authTag,
      });
      this.setKey(vaultKey);
    } catch (err) {
      vaultKey.fill(0);
      throw err;
    }
  }

  /**
   * Wipes the current data key. It will be restored from the local device key
   * on the next status check or password operation.
   */
  lock(): void {
    this.key?.fill(0);
    this.key = undefined;
  }

  dispose(): void {
    this.lock();
    this.deviceKey.fill(0);
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
      this.setKey(vaultKey);
    } catch (err) {
      vaultKey.fill(0);
      throw err;
    } finally {
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

  sshPassword(account: string): string | undefined {
    const record = this.database.encryptedCredential(
      PASSWORD_VAULT_PROVIDER,
      SSH_PASSWORD_SERVICE,
      account,
    );
    if (!record) return undefined;
    return this.decryptRecord(record, this.requireAutomaticKey());
  }

  rememberSshPassword(account: string, label: string, password: string): void {
    validateSavedPassword(password);
    const key = this.requireAutomaticKey();
    const ref = this.database.upsertCredentialRef({
      provider: PASSWORD_VAULT_PROVIDER,
      service: SSH_PASSWORD_SERVICE,
      account,
      label,
    });
    const plaintext = Buffer.from(password, 'utf8');
    try {
      const encrypted = seal(plaintext, key, credentialAad(ref.id));
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

  deleteAll(): void {
    this.lock();
    this.database.deletePasswordVaultData(PASSWORD_VAULT_PROVIDER);
  }

  private requireConfig(): PasswordVaultConfigRecord {
    const config = this.database.passwordVaultConfig();
    if (!config) throw new VaultNotConfiguredError();
    return config;
  }

  private requireAutomaticKey(): Buffer {
    this.restoreAutomaticAccess();
    if (!this.key) throw new VaultAutomaticAccessError();
    return this.key;
  }

  private restoreAutomaticAccess(): void {
    if (this.key) return;
    const config = this.database.passwordVaultConfig();
    if (!config) return;
    try {
      const key = open(
        {
          nonce: config.deviceKeyNonce,
          ciphertext: config.deviceKeyCiphertext,
          authTag: config.deviceKeyTag,
        },
        this.deviceKey,
        DEVICE_KEY_AAD,
      );
      if (key.length !== KEY_BYTES) {
        key.fill(0);
        return;
      }
      this.setKey(key);
    } catch {
      // A missing/replaced device key is repairable with the master password.
    }
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
    this.key = key;
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
  const bytes = Buffer.byteLength(password, 'utf8');
  if (Array.from(password).length < MASTER_PASSWORD_MIN_LENGTH) {
    throw new InvalidMasterPasswordFormatError(
      `Master password must contain at least ${MASTER_PASSWORD_MIN_LENGTH} characters.`,
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

function defaultDeviceKeyPath(filename: string): string | undefined {
  return filename === ':memory:'
    ? undefined
    : path.join(path.dirname(filename), DEVICE_KEY_FILENAME);
}

function checkedDeviceKey(value: Buffer): Buffer {
  if (value.length !== KEY_BYTES) {
    throw new Error(`Password-vault device key must be ${KEY_BYTES} bytes.`);
  }
  return Buffer.from(value);
}

function loadOrCreateDeviceKey(filename: string | undefined): Buffer {
  if (!filename) return randomBytes(KEY_BYTES);
  try {
    const key = checkedDeviceKey(readFileSync(filename));
    if (process.platform !== 'win32') chmodSync(filename, 0o600);
    return key;
  } catch (err) {
    if (!isMissingFileError(err)) throw err;
  }

  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  try {
    writeFileSync(filename, key, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (!isExistingFileError(err)) {
      key.fill(0);
      throw err;
    }
    key.fill(0);
    return checkedDeviceKey(readFileSync(filename));
  }
  if (process.platform !== 'win32') chmodSync(filename, 0o600);
  return key;
}

function isMissingFileError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isExistingFileError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'EEXIST'
  );
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
  const maxmem = Math.max(32 * 1024 * 1024, requiredMemory + 8 * 1024 * 1024);
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
  validateMasterPassword(masterPassword);
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
      MASTER_KEY_AAD,
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
