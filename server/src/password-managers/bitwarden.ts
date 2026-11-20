import type { PasswordManagerConfig, PasswordManagerEntry } from '@muxus/shared';
import {
  LIST_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  cliMessage,
  parseJson,
  runCli,
  type CliResult,
} from './cli.js';
import {
  PasswordManagerError,
  sortEntries,
  withoutLineEnding,
  type PasswordManagerProvider,
  type ProviderStatus,
} from './provider.js';

/** Bitwarden's item type for a login; notes, cards and identities have no login password. */
const LOGIN_ITEM = 1;
const PASSWORD_VARIABLE = 'MUXUS_BW_PASSWORD';

interface BwStatus {
  status?: 'unauthenticated' | 'locked' | 'unlocked';
  userEmail?: string | null;
}

interface BwItem {
  id?: string;
  name?: string;
  type?: number;
  login?: {
    username?: string | null;
    password?: string | null;
    uris?: Array<{ uri?: string | null }> | null;
  } | null;
}

/**
 * Bitwarden (and Vaultwarden) through the `bw` command-line program. `bw`
 * stays signed in between runs but locked: unlocking it with the master
 * password returns a session key, which Muxus keeps in memory and passes to
 * later runs in the environment, never on the command line.
 */
export class BitwardenProvider implements PasswordManagerProvider {
  readonly kind = 'bitwarden';
  private readonly program: string;
  private session: string | undefined;

  constructor(config: PasswordManagerConfig) {
    this.program = config.program?.trim() || 'bw';
  }

  async status(): Promise<ProviderStatus> {
    const result = await this.run(['status'], STATUS_TIMEOUT_MS);
    if (result.code !== 0) {
      return { state: 'unavailable', message: cliMessage(result, 'The Bitwarden CLI reported an error.') };
    }
    const status = parseJson<BwStatus>('bw', result.stdout).status;
    if (status === 'unlocked') return { state: 'ready' };
    // The session key Muxus held is gone, for instance after `bw lock` elsewhere.
    this.session = undefined;
    if (status === 'locked') {
      return { state: 'locked', message: 'Enter the Bitwarden master password to unlock the vault.' };
    }
    return {
      state: 'signed-out',
      message: 'The Bitwarden CLI is not logged in. Run “bw login” in a terminal first.',
    };
  }

  async unlock(password: string): Promise<void> {
    const result = await runCli(
      this.program,
      ['unlock', '--raw', '--nointeraction', '--passwordenv', PASSWORD_VARIABLE],
      { env: { [PASSWORD_VARIABLE]: password, BW_SESSION: undefined }, timeoutMs: LIST_TIMEOUT_MS },
    );
    const session = result.stdout.trim();
    if (result.code !== 0 || !session) {
      const message = cliMessage(result, 'The Bitwarden vault could not be unlocked.');
      if (/invalid master password/i.test(message)) {
        throw new PasswordManagerError('invalid-unlock', 'The Bitwarden master password is wrong.');
      }
      if (/not logged in/i.test(message)) {
        throw new PasswordManagerError(
          'signed-out',
          'The Bitwarden CLI is not logged in. Run “bw login” in a terminal first.',
        );
      }
      throw new PasswordManagerError('failed', message);
    }
    this.session = session;
  }

  async lock(): Promise<void> {
    this.session = undefined;
    // Ends the session for good, so the key Muxus held stops working.
    await this.run(['lock'], STATUS_TIMEOUT_MS).catch(() => undefined);
  }

  async sync(): Promise<void> {
    this.check(await this.run(['sync'], LIST_TIMEOUT_MS));
  }

  dispose(): void {
    this.session = undefined;
  }

  async entries(): Promise<PasswordManagerEntry[]> {
    const result = this.check(await this.run(['list', 'items'], LIST_TIMEOUT_MS));
    const items = parseJson<BwItem[]>('bw', result.stdout || '[]');
    const entries: PasswordManagerEntry[] = [];
    for (const item of Array.isArray(items) ? items : []) {
      // The listing carries decrypted passwords; only their presence is used.
      if (!item.id || item.type !== LOGIN_ITEM || !item.login?.password) continue;
      const username = item.login.username?.trim();
      const url = item.login.uris?.find((entry) => entry.uri)?.uri;
      entries.push({
        id: item.id,
        title: item.name || 'Untitled item',
        ...(username ? { username } : {}),
        ...(url ? { url } : {}),
      });
    }
    return sortEntries(entries);
  }

  async password(entryId: string): Promise<string> {
    // Anything but an exact ID makes `bw get` search, and guess.
    if (!/^[0-9a-f-]{36}$/i.test(entryId)) {
      throw new PasswordManagerError('entry-missing', 'The Bitwarden item reference is not valid.');
    }
    const result = this.check(await this.run(['get', 'password', entryId], LIST_TIMEOUT_MS));
    return withoutLineEnding(result.stdout);
  }

  private run(args: string[], timeoutMs: number): Promise<CliResult> {
    return runCli(this.program, [...args, '--nointeraction'], {
      // Without a key of its own, Muxus leaves a BW_SESSION it inherited in place.
      env: this.session ? { BW_SESSION: this.session } : {},
      timeoutMs,
    });
  }

  private check(result: CliResult): CliResult {
    if (result.code === 0) return result;
    const message = cliMessage(result, 'The Bitwarden CLI reported an error.');
    if (/vault is locked/i.test(message)) {
      this.session = undefined;
      throw new PasswordManagerError('locked', 'The Bitwarden vault is locked.');
    }
    if (/not logged in/i.test(message)) {
      this.session = undefined;
      throw new PasswordManagerError(
        'signed-out',
        'The Bitwarden CLI is not logged in. Run “bw login” in a terminal first.',
      );
    }
    if (/not found/i.test(message)) {
      throw new PasswordManagerError('entry-missing', 'The item is no longer in Bitwarden.');
    }
    throw new PasswordManagerError('failed', message);
  }
}
