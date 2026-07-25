import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';
import {
  knownHostGroups,
  managedHostKey,
  type ManagedHost,
  type ManagedHostGroup,
} from './managed-hosts.js';

/**
 * Folders are not a separate record type: a host's Muxus group string *is* its
 * folder path, with `/` between levels. Nesting therefore needs no schema
 * change, no new endpoint, and no migration — `Production/EU/Edge` is just a
 * group name that this module knows how to read as three levels.
 */
export const FOLDER_SEPARATOR = '/';

/** Deeper than this and the path stops being a useful organizational tool. */
export const MAX_FOLDER_DEPTH = 8;

/** Mirrors the server's `group` cap so the UI can refuse before the round trip. */
export const MAX_GROUP_PATH = 300;

/** How far rows keep indenting; deeper folders render at this level. */
export const MAX_INDENT_DEPTH = 5;

/** Stands in for "no parent" when keying the top level's manual order. */
export const TREE_ROOT_KEY = 'root';

export interface FolderNode {
  kind: 'folder';
  /** `folder:production/eu` — lowercased, so casing edits keep their identity. */
  key: string;
  /** Canonical display path, e.g. `Production/EU`. */
  path: string;
  /** Last segment only. */
  label: string;
  depth: number;
  parentKey?: string;
  children: TreeNode[];
  descendantHostCount: number;
  /** No host anywhere below — the folder exists only because prefs remember it. */
  empty: boolean;
}

export interface HostNode {
  kind: 'host';
  key: string;
  host: ManagedHost;
  depth: number;
  parentKey: string;
}

/**
 * A group that came from an ssh_config file rather than a Muxus group. These
 * stay flat and read-only: their membership is decided by the config file, not
 * by anything the user can drag.
 */
export interface FileGroupNode {
  kind: 'file';
  key: string;
  label: string;
  tooltip?: string;
  depth: 0;
  children: HostNode[];
  descendantHostCount: number;
}

export type TreeNode = FolderNode | HostNode | FileGroupNode;
export type ContainerNode = FolderNode | FileGroupNode;

export interface HostTree {
  /** Custom folders first, ssh_config file groups pinned last. */
  roots: ContainerNode[];
  foldersByKey: Map<string, FolderNode>;
  /** Every host in the tree, in render order. */
  hosts: ManagedHost[];
}

/**
 * Split a stored group string into folder segments. Leading, trailing and
 * doubled separators collapse, and each segment is trimmed — normalization
 * happens on read so no stored value ever has to be rewritten.
 */
