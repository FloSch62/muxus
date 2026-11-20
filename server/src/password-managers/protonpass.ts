import type { PasswordManagerConfig, PasswordManagerEntry } from '@muxus/shared';
import {
  APPROVAL_TIMEOUT_MS,
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

const SIGNED_OUT = 'The Proton Pass CLI is not logged in. Run “pass-cli login” in a terminal first.';

type Json = Record<string, unknown>;

/**
 * Proton Pass through its `pass-cli` program, which keeps its own login
 * session. Items are listed one vault at a time, because an item ID is only
 * unique together with its vault's share ID.
 */
export class ProtonPassProvider implements PasswordManagerProvider {
  readonly kind = 'protonpass';
  private readonly program: string;

  constructor(config: PasswordManagerConfig) {
    this.program = config.program?.trim() || 'pass-cli';
  }

  async status(): Promise<ProviderStatus> {
    const result = await runCli(this.program, ['info'], { timeoutMs: STATUS_TIMEOUT_MS });
    return result.code === 0 ? { state: 'ready' } : { state: 'signed-out', message: SIGNED_OUT };
  }

  async entries(): Promise<PasswordManagerEntry[]> {
    const listed = this.check(
      await runCli(this.program, ['vault', 'list', '--output', 'json'], { timeoutMs: LIST_TIMEOUT_MS }),
    );
    const entries: PasswordManagerEntry[] = [];
    for (const vault of vaultsOf(parseJson<unknown>('pass-cli', listed.stdout || '{}'))) {
      const result = this.check(
        await runCli(
          this.program,
          [
            'item',
            'list',
            ...(vault.shareId ? ['--share-id', vault.shareId] : ['--vault-name', vault.name]),
            '--filter-type',
            'login',
            '--filter-state',
            'active',
            '--output',
            'json',
          ],
          { timeoutMs: LIST_TIMEOUT_MS },
        ),
      );
      const parsed = parseJson<unknown>('pass-cli', result.stdout || '{}');
      const items = Array.isArray(parsed) ? parsed : asArray(asObject(parsed)?.items);
      for (const raw of items) {
        const item = asObject(raw);
        const id = text(item?.id) ?? text(item?.item_id);
        if (!item || !id) continue;
        const shareId = text(item.share_id) ?? vault.shareId;
        const content = asObject(item.content);
        const login = asObject(asObject(content?.content)?.Login);
        const username = text(login?.username) || text(login?.email);
        const url = asArray(login?.urls).map(text).find(Boolean);
        entries.push({
          id: shareId ? `share:${shareId}/${id}` : `vault:${encodeURIComponent(vault.name)}/${id}`,
          title: text(content?.title) ?? text(item.title) ?? 'Untitled item',
          ...(username ? { username } : {}),
          ...(url ? { url } : {}),
          ...(vault.name ? { group: vault.name } : {}),
        });
      }
    }
    return sortEntries(entries);
  }

  async password(entryId: string): Promise<string> {
    const match = /^(share|vault):([^/]+)\/([^/]+)$/.exec(entryId);
    if (!match) {
      throw new PasswordManagerError('entry-missing', 'The Proton Pass item reference is not valid.');
    }
    const [, scope, container, item] = match;
    const result = this.check(
      await runCli(
        this.program,
        [
          'item',
          'view',
          ...(scope === 'share'
            ? ['--share-id', container!]
            : ['--vault-name', decodeURIComponent(container!)]),
          '--item-id',
          item!,
          '--field',
          'password',
        ],
        { timeoutMs: APPROVAL_TIMEOUT_MS },
      ),
    );
    return withoutLineEnding(result.stdout);
  }

  private check(result: CliResult): CliResult {
    if (result.code === 0) return result;
    const message = cliMessage(result, 'The Proton Pass CLI reported an error.');
    if (/not logged in|log ?in|session|unauthori[sz]ed/i.test(message)) {
      throw new PasswordManagerError('signed-out', SIGNED_OUT);
    }
    if (/not found/i.test(message)) {
      throw new PasswordManagerError('entry-missing', 'The item is no longer in Proton Pass.');
    }
    throw new PasswordManagerError('failed', message);
  }
}

function vaultsOf(parsed: unknown): Array<{ name: string; shareId?: string }> {
  const list = Array.isArray(parsed) ? parsed : asArray(asObject(parsed)?.vaults);
  const vaults: Array<{ name: string; shareId?: string }> = [];
  for (const raw of list) {
    const vault = asObject(raw);
    const name = text(vault?.name) ?? text(asObject(vault?.content)?.name);
    const shareId = text(vault?.share_id);
    if (name || shareId) vaults.push({ name: name ?? '', ...(shareId ? { shareId } : {}) });
  }
  return vaults;
}

function asObject(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
