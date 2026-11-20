import type { PasswordManagerConfig, PasswordManagerEntry } from '@muxus/shared';
import { LIST_TIMEOUT_MS, STATUS_TIMEOUT_MS, cliMessage, runCli, type CliResult } from './cli.js';
import {
  PasswordManagerError,
  sortEntries,
  withoutLineEnding,
  type PasswordManagerProvider,
  type ProviderStatus,
} from './provider.js';

const SIGNED_OUT = 'The LastPass CLI is not logged in. Run “lpass login <email>” in a terminal first.';
/** Between the fields of one listed entry; a character no name or URL holds. */
const FIELD = '\u001f';
/** ID, name, user name, URL and folder of each entry. */
const LIST_FORMAT = ['%ai', '%an', '%au', '%al', '%ag'].join(FIELD);
// Without a terminal, a pinentry program could open a window nobody expects,
// or wait on one that never shows; failing at once is the better answer.
const ENVIRONMENT = { LPASS_DISABLE_PINENTRY: '1' };

/**
 * LastPass through the `lpass` program. Its own agent keeps the vault key
 * after `lpass login`, so Muxus only ever asks it for one entry at a time.
 */
export class LastPassProvider implements PasswordManagerProvider {
  readonly kind = 'lastpass';
  private readonly program: string;

  constructor(config: PasswordManagerConfig) {
    this.program = config.program?.trim() || 'lpass';
  }

  async status(): Promise<ProviderStatus> {
    // Exits 0 while logged in and 1 otherwise.
    const result = await runCli(this.program, ['status', '--quiet', '--color=never'], {
      env: ENVIRONMENT,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    return result.code === 0 ? { state: 'ready' } : { state: 'signed-out', message: SIGNED_OUT };
  }

  async sync(): Promise<void> {
    this.check(await this.run(['sync', '--color=never']));
  }

  async entries(): Promise<PasswordManagerEntry[]> {
    const result = this.check(
      await this.run(['ls', '--sync=auto', '--color=never', `--format=${LIST_FORMAT}`]),
    );
    const entries: PasswordManagerEntry[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const [id, name, username, url, group] = line.split(FIELD);
      // Folders are listed as entries at "http://group", secure notes at "http://sn".
      if (!id || !/^\d+$/.test(id) || url === 'http://group' || url === 'http://sn') continue;
      entries.push({
        id,
        title: name || 'Untitled entry',
        ...(username ? { username } : {}),
        ...(url && url !== 'http://' ? { url } : {}),
        ...(group ? { group } : {}),
      });
    }
    return sortEntries(entries);
  }

  async password(entryId: string): Promise<string> {
    // The numeric ID names exactly one entry; a name could match several.
    if (!/^\d+$/.test(entryId)) {
      throw new PasswordManagerError('entry-missing', 'The LastPass entry reference is not valid.');
    }
    const result = this.check(
      await this.run(['show', '--sync=auto', '--color=never', '--password', entryId]),
    );
    return withoutLineEnding(result.stdout);
  }

  private run(args: string[]): Promise<CliResult> {
    return runCli(this.program, args, { env: ENVIRONMENT, timeoutMs: LIST_TIMEOUT_MS });
  }

  private check(result: CliResult): CliResult {
    if (result.code === 0) return result;
    const message = cliMessage(result, 'The LastPass CLI reported an error.');
    if (/could not find decryption key|not logged in|log ?in/i.test(message)) {
      throw new PasswordManagerError('signed-out', SIGNED_OUT);
    }
    if (/could not find specified account/i.test(message)) {
      throw new PasswordManagerError('entry-missing', 'The entry is no longer in LastPass.');
    }
    throw new PasswordManagerError('failed', message);
  }
}
