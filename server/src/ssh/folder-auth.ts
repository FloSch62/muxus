import type { FolderAuthSettings } from '@muxus/shared';
import { folderChain } from '../util/folder-paths.js';
import { folderPasswordAccount, folderPasswordLabel } from '../security/password-vault.js';
import type { OptionLine } from './ssh-config.js';

/** A folder password candidate in the encrypted vault. */
export interface FolderPasswordRef {
  account: string;
  label: string;
}

/** Folder-inherited connection defaults for one dial target. */
export interface FolderAuthDefaults {
  /** Lowest-priority ssh_config option lines; see resolveHost's `fallback`. */
  optionLines: OptionLine[];
  /** Vault password candidates, nearest folder first. */
  passwords: FolderPasswordRef[];
}

export type FolderAuthLookup = (alias: string) => FolderAuthDefaults | undefined;

/** What the resolver needs to know; satisfied by MuxusDatabase. */
export interface FolderAuthSource {
  groupForAlias(alias: string): string | undefined;
  folderSettingsForPath(
    path: string,
  ): { id: string; path: string; auth: FolderAuthSettings } | undefined;
}

/**
 * Per-alias folder defaults for the dial path: the host's folder chain
 * (nearest first) collapses to one set of option lines, and every folder with
 * settings contributes a vault password candidate.
 */
export function folderAuthResolver(source: FolderAuthSource): FolderAuthLookup {
  return (alias) => {
    const group = source.groupForAlias(alias);
    if (!group) return undefined;
    const rows = folderChain(group)
      .map((path) => source.folderSettingsForPath(path))
      .filter((row) => row !== undefined);
    if (rows.length === 0) return undefined;
    return {
      optionLines: folderAuthOptionLines(mergeFolderAuth(rows.map((row) => row.auth))),
      passwords: rows.map((row) => ({
        account: folderPasswordAccount(row.id),
        label: folderPasswordLabel(row.path),
      })),
    };
  };
}

/** Collapse a folder chain (nearest first) so the nearest folder wins per field. */
export function mergeFolderAuth(chain: readonly FolderAuthSettings[]): FolderAuthSettings {
  const merged: FolderAuthSettings = {};
  for (const auth of chain) {
    if (merged.user === undefined && auth.user !== undefined) merged.user = auth.user;
    if (merged.port === undefined && auth.port !== undefined) merged.port = auth.port;
    if (merged.identityFiles === undefined && auth.identityFiles !== undefined) {
      merged.identityFiles = auth.identityFiles;
    }
    if (merged.identitiesOnly === undefined && auth.identitiesOnly !== undefined) {
      merged.identitiesOnly = auth.identitiesOnly;
    }
    if (merged.identityAgent === undefined && auth.identityAgent !== undefined) {
      merged.identityAgent = auth.identityAgent;
    }
    if (merged.forwardAgent === undefined && auth.forwardAgent !== undefined) {
      merged.forwardAgent = auth.forwardAgent;
    }
  }
  return merged;
}

/** Render folder defaults as the option lines resolveHost consumes. */
export function folderAuthOptionLines(auth: FolderAuthSettings): OptionLine[] {
  const lines: OptionLine[] = [];
  const push = (keyword: string, raw: string) =>
    lines.push({
      keyword,
      key: keyword.toLowerCase(),
      // Paths may contain spaces; quote the value the way ssh_config would.
      value: /\s/.test(raw) ? `"${raw}"` : raw,
      args: [raw],
    });
  if (auth.user) push('User', auth.user);
  if (auth.port !== undefined) push('Port', String(auth.port));
  for (const file of auth.identityFiles ?? []) push('IdentityFile', file);
  if (auth.identitiesOnly !== undefined) {
    push('IdentitiesOnly', auth.identitiesOnly ? 'yes' : 'no');
  }
  if (auth.identityAgent) push('IdentityAgent', auth.identityAgent);
  if (auth.forwardAgent !== undefined) {
    push('ForwardAgent', auth.forwardAgent ? 'yes' : 'no');
  }
  return lines;
}
