import type {
  ManagedHostRef,
  SavedHostProfile,
  SshHostEntry,
  SshProfile,
} from '@muxus/shared';
import {
  groupHosts,
  hostAddress,
  hostDisplayName,
  hostSearchText,
  type HostGroup,
} from './host-organization.js';
import { matchScore, searchTokens } from './host-search.js';
import {
  filterSavedHosts,
  savedHostAddress,
  savedHostDisplayName,
  savedHostSearchText,
} from './saved-hosts.js';

export type ManagedHost =
  | { kind: 'ssh'; entry: SshHostEntry }
  | { kind: 'profile'; entry: SavedHostProfile };

export interface ManagedHostGroup
  extends Omit<HostGroup, 'hosts'> {
  hosts: ManagedHost[];
}

/** Build one host hierarchy independent of the underlying connection protocol. */
export function groupManagedHosts(
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
  files: readonly string[],
  rootFile: string | undefined,
  filter = '',
): ManagedHostGroup[] {
  const profiles = filterSavedHosts(savedProfiles, filter);
  const hasSavedCustomGroups = profiles.some(
    (profile) => !!profile.metadata.group?.trim(),
  );
  const sshGroups = groupHosts(
    sshHosts,
    files,
    rootFile,
    filter,
    hasSavedCustomGroups,
  );
  const groups: ManagedHostGroup[] = sshGroups.map((group) => ({
    ...group,
    hosts: group.hosts.map((entry) => ({ kind: 'ssh' as const, entry })),
  }));
  const customByKey = new Map(
    groups
      .filter((group) => group.kind === 'custom')
      .map((group) => [group.key, group]),
  );
  const ungrouped: SavedHostProfile[] = [];

  for (const profile of profiles) {
    const label = profile.metadata.group?.trim();
    if (!label) {
      ungrouped.push(profile);
      continue;
    }
    const key = `custom:${label.toLocaleLowerCase()}`;
    let group = customByKey.get(key);
    if (!group) {
      group = {
        key,
        label,
        kind: 'custom',
        hosts: [],
      };
      groups.push(group);
      customByKey.set(key, group);
    }
    group.hosts.push({ kind: 'profile', entry: profile });
  }

  if (ungrouped.length > 0) {
    let group = rootFile
      ? groups.find((candidate) => candidate.key === `file:${rootFile}`)
      : undefined;
    if (!group) {
      group = {
        key: 'managed:ungrouped',
        label: customByKey.size > 0 ? 'Ungrouped' : 'Hosts',
        kind: 'file',
        hosts: [],
      };
      const firstFile = groups.findIndex((candidate) => candidate.kind === 'file');
      groups.splice(firstFile < 0 ? groups.length : firstFile, 0, group);
    }
    // A mixed group is no longer sourced solely from one ssh_config file.
    group.tooltip = undefined;
    group.hosts.push(
      ...ungrouped.map((entry) => ({ kind: 'profile' as const, entry })),
    );
  }

  for (const group of groups) group.hosts.sort(compareManagedHosts);
  const customGroups = groups
    .filter((group) => group.kind === 'custom')
    .sort((a, b) => a.label.localeCompare(b.label));
  const fileGroups = groups.filter((group) => group.kind === 'file');
  return [...customGroups, ...fileGroups];
}

/**
 * The host a query is most likely spelling out: what Enter connects to, and
 * what the sidebar highlights so you can see it before pressing it. Ties keep
 * the caller's order, leaving the tree's own arrangement to break them.
 *
 * Scoring the flat list beats grouping it: quick-connect has to answer for the
 * text as typed, on every keystroke.
 */
export function bestManagedHostMatch(
  hosts: readonly ManagedHost[],
  normalizedQuery: string,
): ManagedHost | undefined {
  const tokens = searchTokens(normalizedQuery);
  if (tokens.length === 0) return undefined;
  let best: ManagedHost | undefined;
  let bestScore = 0;
  for (const host of hosts) {
    const searchable =
      host.kind === 'ssh' ? hostSearchText(host.entry) : savedHostSearchText(host.entry);
    const score = matchScore(
      managedHostDisplayName(host).toLowerCase(),
      searchable,
      normalizedQuery,
      tokens,
    );
    if (score === undefined) continue;
    if (score > bestScore) {
      best = host;
      bestScore = score;
    }
  }
  return best;
}

