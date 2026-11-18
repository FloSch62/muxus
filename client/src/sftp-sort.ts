import type { SftpEntry } from '@muxus/shared';

export type SftpSortKey = 'name' | 'size' | 'modified';

/** The column the file browser sorts by. Folders stay above everything else either way. */
export interface SftpSort {
  key: SftpSortKey;
  descending: boolean;
}

export const DEFAULT_SFTP_SORT: SftpSort = { key: 'name', descending: false };

/** A header click: the sorted column reverses; another starts A to Z, or largest and newest first. */
export function nextSftpSort(current: SftpSort, key: SftpSortKey): SftpSort {
  return current.key === key ? { key, descending: !current.descending } : { key, descending: key !== 'name' };
}

// Only files show a size; anything else sorts below an empty file.
function shownSize(entry: SftpEntry): number {
  return entry.type === 'file' ? (entry.size ?? -1) : -1;
}

/** The listing in `sort` order; ties, such as folders by size, go by name A to Z. */
export function sortedSftpEntries(entries: readonly SftpEntry[], sort: SftpSort): SftpEntry[] {
  const direction = sort.descending ? -1 : 1;
  return entries.toSorted((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    if (sort.key === 'name') return direction * a.name.localeCompare(b.name);
    const byColumn =
      sort.key === 'size' ? shownSize(a) - shownSize(b) : (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
    return direction * byColumn || a.name.localeCompare(b.name);
  });
}
