import {
  connectionLinkTarget,
  type ConnectionLink,
  type SavedHostProfile,
  type SessionProfile,
  type SshHostEntry,
  type WorkspaceSummary,
} from '@muxus/shared';
import { buildHostTree, type ContainerNode } from './host-tree.js';
import {
  groupManagedHosts,
  managedHostKey,
  type ManagedHost,
} from './managed-hosts.js';

export type TargetResolution<T> =
  | { status: 'found'; value: T }
  | { status: 'not-found' }
  | { status: 'ambiguous'; count: number };

export interface ResolvedHostFolder {
  label: string;
  hosts: ManagedHost[];
}

const normalized = (value: string) => value.trim().toLocaleLowerCase();

function resultFor<T>(matches: readonly T[]): TargetResolution<T> {
  if (matches.length === 0) return { status: 'not-found' };
  if (matches.length > 1) return { status: 'ambiguous', count: matches.length };
  return { status: 'found', value: matches[0]! };
}

function uniqueHosts(hosts: readonly ManagedHost[]): ManagedHost[] {
  return [...new Map(hosts.map((host) => [managedHostKey(host), host])).values()];
}

/** Prefer stable aliases/names over user-editable display names. */
export function resolveCommandLineHost(
  name: string,
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
): TargetResolution<ManagedHost> {
  const target = normalized(name);
  const hosts: ManagedHost[] = [
    ...sshHosts.map((entry) => ({ kind: 'ssh' as const, entry })),
    ...savedProfiles.map((entry) => ({ kind: 'profile' as const, entry })),
  ];
  const identityMatches = uniqueHosts(
    hosts.filter((host) =>
      host.kind === 'ssh'
        ? host.entry.aliases.some((alias) => normalized(alias) === target)
        : normalized(host.entry.name) === target || normalized(host.entry.id) === target,
    ),
  );
  if (identityMatches.length > 0) return resultFor(identityMatches);

  return resultFor(
    uniqueHosts(
      hosts.filter((host) =>
        normalized(
          host.kind === 'ssh'
            ? (host.entry.metadata?.displayName ?? '')
            : (host.entry.metadata.displayName ?? ''),
        ) === target,
      ),
    ),
  );
}

function collectHosts(node: ContainerNode): ManagedHost[] {
  const hosts: ManagedHost[] = [];
  const walk = (container: ContainerNode) => {
    for (const child of container.children) {
      if (child.kind === 'host') hosts.push(child.host);
      else if (child.kind === 'folder') walk(child);
    }
  };
  walk(node);
  return hosts;
}

function resolvedFolder(node: ContainerNode): ResolvedHostFolder {
  return {
    label: node.kind === 'folder' ? node.path : node.label,
    hosts: collectHosts(node),
  };
}

/** Resolve a full folder path, unique leaf label, or ssh_config file-group label. */
export function resolveCommandLineFolder(
  name: string,
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
  files: readonly string[],
  rootFile: string | undefined,
): TargetResolution<ResolvedHostFolder> {
  const target = normalized(name);
  const tree = buildHostTree(
    groupManagedHosts(sshHosts, savedProfiles, files, rootFile),
  );
  const folders = [...tree.foldersByKey.values()];

  const pathMatches = folders.filter((folder) => normalized(folder.path) === target);
  if (pathMatches.length > 0) {
    const resolution = resultFor(pathMatches);
    return resolution.status === 'found'
      ? { status: 'found', value: resolvedFolder(resolution.value) }
      : resolution;
  }

  const fileMatches = tree.roots.filter(
    (node) => {
      if (node.kind !== 'file') return false;
      const filename = node.tooltip
        ?.split(/[\\/]/)
        .at(-1)
        ?.replace(/\.(conf|config)$/i, '');
      return (
        normalized(node.label) === target ||
        (!!filename && normalized(filename) === target)
      );
    },
  );
  if (fileMatches.length > 0) {
    const resolution = resultFor(fileMatches);
    return resolution.status === 'found'
      ? { status: 'found', value: resolvedFolder(resolution.value) }
      : resolution;
  }

  const labelResolution = resultFor(
    folders.filter((folder) => normalized(folder.label) === target),
  );
  return labelResolution.status === 'found'
    ? { status: 'found', value: resolvedFolder(labelResolution.value) }
    : labelResolution;
}

export function resolveCommandLineWorkspace(
  name: string,
  workspaces: readonly WorkspaceSummary[],
): TargetResolution<WorkspaceSummary> {
  const target = normalized(name);
  const idMatches = workspaces.filter((workspace) => normalized(workspace.id) === target);
  return idMatches.length > 0
    ? resultFor(idMatches)
    : resultFor(workspaces.filter((workspace) => normalized(workspace.name) === target));
}

