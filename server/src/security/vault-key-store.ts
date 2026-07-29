const SERVICE = 'io.github.flosch62.muxus.password-vault';
const KEY_BYTES = 32;

export interface VaultKeyStore {
  readonly backend: 'os' | 'memory';
  get(vaultId: string): Promise<Buffer | undefined>;
  set(vaultId: string, key: Buffer): Promise<void>;
  delete(vaultId: string): Promise<void>;
}

export class VaultKeyStoreUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'The operating-system credential store is unavailable. Choose a master-password prompt policy or start an unlocked Secret Service-compatible keyring.',
      options,
    );
  }
}

/**
 * Windows Credential Manager / macOS Keychain / Linux Secret Service adapter.
 *
 * The native package also supports the Linux kernel keyring when Secret
 * Service is unavailable. It never falls back to an application-owned file.
 */
export class SystemVaultKeyStore implements VaultKeyStore {
  readonly backend = 'os' as const;

  async get(vaultId: string): Promise<Buffer | undefined> {
    try {
      const entry = await this.entry(vaultId);
      const secret = await entry.getSecret();
      if (!secret) return undefined;
      const key = Buffer.from(secret);
      if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw new Error('The OS credential-store entry has an invalid length.');
      }
      return key;
    } catch (err) {
      if (err instanceof VaultKeyStoreUnavailableError) throw err;
      throw new VaultKeyStoreUnavailableError({ cause: err });
    }
  }

  async set(vaultId: string, key: Buffer): Promise<void> {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Password-vault key must be ${KEY_BYTES} bytes.`);
    }
    try {
      const entry = await this.entry(vaultId);
      await entry.setSecret(key);
    } catch (err) {
      throw new VaultKeyStoreUnavailableError({ cause: err });
    }
  }

  async delete(vaultId: string): Promise<void> {
    const replacement = Buffer.alloc(KEY_BYTES);
    try {
      const entry = await this.entry(vaultId);
      // The binding reports deletion failures as `false` rather than
      // rejecting. Overwrite first so even a failed delete cannot leave the
      // usable vault key behind.
      await entry.setSecret(replacement);
      const deleted = await entry.deleteCredential();
      if (!deleted) {
        throw new Error('The OS credential-store entry could not be deleted.');
      }
    } catch (err) {
      throw new VaultKeyStoreUnavailableError({ cause: err });
    } finally {
      replacement.fill(0);
    }
  }

  private async entry(vaultId: string) {
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      return new AsyncEntry(SERVICE, vaultId);
    } catch (err) {
      throw new VaultKeyStoreUnavailableError({ cause: err });
    }
  }
}

/** In-memory credential store for tests and ephemeral :memory: databases. */
export class MemoryVaultKeyStore implements VaultKeyStore {
  readonly backend = 'memory' as const;

  constructor(private readonly values = new Map<string, Buffer>()) {}

  async get(vaultId: string): Promise<Buffer | undefined> {
    const value = this.values.get(vaultId);
    return value ? Buffer.from(value) : undefined;
  }

  async set(vaultId: string, key: Buffer): Promise<void> {
    this.values.get(vaultId)?.fill(0);
    this.values.set(vaultId, Buffer.from(key));
  }

  async delete(vaultId: string): Promise<void> {
    this.values.get(vaultId)?.fill(0);
    this.values.delete(vaultId);
  }
}
