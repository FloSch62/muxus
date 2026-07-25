/**
 * Shared text matching for host lists. Every query is split into whitespace
 * separated tokens that each have to appear somewhere in the host's searchable
 * text, so "af tail" finds `MyAirframe1Tail` in the `AF-Tails` folder — the
 * same rule the quick launcher already uses for its catalog.
 */

/** Split an already normalized (trimmed, lower-cased) query into tokens. */
export function searchTokens(normalized: string): string[] {
  return normalized.split(/\s+/).filter(Boolean);
}

export function matchesTokens(searchable: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => searchable.includes(token));
}

/**
 * How well a host answers the query, or `undefined` when it does not. Exact and
 * prefix hits on the name beat hits that only landed in the address, the
 * description or the folder, so Enter picks the host you were spelling out.
 */
export function matchScore(
  label: string,
  searchable: string,
  query: string,
  tokens: readonly string[],
): number | undefined {
  if (!matchesTokens(searchable, tokens)) return undefined;
  if (label === query) return 1_000;
  if (label.startsWith(query)) return 800;
  if (label.includes(query)) return 500;
  if (matchesTokens(label, tokens)) return 350;
  return 100;
}

/**
 * Normalizing a host costs more than matching it, and the list is queried on
 * every keystroke but rebuilt only when the config changes — so keep the
 * lower-cased text alongside the entry and let it die with it.
 */
const searchTextCache = new WeakMap<object, string>();

export function searchableText(
  entry: object,
  fields: () => readonly (string | undefined)[],
): string {
  const cached = searchTextCache.get(entry);
  if (cached !== undefined) return cached;
  const text = fields()
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  searchTextCache.set(entry, text);
  return text;
}
