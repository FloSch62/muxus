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
  // One pass: scoring and filtering together, keeping only what survives.
  const matches: Array<{ item: T; index: number; score: number | undefined }> = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (!normalized) {
      if (item.showWhenEmpty) matches.push({ item, index, score: undefined });
      continue;
    }
    const score = scoreItem(item, normalized, tokens);
    if (score !== undefined) matches.push({ item, index, score });
  }
  matches.sort(
    (left, right) =>
      (right.score ?? right.item.priority) -
        (left.score ?? left.item.priority) ||
      left.index - right.index,
  );
  if (matches.length > limit) matches.length = limit;
  return matches.map(({ item }) => item);
}

interface SearchText {
  label: string;
  words: string[];
  searchable: string;
}

/**
 * Normalizing an item costs more than matching it, and the catalog is rebuilt
 * far less often than it is queried — so keep the normalized text alongside
 * each item and let it die with it.
 */
const searchTextCache = new WeakMap<QuickLauncherItem, SearchText>();

function searchText(item: QuickLauncherItem): SearchText {
  const cached = searchTextCache.get(item);
  if (cached) return cached;
  const label = normalize(item.label);
  const text: SearchText = {
    label,
    words: label.split(/\s+/),
    searchable: normalize([item.label, item.detail, ...(item.keywords ?? [])].join(' ')),
  };
  searchTextCache.set(item, text);
  return text;
}

function scoreItem(
  item: QuickLauncherItem,
  query: string,
  tokens: readonly string[],
): number | undefined {
  if (!query) return undefined;
  const { label, words, searchable } = searchText(item);
  if (!tokens.every((token) => searchable.includes(token))) return undefined;

  let relevance = 100;
  if (label === query) relevance = 1_000;
  else if (label.startsWith(query)) relevance = 800;
  else if (words.some((word) => word.startsWith(query))) relevance = 650;
  else if (label.includes(query)) relevance = 500;
  else if (tokens.every((token) => label.includes(token))) relevance = 350;
  return relevance + item.priority;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
