import type { PasswordManagerConfig, PasswordManagerEntry } from '@muxus/shared';
import {
  APPROVAL_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  cliMessage,
  parseJson,
  runCli,
  type CliResult,
} from './cli.js';
import {
  PasswordManagerError,
  sortEntries,
  type PasswordManagerProvider,
  type ProviderStatus,
} from './provider.js';

/** Item categories that carry a login password in a field called `password`. */
const CATEGORIES = 'Login,Password,Server,Database';

interface OpItem {
  id?: string;
  title?: string;
  category?: string;
  vault?: { id?: string; name?: string };
  /** The user name, for a login. */
  additional_information?: string;
  urls?: Array<{ href?: string; primary?: boolean }>;
}

/**
 * 1Password through its `op` command-line program. With the 1Password app's
 * CLI integration turned on, `op` asks the app to approve each session, with
 * Touch ID, Windows Hello or the system password; a service-account token in
 * the environment works as well. Muxus never sees the account password.
 */
export class OnePasswordProvider implements PasswordManagerProvider {
  readonly kind = 'onepassword';
  private readonly program: string;
  private readonly account: string | undefined;

  constructor(config: PasswordManagerConfig) {
    this.program = config.program?.trim() || 'op';
    this.account = config.account?.trim() || undefined;
  }

  async status(): Promise<ProviderStatus> {
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN) return { state: 'ready' };
    // Listing accounts never asks for approval, unlike reading from one.
    const result = await runCli(this.program, ['account', 'list', '--format', 'json'], {
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      return { state: 'signed-out', message: cliMessage(result, 'The 1Password CLI is not set up.') };
    }
    const accounts = parseJson<unknown[]>('op', result.stdout || '[]');
    return Array.isArray(accounts) && accounts.length > 0
      ? { state: 'ready' }
      : {
          state: 'signed-out',
          message:
            'No 1Password account is available to the CLI. Turn on “Integrate with 1Password CLI” in the 1Password app, under Settings → Developer.',
        };
  }

  async entries(): Promise<PasswordManagerEntry[]> {
    const result = await this.run(['item', 'list', '--categories', CATEGORIES, '--format', 'json']);
    const items = parseJson<OpItem[]>('op', result.stdout || '[]');
    const entries: PasswordManagerEntry[] = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item.id || !item.vault?.id) continue;
      const username = item.additional_information?.trim();
      const url = (item.urls?.find((entry) => entry.primary) ?? item.urls?.[0])?.href;
      entries.push({
        // The vault is part of the address: `op read` needs both.
        id: `${item.vault.id}/${item.id}`,
        title: item.title || 'Untitled item',
        // Items without a user name show a dash here.
        ...(username && username !== '—' && username !== '-' ? { username } : {}),
        ...(url ? { url } : {}),
        ...(item.vault.name ? { group: item.vault.name } : {}),
      });
    }
    return sortEntries(entries);
  }

  async password(entryId: string): Promise<string> {
    const [vault, item, extra] = entryId.split('/');
    if (!vault || !item || extra !== undefined || !/^[a-z0-9]+$/i.test(vault + item)) {
      throw new PasswordManagerError('entry-missing', 'The 1Password item reference is not valid.');
    }
    // IDs rather than names: a name may hold characters a reference cannot.
    const result = await this.run(['read', '--no-newline', `op://${vault}/${item}/password`]);
    return result.stdout;
  }

  private async run(args: string[]): Promise<CliResult> {
    const result = await runCli(
      this.program,
      [...args, ...(this.account ? ['--account', this.account] : [])],
      { timeoutMs: APPROVAL_TIMEOUT_MS },
    );
    if (result.code === 0) return result;
    const message = cliMessage(result, 'The 1Password CLI reported an error.');
    if (/isn't an item|not found|no item/i.test(message)) {
      throw new PasswordManagerError('entry-missing', 'The item is no longer in 1Password.');
    }
    if (/not (currently )?signed in|no accounts configured|sign ?in/i.test(message)) {
      throw new PasswordManagerError('signed-out', message);
    }
    throw new PasswordManagerError('failed', message);
  }
}
