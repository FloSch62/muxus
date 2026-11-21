/**
 * How the hosts tab's table is sorted. On its own, free of every other module,
 * because the preferences store validates a saved sort with it.
 */
export const HOSTS_TABLE_COLUMNS = ['name', 'address', 'folder', 'via', 'kind', 'lastUsed'] as const;
export type HostsTableColumn = (typeof HOSTS_TABLE_COLUMNS)[number];

/**
 * `column` absent means arranged by folder, in the sidebar's own order — the
 * only arrangement in which dragging a row can say where it should go.
 */
export interface HostsTableSort {
  column?: HostsTableColumn;
  descending: boolean;
}

export const DEFAULT_HOSTS_TABLE_SORT: HostsTableSort = { descending: false };

export function isHostsTableSort(value: unknown): value is HostsTableSort {
  if (value === null || typeof value !== 'object') return false;
  const sort = value as { column?: unknown; descending?: unknown };
  if (typeof sort.descending !== 'boolean') return false;
  return (
    sort.column === undefined || (HOSTS_TABLE_COLUMNS as readonly unknown[]).includes(sort.column)
  );
}

/** A header click: ascending, then descending, then back to the folder arrangement. */
export function nextHostsTableSort(
  current: HostsTableSort,
  column: HostsTableColumn,
): HostsTableSort {
  if (current.column !== column) return { column, descending: column === 'lastUsed' };
  // Last used starts with the newest, so its second step is the oldest.
  const second = column !== 'lastUsed';
  if (current.descending !== second) return { column, descending: second };
  return DEFAULT_HOSTS_TABLE_SORT;
}
