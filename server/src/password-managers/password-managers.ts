import {
  PASSWORD_MANAGER_KINDS,
  PASSWORD_MANAGER_LABELS,
  type AuthPromptInfo,
  type AuthPromptResponse,
  type ExternalPasswordRef,
  type PasswordManagerConfig,
  type PasswordManagerEntry,
  type PasswordManagerInput,
  type PasswordManagerKind,
  type PasswordManagerSource,
  type PasswordManagersResponse,
} from '@muxus/shared';
import type { MuxusDatabase, PasswordManagerSourceRow } from '../persistence/database.js';
import { BitwardenProvider } from './bitwarden.js';
import { programInstalled } from './cli.js';
import { DashlaneProvider } from './dashlane.js';
import { KeePassProvider } from './keepass.js';
import { LastPassProvider } from './lastpass.js';
import { OnePasswordProvider } from './onepassword.js';
import { PassProvider } from './pass.js';
import { ProtonPassProvider } from './protonpass.js';
import {
  PasswordManagerError,
  type PasswordManagerProvider,
  type ProviderFactory,
  type ProviderStatus,
} from './provider.js';

const FACTORIES: Record<PasswordManagerKind, ProviderFactory> = {
  keepass: (config) => new KeePassProvider(config),
  onepassword: (config) => new OnePasswordProvider(config),
  bitwarden: (config) => new BitwardenProvider(config),
  protonpass: (config) => new ProtonPassProvider(config),
  lastpass: (config) => new LastPassProvider(config),
  dashlane: (config) => new DashlaneProvider(config),
  pass: (config) => new PassProvider(config),
};

/** The program each kind runs by default; KeePass reads its file directly. */
const PROGRAMS: Partial<Record<PasswordManagerKind, string[]>> = {
  onepassword: ['op'],
  bitwarden: ['bw'],
  protonpass: ['pass-cli'],
  lastpass: ['lpass'],
  dashlane: ['dcli'],
  pass: ['gpg2', 'gpg'],
};

/** What the unlock prompt asks for. */
const UNLOCK_PROMPTS: Partial<Record<PasswordManagerKind, string>> = {
  keepass: 'Database password',
  bitwarden: 'Bitwarden master password',
};

const UNLOCK_ATTEMPTS = 3;

/** The part of a connection's prompt channel reading a password needs. */
export interface PasswordManagerIo {
  status(message: string, options?: { transient?: boolean }): void;
  prompt(info: AuthPromptInfo): Promise<AuthPromptResponse>;
}

export class PasswordManagerSourceMissingError extends Error {
  constructor() {
    super('The password manager is no longer connected.');
  }
}

/**
 * The password managers connected in Settings. Each gets one provider that
 * lives as long as its configuration, so an unlocked KeePass database or a
 * Bitwarden session stays unlocked across connections.
 */
export class PasswordManagers {
  private readonly providers = new Map<string, { signature: string; provider: PasswordManagerProvider }>();

  constructor(
    private readonly database: MuxusDatabase,
    private readonly factories: Record<PasswordManagerKind, ProviderFactory> = FACTORIES,
  ) {}

  async list(): Promise<PasswordManagersResponse> {
    const [sources, installed] = await Promise.all([
      Promise.all(this.database.listPasswordManagerSources().map((row) => this.describe(row))),
      this.installedKinds(),
    ]);
    return { sources, installed };
  }

  async create(input: PasswordManagerInput): Promise<PasswordManagerSource> {
    const config = cleanConfig(input.config);
    const row = this.database.createPasswordManagerSource({
      kind: input.kind,
      name: input.name?.trim() || this.defaultName(input.kind, config),
      config,
    });
    return this.describe(row);
  }

  async update(id: string, input: PasswordManagerInput): Promise<PasswordManagerSource | undefined> {
    const current = this.database.passwordManagerSource(id);
    if (!current) return undefined;
    const config = cleanConfig(input.config);
    const row = this.database.updatePasswordManagerSource(id, {
      name: input.name?.trim() || current.name,
      config,
    });
    return row ? this.describe(row) : undefined;
  }

  remove(id: string): boolean {
    this.forget(id);
    return this.database.deletePasswordManagerSource(id);
  }

  async unlock(id: string, password: string): Promise<PasswordManagerSource> {
    const { row, provider } = this.require(id);
    if (!provider.unlock) {
      throw new PasswordManagerError('failed', `${row.name} is unlocked in its own app, not in Muxus.`);
    }
    await provider.unlock(password);
    return this.describe(row);
  }

  async lock(id: string): Promise<PasswordManagerSource> {
    const { row, provider } = this.require(id);
    await provider.lock?.();
    return this.describe(row);
  }

  async entries(id: string, options: { sync?: boolean } = {}): Promise<PasswordManagerEntry[]> {
    const { provider } = this.require(id);
    if (options.sync) await provider.sync?.();
    return provider.entries();
  }

