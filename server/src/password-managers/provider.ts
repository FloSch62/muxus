import type {
  PasswordManagerConfig,
  PasswordManagerEntry,
  PasswordManagerKind,
  PasswordManagerState,
} from '@muxus/shared';

export type PasswordManagerProblem =
  /** The database, store or program is missing. */
  | 'unavailable'
  /** Needs the manager's own password, which Muxus can ask for. */
  | 'locked'
  /** The program is not signed in; that happens outside Muxus. */
  | 'signed-out'
  /** The password given to unlock it was wrong. */
  | 'invalid-unlock'
  /** The entry is no longer in the password manager. */
  | 'entry-missing'
  /** The program did not answer in time, usually an approval prompt left open. */
  | 'timeout'
  | 'failed';

export class PasswordManagerError extends Error {
  constructor(
    readonly problem: PasswordManagerProblem,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderStatus {
  state: PasswordManagerState;
  message?: string;
}

/**
 * One password manager. A provider only reads: it never writes to the
 * manager, and a password it returns is handed straight to the login that
 * asked for it. Providers keep whatever unlocks the manager in memory only.
 */
export interface PasswordManagerProvider {
  readonly kind: PasswordManagerKind;
  /** Cheap and silent: must never raise an approval or unlock prompt. */
  status(): Promise<ProviderStatus>;
  /** Present when Muxus can unlock the manager with a password it collects. */
  unlock?(password: string): Promise<void>;
  /** Forget whatever unlocked the manager. */
  lock?(): Promise<void>;
  /** Pull changes from the manager's server before the next listing. */
  sync?(): Promise<void>;
  /** Every entry that can hold a login password. */
  entries(): Promise<PasswordManagerEntry[]>;
  password(entryId: string): Promise<string>;
  dispose?(): void;
}

export type ProviderFactory = (config: PasswordManagerConfig) => PasswordManagerProvider;

/** Case- and accent-insensitive order for picker entries: group, then title. */
export function sortEntries(entries: PasswordManagerEntry[]): PasswordManagerEntry[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return entries.sort(
    (a, b) =>
      collator.compare(a.group ?? '', b.group ?? '') ||
      collator.compare(a.title, b.title) ||
      collator.compare(a.username ?? '', b.username ?? ''),
  );
}

/** A password as the programs print it: without the line ending they add. */
export function withoutLineEnding(output: string): string {
  return output.replace(/\r?\n$/, '');
}