/** Every Muxus group label in use, across both host sources, for pickers. */
export function knownHostGroups(
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
): string[] {
  return [
    ...new Set(
      [
        ...sshHosts.map((host) => host.metadata?.group),
        ...savedProfiles.map((profile) => profile.metadata.group),
      ].filter((value): value is string => !!value),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function managedHostDisplayName(host: ManagedHost): string {
  return host.kind === 'ssh'
    ? hostDisplayName(host.entry)
    : savedHostDisplayName(host.entry);
}

export function managedHostAddress(host: ManagedHost): string {
  return host.kind === 'ssh' ? hostAddress(host.entry) : savedHostAddress(host.entry);
}

export function managedHostRef(host: ManagedHost): ManagedHostRef {
  return host.kind === 'ssh'
    ? { kind: 'ssh', alias: host.entry.alias }
    : { kind: 'profile', id: host.entry.id };
}

export function managedHostRefKey(ref: ManagedHostRef): string {
  return ref.kind === 'ssh' ? `ssh:${ref.alias}` : `profile:${ref.id}`;
}

/** Stable identity used for list keys, drag state, and reorder payloads. */
export function managedHostKey(host: ManagedHost): string {
  return managedHostRefKey(managedHostRef(host));
}

/** The per-kind clipboard action offered in the host context menu. */
export function managedHostCopyCommand(host: ManagedHost): { label: string; text: string } {
  if (host.kind === 'ssh') {
    return { label: 'Copy ssh command', text: `ssh ${host.entry.alias}` };
  }
  const profile = host.entry.profile;
  if (profile.kind === 'ssh') {
    return {
      label: 'Copy ssh command',
      text: savedSshCopyCommand(profile),
    };
  }
  return profile.kind === 'telnet'
    ? { label: 'Copy telnet command', text: `telnet ${profile.host} ${profile.port}` }
    : { label: 'Copy device path', text: profile.path };
}

/** Render a self-contained profile as a pasteable OpenSSH command. */
function savedSshCopyCommand(profile: SshProfile): string {
  const args = ['ssh'];
  if (profile.port) args.push('-p', String(profile.port));
  for (const file of profile.identityFiles ?? []) args.push('-i', file);
  for (const file of profile.certificateFiles ?? []) {
    args.push('-o', `CertificateFile=${file}`);
  }
  if (profile.identitiesOnly !== undefined) {
    args.push('-o', `IdentitiesOnly=${profile.identitiesOnly ? 'yes' : 'no'}`);
  }
  if (profile.identityAgent) {
    args.push('-o', `IdentityAgent=${profile.identityAgent}`);
  }
  if (profile.forwardAgent) args.push('-A');
  if (profile.proxyJump?.length) args.push('-J', profile.proxyJump.join(','));
  if (profile.proxyCommand) {
    args.push('-o', `ProxyCommand=${profile.proxyCommand}`);
  }
  if (profile.passwordOnly) {
    args.push(
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'PreferredAuthentications=keyboard-interactive,password',
    );
  }
  for (const forward of profile.forwards ?? []) {
    if (forward.type === 'dynamic') {
      args.push('-D', String(forward.bindPort));
      continue;
    }
    const option = forward.type === 'local' ? '-L' : '-R';
    args.push(
      option,
      `${forward.bindPort}:${forward.targetHost}:${forward.targetPort}`,
    );
  }
  if (profile.requestTty === 'no') args.push('-T');
  if (profile.requestTty === 'yes') args.push('-t');
  if (profile.requestTty === 'force') args.push('-tt');
  if (profile.requestTty === 'auto') args.push('-o', 'RequestTTY=auto');
  if (profile.strictHostKeyChecking) {
    args.push(
      '-o',
      `StrictHostKeyChecking=${profile.strictHostKeyChecking}`,
    );
  }
  args.push(profile.user ? `${profile.user}@${profile.target}` : profile.target);
  if (profile.remoteCommand) args.push(profile.remoteCommand);
  return args.map(shellArgument).join(' ');
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function compareManagedHosts(a: ManagedHost, b: ManagedHost): number {
  const aMetadata = a.entry.metadata;
  const bMetadata = b.entry.metadata;
  return (
    (aMetadata?.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (bMetadata?.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
    managedHostDisplayName(a).localeCompare(managedHostDisplayName(b))
  );
}
