import type { SavedHostProfile } from '@muxus/shared';
import { matchesTokens, searchableText, searchTokens } from './host-search.js';

export function savedHostDisplayName(profile: SavedHostProfile): string {
  return profile.metadata.displayName ?? profile.name;
}

export function savedHostAddress(profile: SavedHostProfile): string {
  return profile.profile.kind === 'telnet'
    ? `${profile.profile.host}:${profile.profile.port}`
    : `${profile.profile.path} · ${profile.profile.baudRate} baud`;
}

/** Everything a search may look at, lower-cased once per profile. */
export function savedHostSearchText(profile: SavedHostProfile): string {
  return searchableText(profile, () => [
    profile.name,
    profile.metadata.displayName,
    profile.metadata.group,
    profile.kind,
    savedHostAddress(profile),
  ]);
}

/** Match a saved profile against tokens the caller split once. */
export function matchesSavedHost(
  profile: SavedHostProfile,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return true;
  return matchesTokens(savedHostSearchText(profile), tokens);
}

export function filterSavedHosts(
  profiles: readonly SavedHostProfile[],
  query: string,
): SavedHostProfile[] {
  const tokens = searchTokens(query.trim().toLowerCase());
  return profiles
    .filter((profile) => matchesSavedHost(profile, tokens))
    .sort(
      (a, b) =>
        Number(b.metadata.favorite) - Number(a.metadata.favorite) ||
        savedHostDisplayName(a).localeCompare(savedHostDisplayName(b)),
    );
}
