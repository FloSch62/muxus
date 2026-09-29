import type {
  SavedHostProfile,
  SshHostEntry,
  WorkspaceSummary,
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