export function folderSegments(group: string | null | undefined): string[] {
  if (!group) return [];
  return group
    .split(FOLDER_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The canonical stored form of a group string; '' means "no folder". */
export function normalizeGroupPath(group: string | null | undefined): string {
  return folderSegments(group).join(FOLDER_SEPARATOR);
}

/** A folder name is a single segment, so the separator can never appear in one. */
export function sanitizeFolderName(name: string): string {
  return name.split(FOLDER_SEPARATOR).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Identity of a folder, case-insensitive per segment — the same rule the flat
 * groups already used, applied at every level.
 */
export function folderKey(path: string): string {
  return `folder:${folderSegments(path)
    .map((segment) => segment.toLocaleLowerCase())
    .join(FOLDER_SEPARATOR)}`;
}

export function folderPath(segments: readonly string[]): string {
  return segments.join(FOLDER_SEPARATOR);
}

/** '' for a top-level folder. */
export function folderParentPath(path: string): string {
  const segments = folderSegments(path);
  return folderPath(segments.slice(0, -1));
}

export function folderLabel(path: string): string {
  const segments = folderSegments(path);
  return segments[segments.length - 1] ?? '';
}

export function folderDepth(path: string): number {
  return folderSegments(path).length;
}

/**
 * Segment-aware ancestry. `Production` is not inside `Prod` — comparing the raw
 * strings with startsWith would say otherwise and quietly move the wrong hosts.
 */
export function isDescendantPath(candidate: string, ancestor: string): boolean {
  const parent = folderSegments(ancestor);
  const child = folderSegments(candidate);
  if (parent.length === 0 || child.length <= parent.length) return false;
  return parent.every(
    (segment, index) => segment.toLocaleLowerCase() === child[index]?.toLocaleLowerCase(),
  );
}

export function isSamePath(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b);
}

/** The path `hostPath` ends up at when the folder `from` is renamed to `to`. */
export function renameFolderPath(hostPath: string, from: string, to: string): string | undefined {
  if (isSamePath(hostPath, from)) return normalizeGroupPath(to);
  if (!isDescendantPath(hostPath, from)) return undefined;
  const tail = folderSegments(hostPath).slice(folderDepth(from));
  return folderPath([...folderSegments(to), ...tail]);
}

/** Re-parenting a folder is a rename to `<newParent>/<its own name>`. */
export function moveFolderPath(path: string, newParentPath: string): string {
  return folderPath([...folderSegments(newParentPath), folderLabel(path)]);
}

/** Every ancestor of a path, outermost first, excluding the path itself. */
export function ancestorPaths(path: string): string[] {
  const segments = folderSegments(path);
  return segments.slice(0, -1).map((_segment, index) => folderPath(segments.slice(0, index + 1)));
}

/**
 * Re-parent the flat groups `groupManagedHosts` produced into a folder tree.
 *
 * Only `custom` groups nest; ssh_config file groups keep their existing flat,
 * read-only shape and are pinned below every folder. Intermediate folders are
 * synthesized, so a lone `A/B/C` still yields navigable `A` and `A/B` levels.
 */
export function buildHostTree(
  groups: readonly ManagedHostGroup[],
  options: {
    knownFolders?: readonly string[];
    /** Manual sibling order for a parent, innermost-first by folder key. */
    folderOrder?: (parentKey: string) => readonly string[] | undefined;
  } = {},
): HostTree {
  const foldersByKey = new Map<string, FolderNode>();
  const rootFolders: FolderNode[] = [];

  /** Create the folder and every missing ancestor; first writer fixes casing. */
  const ensureFolder = (path: string): FolderNode | undefined => {
    const segments = folderSegments(path);
    if (segments.length === 0) return undefined;
    let parent: FolderNode | undefined;
    for (let depth = 0; depth < segments.length; depth++) {
      const currentPath = folderPath(segments.slice(0, depth + 1));
      const key = folderKey(currentPath);
      let node = foldersByKey.get(key);
      if (!node) {
        node = {
          kind: 'folder',
          key,
          path: parent ? `${parent.path}${FOLDER_SEPARATOR}${segments[depth]}` : segments[depth]!,
          label: segments[depth]!,
          depth,
          parentKey: parent?.key,
          children: [],
          descendantHostCount: 0,
          empty: true,
        };
        foldersByKey.set(key, node);
        if (parent) parent.children.push(node);
        else rootFolders.push(node);
      }
      parent = node;
    }
    return parent;
  };

  // Folders are created in sorted path order so the label a case-insensitive
  // collision settles on never depends on the order hosts arrived in.
  const customGroups = groups.filter((group) => group.kind === 'custom');
  const declaredPaths = [
    ...customGroups.map((group) => group.label),
    ...(options.knownFolders ?? []),
  ]
    .map(normalizeGroupPath)
    .filter((path) => path.length > 0)
    .sort((a, b) => a.localeCompare(b));
  for (const path of declaredPaths) ensureFolder(path);

  for (const group of customGroups) {
    const folder = ensureFolder(group.label);
    if (!folder) continue;
    for (const host of group.hosts) {
      folder.children.push({
        kind: 'host',
        key: managedHostKey(host),
        host,
        depth: folder.depth + 1,
        parentKey: folder.key,
      });
    }
  }

  const fileGroups: FileGroupNode[] = groups
    .filter((group) => group.kind === 'file')
    .map((group) => ({
      kind: 'file' as const,
      key: group.key,
      label: group.label,
      tooltip: group.tooltip,
      depth: 0 as const,
      descendantHostCount: group.hosts.length,
      children: group.hosts.map((host) => ({
        kind: 'host' as const,
        key: managedHostKey(host),
        host,
        depth: 1,
        parentKey: group.key,
      })),
    }));

  const rankIn = (parentKey: string) => {
    const order = options.folderOrder?.(parentKey);
    if (!order || order.length === 0) return undefined;
    return new Map(order.map((key, index) => [key, index]));
  };
  for (const folder of rootFolders) finalizeFolder(folder, rankIn);
  sortFolders(rootFolders, rankIn(TREE_ROOT_KEY));

  const roots: ContainerNode[] = [...rootFolders, ...fileGroups];
  const hosts: ManagedHost[] = [];
  const collect = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'host') hosts.push(node.host);
      else collect(node.children);
    }
  };
  collect(roots);

  return { roots, foldersByKey, hosts };
}

type RankLookup = (parentKey: string) => Map<string, number> | undefined;

/** Sort children and roll host counts up, depth-first. */
function finalizeFolder(folder: FolderNode, rankIn: RankLookup): number {
  let count = 0;
  for (const child of folder.children) {
    if (child.kind === 'folder') count += finalizeFolder(child, rankIn);
    else count += 1;
  }
  // Folders sort before hosts; hosts keep the order groupManagedHosts settled
  // (sortOrder → favorite → name), so the sortOrder column keeps working.
  const folders = folder.children.filter((child) => child.kind === 'folder');
  const rest = folder.children.filter((child) => child.kind !== 'folder');
  sortFolders(folders, rankIn(folder.key));
  folder.children = [...folders, ...rest];
  folder.descendantHostCount = count;
  folder.empty = count === 0;
  return count;
}

/**
 * Manual order first, then alphabetical for anything the user has not placed —
 * the same rule hosts follow with `sortOrder`, so a folder a user dragged stays
 * put while a newly created sibling still lands somewhere predictable.
 */
