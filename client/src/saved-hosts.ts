import { savedHostHopId, type SavedHostProfile } from '@muxus/shared';
import { matchesTokens, searchableText, searchTokens } from './host-search.js';

export function savedHostDisplayName(profile: SavedHostProfile): string {
  return profile.metadata.displayName ?? profile.name;
}

/** How a ProxyJump hop reads in the UI: saved Muxus hosts by name, others as written. */
export function jumpHopLabel(
  hop: string,
  profiles: readonly SavedHostProfile[] | undefined,
): string {
  const id = savedHostHopId(hop);
  if (id === undefined) return hop;
  const profile = profiles?.find((candidate) => candidate.id === id);
  return profile ? savedHostDisplayName(profile) : 'Deleted Muxus host';
}

/**
 * Spell a jump list the way OpenSSH understands it. ssh cannot look up a saved
 * Muxus host, so each one becomes the alias it is exported under or, without
 * one, `user@host:port` preceded by its own jump hosts. A key cannot travel
 * in a -J list, so outside an export this is best effort.
 */
export function openSshJumpHops(
  hops: readonly string[],
  profiles: readonly SavedHostProfile[],
  exportedAlias?: (profileId: string) => string | undefined,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  return hops.flatMap((hop) => {
    const id = savedHostHopId(hop);
    if (id === undefined) return [hop];
    const alias = exportedAlias?.(id);
    if (alias) return [alias];
    const saved = profiles.find((candidate) => candidate.id === id)?.profile;
    if (saved?.kind !== 'ssh' || seen.has(id)) return [];
    const host = saved.port && saved.target.includes(':') ? `[${saved.target}]` : saved.target;
    const address = `${saved.user ? `${saved.user}@` : ''}${host}${saved.port ? `:${saved.port}` : ''}`;
    return [
      ...openSshJumpHops(saved.proxyJump ?? [], profiles, exportedAlias, new Set([...seen, id])),
      address,
    ];
  });
}

export function savedHostAddress(profile: SavedHostProfile): string {
  const connection = profile.profile;
  if (connection.kind === 'ssh') {
    const target = connection.user
      ? `${connection.user}@${connection.target}`
      : connection.target;
    return connection.port && connection.port !== 22
      ? `${target}:${connection.port}`
      : target;
  }
  if (
    connection.kind === 'rdp' ||
    connection.kind === 'vnc' ||
    connection.kind === 'gnmi' ||
    connection.kind === 'netconf'
  ) {
    const address = connection.username
      ? `${connection.username}@${connection.host}:${connection.port}`
      : `${connection.host}:${connection.port}`;
    return connection.sshGateway ? `${address} via ${connection.sshGateway.target}` : address;
  }
  return connection.kind === 'telnet'
    ? `${connection.host}:${connection.port}`
    : `${connection.path} · ${connection.baudRate} baud`;
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
    .sort((a, b) => savedHostDisplayName(a).localeCompare(savedHostDisplayName(b)));
}