  /** The entry's password. Throws a PasswordManagerError saying why when it cannot be read. */
  async password(ref: ExternalPasswordRef): Promise<string> {
    return this.require(ref.sourceId).provider.password(ref.entryId);
  }

  /**
   * The entry's password for a login in progress. A locked manager is
   * unlocked through the connection's own prompt; anything else that goes
   * wrong is reported there and gives undefined, so the login falls back to
   * asking for the password.
   */
  async passwordFor(ref: ExternalPasswordRef, io: PasswordManagerIo): Promise<string | undefined> {
    const row = this.database.passwordManagerSource(ref.sourceId);
    const entry = ref.title ? `“${ref.title}”` : 'the linked entry';
    if (!row) {
      io.status(`The password manager holding ${entry} is no longer connected. Enter the password.`);
      return undefined;
    }
    const provider = this.provider(row);
    let problem: string | undefined;
    for (let attempt = 0; attempt <= UNLOCK_ATTEMPTS; attempt++) {
      try {
        const password = await provider.password(ref.entryId);
        io.status(`Using the password of ${entry} from ${row.name}.`, { transient: true });
        return password;
      } catch (err) {
        if (!(err instanceof PasswordManagerError)) throw err;
        const prompt = UNLOCK_PROMPTS[row.kind];
        if (err.problem !== 'locked' || !provider.unlock || !prompt || attempt === UNLOCK_ATTEMPTS) {
          io.status(`Could not read ${entry} from ${row.name}: ${err.message} Enter the password.`);
          return undefined;
        }
        const instructions = `Unlock ${row.name} to use the password of ${entry}.`;
        const response = await io.prompt({
          name: `Unlock ${row.name}`,
          purpose: 'vault-unlock',
          instructions: problem ? `${problem}\n\n${instructions}` : instructions,
          prompts: [{ prompt, echo: false }],
          skipLabel: 'Use another password',
        });
        if (response.skipped) return undefined;
        try {
          await provider.unlock(response.answers[0] ?? '');
          problem = undefined;
        } catch (unlockError) {
          if (!(unlockError instanceof PasswordManagerError)) throw unlockError;
          if (unlockError.problem !== 'invalid-unlock') {
            io.status(`${row.name} could not be unlocked: ${unlockError.message} Enter the password.`);
            return undefined;
          }
          problem = unlockError.message;
        }
      }
    }
    return undefined;
  }

  dispose(): void {
    for (const { provider } of this.providers.values()) provider.dispose?.();
    this.providers.clear();
  }

  private require(id: string): { row: PasswordManagerSourceRow; provider: PasswordManagerProvider } {
    const row = this.database.passwordManagerSource(id);
    if (!row) throw new PasswordManagerSourceMissingError();
    return { row, provider: this.provider(row) };
  }

  /** The source's provider, rebuilt (and so locked again) when its settings changed. */
  private provider(row: PasswordManagerSourceRow): PasswordManagerProvider {
    const signature = JSON.stringify([row.kind, row.config]);
    const existing = this.providers.get(row.id);
    if (existing?.signature === signature) return existing.provider;
    existing?.provider.dispose?.();
    const factory = this.factories[row.kind];
    if (!factory) throw new PasswordManagerError('failed', `Muxus does not know the password manager “${row.kind}”.`);
    const provider = factory(row.config);
    this.providers.set(row.id, { signature, provider });
    return provider;
  }

  private forget(id: string): void {
    this.providers.get(id)?.provider.dispose?.();
    this.providers.delete(id);
  }

  private async describe(row: PasswordManagerSourceRow): Promise<PasswordManagerSource> {
    let status: ProviderStatus;
    try {
      status = await this.provider(row).status();
    } catch (err) {
      status = {
        state: 'unavailable',
        message: err instanceof Error ? err.message : 'The password manager could not be reached.',
      };
    }
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      config: row.config,
      state: status.state,
      ...(status.message ? { message: status.message } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async installedKinds(): Promise<PasswordManagerKind[]> {
    const found = await Promise.all(
      PASSWORD_MANAGER_KINDS.map(async (kind) => {
        const programs = PROGRAMS[kind];
        // KeePass needs no program at all.
        if (!programs) return true;
        const present = await Promise.all(programs.map((program) => programInstalled(program)));
        return present.some(Boolean);
      }),
    );
    return PASSWORD_MANAGER_KINDS.filter((_kind, index) => found[index]);
  }

  private defaultName(kind: PasswordManagerKind, config: PasswordManagerConfig): string {
    // Several KeePass databases are told apart by their file names.
    const file = kind === 'keepass' ? config.path?.split(/[\\/]/).pop()?.replace(/\.kdbx$/i, '') : undefined;
    return file ? `KeePass – ${file}` : PASSWORD_MANAGER_LABELS[kind];
  }
}

/** Trimmed settings without the empty ones. */
function cleanConfig(config: PasswordManagerConfig): PasswordManagerConfig {
  const out: PasswordManagerConfig = {};
  for (const key of ['path', 'keyFile', 'program', 'account'] as const) {
    const value = config[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}
