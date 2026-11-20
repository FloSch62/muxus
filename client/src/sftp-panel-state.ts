import type { SftpEntry } from '@muxus/shared';

/** Choose the terminal directory only while the attached browser is following it. */
export function initialSftpPath(
  initialPath: string,
  terminalPath: string | undefined,
  followTerminalFolder: boolean,
): string {
  return followTerminalFolder && terminalPath ? terminalPath : initialPath;
}

/** The rows on show: dotfiles only when asked for, and names containing `filter`, ignoring case. */
export function visibleSftpEntries(
  entries: readonly SftpEntry[],
  showHidden: boolean,
  filter: string,
): SftpEntry[] {
  const needle = filter.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (showHidden || !entry.name.startsWith('.')) && entry.name.toLowerCase().includes(needle),
  );
}

/**
 * What the listing says once no row is on show, so a filter or hidden files
 * never pass for an empty folder; any name still matching is then hidden.
 */
export function emptySftpListingLabel(entries: readonly SftpEntry[], filter: string): string {
  if (entries.length === 0) return 'Empty directory';
  if (visibleSftpEntries(entries, true, filter).length === 0) return 'No files match';
  return filter.trim() ? 'Only hidden files match' : 'Only hidden files';
}
