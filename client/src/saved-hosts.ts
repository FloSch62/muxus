import type { SavedHostProfile } from '@muxus/shared';

export function savedHostDisplayName(profile: SavedHostProfile): string {
  return profile.metadata.displayName ?? profile.name;
}

export function savedHostAddress(profile: SavedHostProfile): string {
  return profile.profile.kind === 'telnet'
    ? `${profile.profile.host}:${profile.profile.port}`
    : `${profile.profile.path} · ${profile.profile.baudRate} baud`;
}

/** Match a saved profile against an already normalized needle. */
export function matchesSavedHost(profile: SavedHostProfile, normalized: string): boolean {
  if (!normalized) return true;
  return [
    profile.name,
    profile.metadata.displayName ?? '',
    profile.metadata.group ?? '',
    profile.kind,
    savedHostAddress(profile),
  ].some((value) => value.toLowerCase().includes(normalized));
}

export function filterSavedHosts(
  profiles: readonly SavedHostProfile[],
  query: string,
): SavedHostProfile[] {
  const needle = query.trim().toLowerCase();
  return profiles
    .filter((profile) => matchesSavedHost(profile, needle))
    .sort(
      (a, b) =>
        Number(b.metadata.favorite) - Number(a.metadata.favorite) ||
        savedHostDisplayName(a).localeCompare(savedHostDisplayName(b)),
    );
}
