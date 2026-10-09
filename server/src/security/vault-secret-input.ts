import type { TerminalInputWriter } from '../ws/terminal-inputs.js';
import type { PasswordVault } from './password-vault.js';

/** A secret as keystrokes: its text, then Enter (a carriage return, as the key sends) when asked. */
export function secretKeystrokes(value: string, enter: boolean): Buffer {
  return Buffer.from(enter ? `${value}\r` : value, 'utf8');
}

/**
 * Type a named vault secret into terminal sessions as if it were typed. The
 * value goes from the vault straight to each writer; it is never returned,
 * logged or given to a session recorder, so only what the remote side echoes
 * can reach session history or a log file. The vault's own errors (locked,
 * wrong master password) pass through so callers can ask for the master
 * password and try again.
 *
 * Resolves to the number of sessions that took the secret, or undefined when
 * the secret is no longer in the vault.
 */
export async function typeVaultSecret(
  vault: PasswordVault,
  secretId: string,
  writers: readonly TerminalInputWriter[],
  options: { enter: boolean; masterPassword?: string },
): Promise<number | undefined> {
  const value = await vault.secretValue(secretId, options.masterPassword);
  if (value === undefined) return undefined;
  let typed = 0;
  for (const write of writers) {
    if (write(secretKeystrokes(value, options.enter))) typed++;
  }
  return typed;
}
