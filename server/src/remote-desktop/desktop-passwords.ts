import {
  DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
  type AuthPromptInfo,
  type AuthPromptResponse,
} from '@muxus/shared';
import {
  CredentialVaultCorruptError,
  InvalidMasterPasswordError,
  InvalidMasterPasswordFormatError,
  VaultAlreadyConfiguredError,
  type PasswordVault,
} from '../security/password-vault.js';
import { VaultKeyStoreUnavailableError } from '../security/vault-key-store.js';

export interface PromptIo {
  status(message: string, options?: { transient?: boolean }): void;
  prompt(info: AuthPromptInfo): Promise<AuthPromptResponse>;
}

export interface VaultPasswordRef {
  account: string;
  label: string;
}

/**
 * The password-vault side of an RDP/VNC login, with the same unlock, create
 * and "remember" prompts an SSH password gets. Passwords are stored under the
 * vault's login-password service alongside SSH passwords.
 */
export class DesktopPasswords {
  constructor(
    private readonly vault: PasswordVault | undefined,
    private readonly io: PromptIo,
  ) {}

  get available(): boolean {
    return !!this.vault;
  }

  has(ref: VaultPasswordRef): boolean {
    return this.vault?.hasSshPassword(ref.account) ?? false;
  }

  /** The saved password, unlocking the vault first when its policy asks for that. */
  async read(ref: VaultPasswordRef): Promise<string | undefined> {
    const vault = this.vault;
    if (!vault || !vault.hasSshPassword(ref.account)) return undefined;
    try {
      if (!vault.status().locked) return await vault.sshPassword(ref.account);
      const result = await this.withMasterPassword(
        'Unlock password vault',
        `Enter the master password to use the saved password for ${ref.label}.`,
        'Use another password',
        (masterPassword) => vault.sshPassword(ref.account, masterPassword),
      );
      return result.ok ? result.value : undefined;
    } catch (err) {
      if (err instanceof CredentialVaultCorruptError) {
        this.io.status(`The saved password for ${ref.label} is damaged. Enter it again to replace the saved copy.`);
        return undefined;
      }
      if (err instanceof VaultKeyStoreUnavailableError) {
        this.io.status(`The OS credential store is unavailable. Enter the password for ${ref.label}.`);
        return undefined;
      }
      throw err;
    }
  }

  /** Save a password the user asked to remember, once the login has succeeded. */
  async remember(ref: VaultPasswordRef, password: string): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    if (!vault.status().configured && !(await this.createVault())) return;
    if (vault.status().locked) {
      const result = await this.withMasterPassword(
        'Unlock password vault',
        `Enter the master password to remember the password for ${ref.label}.`,
        'Not now',
        (masterPassword) => vault.rememberSshPassword(ref.account, ref.label, password, masterPassword),
      );
      if (!result.ok) return;
    } else {
      await vault.rememberSshPassword(ref.account, ref.label, password);
    }
    this.io.status(`Remembered the password for ${ref.label}.`);
  }

  private async createVault(): Promise<boolean> {
    const vault = this.vault!;
    const response = await this.io.prompt({
      name: 'Create password vault',
      purpose: 'vault-create',
      instructions:
        'Create a master password to protect viewing and editing saved passwords. ' +
        'By default, Muxus stores the vault key in the operating-system credential store ' +
        'so saved passwords can be used without another master-password prompt.',
      prompts: [
        { prompt: 'Master password', echo: false },
        { prompt: 'Confirm master password', echo: false },
      ],
      skipLabel: 'Not now',
    });
    if (response.skipped) return false;
    const [masterPassword = '', confirmation = ''] = response.answers;
    if (masterPassword !== confirmation) {
      throw new InvalidMasterPasswordFormatError('The master-password confirmation did not match.');
    }
    try {
      await vault.create(masterPassword, DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY);
    } catch (err) {
      if (!(err instanceof VaultAlreadyConfiguredError)) throw err;
    }
    return true;
  }

  private async withMasterPassword<T>(
    name: string,
    instructions: string,
    skipLabel: string,
    operation: (masterPassword: string) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    let error: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.io.prompt({
        name,
        purpose: 'vault-unlock',
        instructions: error ? `${error}\n\n${instructions}` : instructions,
        prompts: [{ prompt: 'Master password', echo: false }],
        skipLabel,
      });
      if (response.skipped) return { ok: false };
      try {
        return { ok: true, value: await operation(response.answers[0] ?? '') };
      } catch (err) {
        if (err instanceof InvalidMasterPasswordError || err instanceof InvalidMasterPasswordFormatError) {
          error = err.message;
          continue;
        }
        throw err;
      }
    }
    this.io.status('The password vault remains locked.');
    return { ok: false };
  }
}