function sortFolders(folders: FolderNode[], rank: Map<string, number> | undefined): void {
  folders.sort(
    (a, b) =>
      (rank?.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
        (rank?.get(b.key) ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label),
  );
}

export interface VisibleNode {
  node: TreeNode;
  key: string;
  depth: number;
  /** aria-level is 1-based. */
  level: number;
  posInSet: number;
  setSize: number;
  /** Undefined for hosts — a leaf must not carry aria-expanded at all. */
  expanded?: boolean;
  /** Colour of the nearest coloured ancestor folder, for the indent rail. */
  railColor?: string;
  /** Ancestor folder keys, outermost first; one indent guide per entry. */
  ancestors: string[];
}

/**
 * The whole visible list, flattened once. Rendering, arrow-key navigation,
 * type-ahead and drop hit-testing all read this single array, so they can never
 * disagree about what is on screen.
 */
export function flattenVisibleTree(
  tree: HostTree,
  isExpanded: (key: string) => boolean,
  folderColor: (key: string) => string | undefined = () => undefined,
): VisibleNode[] {
  const out: VisibleNode[] = [];

  const walk = (
    nodes: readonly TreeNode[],
    depth: number,
    ancestors: string[],
    inheritedColor: string | undefined,
  ) => {
    nodes.forEach((node, index) => {
      const ownColor = node.kind === 'folder' ? folderColor(node.key) : undefined;
      const railColor = ownColor ?? inheritedColor;
      const expanded = node.kind === 'host' ? undefined : isExpanded(node.key);
      out.push({
        node,
        key: node.key,
        depth,
        level: depth + 1,
        posInSet: index + 1,
        setSize: nodes.length,
        expanded,
        railColor,
        ancestors,
      });
      if (node.kind !== 'host' && expanded && node.children.length > 0) {
        walk(node.children, depth + 1, [...ancestors, node.key], railColor);
      }
    });
  };

  walk(tree.roots, 0, [], undefined);
  return out;
}

/** Sibling host keys of a container, in render order — what reordering acts on. */
export function siblingHostKeys(node: ContainerNode): string[] {
  return node.children.flatMap((child) => (child.kind === 'host' ? [child.key] : []));
}

/** Sibling folder keys of a container, in render order. */
export function siblingFolderKeys(node: ContainerNode): string[] {
  return node.children.flatMap((child) => (child.kind === 'folder' ? [child.key] : []));
}

/** Top-level folder keys, in render order; file groups are never reordered. */
export function rootFolderKeys(tree: HostTree): string[] {
  return tree.roots.flatMap((root) => (root.kind === 'folder' ? [root.key] : []));
}

/**
 * Where a folder sits among its siblings, and under which order key. Top-level
 * folders report `TREE_ROOT_KEY`, so callers never special-case the root.
 */
export function folderSiblings(
  tree: HostTree,
  key: string,
): { parentKey: string; keys: string[] } | undefined {
  const folder = tree.foldersByKey.get(key);
  if (!folder) return undefined;
  if (!folder.parentKey) return { parentKey: TREE_ROOT_KEY, keys: rootFolderKeys(tree) };
  const parent = tree.foldersByKey.get(folder.parentKey);
  return parent
    ? { parentKey: parent.key, keys: siblingFolderKeys(parent) }
    : undefined;
}

/** The order key a folder's children are stored under. */
export function orderKeyForParent(parent: FolderNode | undefined): string {
  return parent ? parent.key : TREE_ROOT_KEY;
}

/**
 * Every folder path in use plus each of its ancestors, for pickers.
 *
 * Deeper paths are rebuilt from the casing their ancestors already settled on,
 * so a picker never offers `production/eu` and `Production/EU/Edge` side by
 * side. Sorting the input first makes the winning casing independent of the
 * order the caller happened to collect paths in.
 */
export function expandFolderPaths(paths: Iterable<string>): string[] {
  const canonical = new Map<string, string>();
  const sorted = [...paths]
    .map(normalizeGroupPath)
    .filter((path) => path.length > 0)
    .sort((a, b) => a.localeCompare(b));
  for (const path of sorted) {
    let prefix = '';
    for (const segment of folderSegments(path)) {
      const candidate = prefix ? `${prefix}${FOLDER_SEPARATOR}${segment}` : segment;
      const key = folderKey(candidate);
      const existing = canonical.get(key);
      if (existing) {
        prefix = existing;
      } else {
        canonical.set(key, candidate);
        prefix = candidate;
      }
    }
  }
  return [...canonical.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Every folder path a picker should offer: the groups in use, each of their
 * ancestors, and any folder the user created that holds no host yet. Offering
 * only leaf paths would make `Production` unreachable the moment its last host
 * moved down into `Production/EU`.
 */
export function knownFolderPaths(
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
  extraPaths: readonly string[] = [],
): string[] {
  return expandFolderPaths([...knownHostGroups(sshHosts, savedProfiles), ...extraPaths]);
}
