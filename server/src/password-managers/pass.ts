import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PasswordManagerConfig, PasswordManagerEntry } from '@muxus/shared';
import { APPROVAL_TIMEOUT_MS, cliMessage, resolveProgram, runCli } from './cli.js';
import { expandHome } from './keepass.js';
import {
  PasswordManagerError,
  sortEntries,
  type PasswordManagerProvider,
  type ProviderStatus,
} from './provider.js';

const MAX_DEPTH = 12;

/**
 * The standard Unix password store (`pass`, and `gopass` with its default GPG
 * backend): a directory of files, each one entry encrypted with GnuPG, the
 * password on its first line. Muxus lists the files and has `gpg` decrypt
 * the one it needs, so the passphrase prompt stays with gpg-agent's pinentry.
 */
export class PassProvider implements PasswordManagerProvider {
  readonly kind = 'pass';
  private readonly store: string;
  private readonly program: string | undefined;

  constructor(config: PasswordManagerConfig) {
    this.store = path.resolve(
      expandHome(
        config.path?.trim() ||
          process.env.PASSWORD_STORE_DIR ||
          path.join(os.homedir(), '.password-store'),
      ),
    );
    this.program = config.program?.trim() || undefined;
  }

  async status(): Promise<ProviderStatus> {
    try {
      if (!(await stat(this.store)).isDirectory()) throw new Error('not a directory');
    } catch {
      return { state: 'unavailable', message: `The password store ${this.store} was not found.` };
    }
    return (await this.gpg())
      ? { state: 'ready' }
      : { state: 'unavailable', message: 'GnuPG (gpg) was not found on this computer.' };
  }

  async entries(): Promise<PasswordManagerEntry[]> {
    const entries: PasswordManagerEntry[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        if (depth === 0) {
          throw new PasswordManagerError('unavailable', `The password store ${this.store} was not found.`);
        }
        return;
      }
      for (const child of children) {
        // .git, .gpg-id, .extensions and the like are not entries.
        if (child.name.startsWith('.')) continue;
        const full = path.join(directory, child.name);
        if (child.isDirectory()) {
          if (depth < MAX_DEPTH) await walk(full, depth + 1);
        } else if (child.isFile() && child.name.endsWith('.gpg')) {
          const name = path.relative(this.store, full).slice(0, -'.gpg'.length).split(path.sep).join('/');
          const slash = name.lastIndexOf('/');
          entries.push({
            id: name,
            title: slash < 0 ? name : name.slice(slash + 1),
            ...(slash < 0 ? {} : { group: name.slice(0, slash) }),
          });
        }
      }
    };
    await walk(this.store, 0);
    return sortEntries(entries);
  }

  async password(entryId: string): Promise<string> {
    const file = path.resolve(this.store, `${entryId}.gpg`);
    // An entry names a file inside the store and nothing above it.
    if (!file.startsWith(this.store + path.sep) || entryId.split('/').some((part) => part.startsWith('.'))) {
      throw new PasswordManagerError('entry-missing', 'The password store entry reference is not valid.');
    }
    try {
      await stat(file);
    } catch {
      throw new PasswordManagerError('entry-missing', `“${entryId}” is no longer in the password store.`);
    }
    const gpg = await this.gpg();
    if (!gpg) {
      throw new PasswordManagerError('unavailable', 'GnuPG (gpg) was not found on this computer.');
    }
    // --batch keeps gpg off the terminal; the passphrase still comes from
    // gpg-agent's own pinentry window.
    const result = await runCli(gpg, ['--quiet', '--batch', '--yes', '--decrypt', file], {
      timeoutMs: APPROVAL_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new PasswordManagerError(
        'failed',
        `gpg could not decrypt “${entryId}”: ${cliMessage(result, 'decryption failed')}`,
      );
    }
    // The password is the first line; the rest is notes and other fields.
    return result.stdout.split(/\r?\n/, 1)[0] ?? '';
  }

  private async gpg(): Promise<string | undefined> {
    for (const candidate of this.program ? [this.program] : ['gpg2', 'gpg']) {
      if (await resolveProgram(candidate)) return candidate;
    }
    return undefined;
  }
}
