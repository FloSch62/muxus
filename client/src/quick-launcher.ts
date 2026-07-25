export type QuickLauncherKind =
  | 'tab'
  | 'editor'
  | 'host'
  | 'quick-connect'
  | 'workspace'
  | 'command'
  | 'tunnel'
  | 'history'
  | 'action'
  | 'keymap';

export interface QuickLauncherItem {
  id: string;
  kind: QuickLauncherKind;
  label: string;
  detail: string;
  keywords?: readonly string[];
  /** Higher values win when the query matches equally well. */
  priority: number;
  /** Initial suggestions stay deliberately small and task-oriented. */
  showWhenEmpty: boolean;
}

/**
 * Match every whitespace-separated token, then rank exact and prefix matches
 * ahead of metadata-only matches. The generic return type preserves each
 * caller's action payload.
 */
export function selectQuickLauncherItems<T extends QuickLauncherItem>(
  items: readonly T[],
  query: string,
  limit = 40,
): T[] {
  const normalized = normalize(query);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreItem(item, normalized, tokens),
    }))
    .filter(({ item, score }) =>
      normalized ? score !== undefined : item.showWhenEmpty,
    )
    .sort(
      (left, right) =>
        (right.score ?? right.item.priority) -
          (left.score ?? left.item.priority) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

function scoreItem(
  item: QuickLauncherItem,
  query: string,
  tokens: readonly string[],
): number | undefined {
  if (!query) return undefined;
  const label = normalize(item.label);
  const searchable = normalize(
    [item.label, item.detail, ...(item.keywords ?? [])].join(' '),
  );
  if (!tokens.every((token) => searchable.includes(token))) return undefined;

  let relevance = 100;
  if (label === query) relevance = 1_000;
  else if (label.startsWith(query)) relevance = 800;
  else if (label.split(/\s+/).some((word) => word.startsWith(query))) relevance = 650;
  else if (label.includes(query)) relevance = 500;
  else if (tokens.every((token) => label.includes(token))) relevance = 350;
  return relevance + item.priority;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