/** What an ssh:// or telnet:// link opens. */
export type ConnectionLinkLaunch =
  | { kind: 'host'; host: ManagedHost; profile: SessionProfile }
  | { kind: 'ad-hoc'; profile: SessionProfile; title: string };

interface LinkCandidate {
  host: ManagedHost;
  /** Matched by alias or saved-host name rather than by address. */
  identity: boolean;
  user?: string;
}

const DEFAULT_PORTS = { ssh: 22, telnet: 23 } as const;

function linkCandidates(
  link: ConnectionLink,
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
): LinkCandidate[] {
  const host = normalized(link.host);
  const port = link.port ?? DEFAULT_PORTS[link.scheme];
  const candidates: LinkCandidate[] = [];
  if (link.scheme === 'ssh') {
    for (const entry of sshHosts) {
      const identity = entry.aliases.some((alias) => normalized(alias) === host);
      // An alias keeps working with another user or port, like `ssh -p`.
      if (
        identity ||
        (normalized(entry.resolved.hostname) === host && entry.resolved.port === port)
      ) {
        candidates.push({ host: { kind: 'ssh', entry }, identity, user: entry.resolved.user });
      }
    }
  }
  for (const entry of savedProfiles) {
    const profile = entry.profile;
    if (profile.kind !== link.scheme) continue;
    const address = profile.kind === 'ssh' ? profile.target : profile.kind === 'telnet' ? profile.host : '';
    const savedPort = profile.kind === 'telnet' ? profile.port : profile.kind === 'ssh' ? (profile.port ?? 22) : 0;
    const user = profile.kind === 'ssh' ? profile.user : undefined;
    const identity = normalized(entry.name) === host;
    if (!identity && !(normalized(address) === host && savedPort === port)) continue;
    // A saved Muxus host always dials with its own fields, so a link that asks
    // for another user or port is not that host.
    if (link.port !== undefined && savedPort !== link.port) continue;
    if (link.scheme === 'ssh' && link.user !== undefined && user !== link.user) continue;
    candidates.push({ host: { kind: 'profile', entry }, identity, user });
  }
  return candidates;
}

function linkTitle(link: ConnectionLink): string {
  if (link.scheme === 'ssh') return connectionLinkTarget(link);
  const host = link.host.includes(':') ? `[${link.host}]` : link.host;
  return link.port === undefined || link.port === DEFAULT_PORTS.telnet ? host : `${host}:${link.port}`;
}

/**
 * Open a link with a saved host when it names one: by ssh_config alias or
 * saved-host name first, else by host name and port. Several matches are
 * narrowed by the link's user; a choice that is still ambiguous, or no match
 * at all, connects like quick connect instead of guessing.
 */
export function resolveConnectionLink(
  link: ConnectionLink,
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
): ConnectionLinkLaunch {
  const candidates = linkCandidates(link, sshHosts, savedProfiles);
  const identities = candidates.filter((candidate) => candidate.identity);
  let matches = identities.length > 0 ? identities : candidates;
  if (matches.length > 1 && link.user !== undefined) {
    matches = matches.filter((candidate) => candidate.user === link.user);
  }
  const pin = link.hostKeyFingerprint ? { hostKeyFingerprint: link.hostKeyFingerprint } : {};
  const match = matches.length === 1 ? matches[0]!.host : undefined;
  if (match?.kind === 'profile') {
    return { kind: 'host', host: match, profile: { ...match.entry.profile, profileId: match.entry.id, ...pin } };
  }
  if (match?.kind === 'ssh') {
    // Dialed like `ssh [user@]alias [-p port]`, so the link's user and port
    // win; a plain alias keeps the tab recognisable as that host.
    const { resolved } = match.entry;
    const alias = match.entry.aliases.find((candidate) => normalized(candidate) === normalized(link.host));
    const target = connectionLinkTarget({
      scheme: 'ssh',
      host: alias ?? match.entry.alias,
      ...(link.user !== undefined && link.user !== resolved.user ? { user: link.user } : {}),
      ...(link.port !== undefined && link.port !== resolved.port ? { port: link.port } : {}),
    });
    return { kind: 'host', host: match, profile: { kind: 'ssh', target, ...pin } };
  }
  if (link.scheme === 'telnet') {
    return {
      kind: 'ad-hoc',
      profile: { kind: 'telnet', host: link.host, port: link.port ?? DEFAULT_PORTS.telnet },
      title: linkTitle(link),
    };
  }
  return {
    kind: 'ad-hoc',
    profile: { kind: 'ssh', target: connectionLinkTarget(link), ...pin },
    title: linkTitle(link),
  };
}
