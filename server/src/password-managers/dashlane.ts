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

const SIGNED_OUT = 'The Dashlane CLI is not logged in. Run “dcli sync” in a terminal first.';
const LOCKED =
  'The Dashlane CLI is locked. Run “dcli sync” in a terminal and enter the master password to unlock it.';

interface DashlaneCredential {
  /** A UUID wrapped in braces. */
  id?: string;
  title?: string;
  login?: string;
  email?: string;
  url?: string;
}

/**
 * Dashlane through its `dcli` program, which reads a local copy of the vault
 * and keeps the master password in the operating system's keychain.
 */
export class DashlaneProvider implements PasswordManagerProvider {
  readonly kind = 'dashlane';
  private readonly program: string;

  constructor(config: PasswordManagerConfig) {
    this.program = config.program?.trim() || 'dcli';
  }

  async status(): Promise<ProviderStatus> {
    const result = await runCli(this.program, ['status'], { timeoutMs: STATUS_TIMEOUT_MS });
    // Older versions have no status command; reading an entry then says what is wrong.
    if (result.code !== 0) return { state: 'ready' };
    if (/Logged in:\s*No/i.test(result.stdout)) return { state: 'signed-out', message: SIGNED_OUT };
    if (/Locked:\s*Yes/i.test(result.stdout)) return { state: 'signed-out', message: LOCKED };
    return { state: 'ready' };
  }

  async sync(): Promise<void> {
    this.check(await runCli(this.program, ['sync'], { timeoutMs: LIST_TIMEOUT_MS }));
  }

  async entries(): Promise<PasswordManagerEntry[]> {
    const result = this.check(
      await runCli(this.program, ['password', '--output', 'json'], { timeoutMs: LIST_TIMEOUT_MS }),
    );
    // The listing carries every decrypted password; none of them is kept.
    const credentials = parseJson<DashlaneCredential[]>('dcli', result.stdout || '[]');
    const entries: PasswordManagerEntry[] = [];
    for (const credential of Array.isArray(credentials) ? credentials : []) {
      const id = credential.id?.replace(/^\{|\}$/g, '');
      if (!id) continue;
      const username = credential.login?.trim() || credential.email?.trim();
      entries.push({
        id,
        title: credential.title || credential.url || 'Untitled credential',
        ...(username ? { username } : {}),
        ...(credential.url ? { url: credential.url } : {}),
      });
    }
    return sortEntries(entries);
  }

  async password(entryId: string): Promise<string> {
    // Anything that is not a UUID is taken for a title, and the first match wins.
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entryId)) {
      throw new PasswordManagerError('entry-missing', 'The Dashlane credential reference is not valid.');
    }
    const result = this.check(
      await runCli(this.program, ['read', `dl://${entryId}/password`], { timeoutMs: LIST_TIMEOUT_MS }),
    );
    return withoutLineEnding(result.stdout);
  }

  private check(result: CliResult): CliResult {
    if (result.code === 0) return result;
    const message = cliMessage(result, 'The Dashlane CLI reported an error.');
    if (/master password|not logged in|log ?in|device/i.test(message)) {
      throw new PasswordManagerError('signed-out', LOCKED);
    }
    if (/no matching|not found|no secret/i.test(message)) {
      throw new PasswordManagerError('entry-missing', 'The credential is no longer in Dashlane.');
    }
    throw new PasswordManagerError('failed', message);
  }
}
