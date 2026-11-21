import {
  folderKey,
  folderSegments,
  isDescendantPath,
  isSamePath,
  type ContainerNode,
  type FileGroupNode,
  type FolderNode,
  type HostNode,
  type HostTree,
  type TreeNode,
} from './host-tree.js';
import {
  HOST_KIND_LABELS,
  calendarDaysBetween,
  lastConnectedTime,
  managedHostKind,
  type HostKind,
} from './hosts-table.js';
import { managedHostDisplayName, managedHostKey, type ManagedHost } from './managed-hosts.js';
import type { SidebarHostGrouping } from './state/prefs.js';

/**
 * The sidebar's other two ways of laying the hosts out, next to the folder
 * tree: one flat list cut into sections, and one folder at a time.
 *
 * Both are expressed as a host tree of their own — sections are read-only
 * groups, exactly like the ssh_config file groups — so the one tree component
 * renders, navigates, selects and windows all three views the same way.
 */

/** Section keys never collide with folder (`folder:`) or file group keys. */
export const SECTION_KEY_PREFIX = 'section:';

export function isSectionKey(key: string): boolean {
  return key.startsWith(SECTION_KEY_PREFIX);
}

export type RecencyBucket = 'open' | 'today' | 'week' | 'month' | 'earlier' | 'never';

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  open: 'Open now',
  today: 'Today',
  week: 'This week',
  month: 'This month',
  earlier: 'Earlier',
  never: 'Not connected yet',
};

const RECENCY_ORDER: readonly RecencyBucket[] = ['open', 'today', 'week', 'month', 'earlier', 'never'];

/** Which stretch of time a host was last connected in, by calendar day. */
export function recencyBucket(
  lastConnected: number | undefined,
  now: number,
): Exclude<RecencyBucket, 'open'> {
  if (lastConnected === undefined) return 'never';
  const days = calendarDaysBetween(lastConnected, now);
  if (days <= 0) return 'today';
  if (days < 7) return 'week';
  if (days < 31) return 'month';
  return 'earlier';
}

const compareNames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

function byName(a: ManagedHost, b: ManagedHost): number {
  return compareNames(managedHostDisplayName(a), managedHostDisplayName(b));
}

/** Every host below `nodes` with the container it really lives in, in tree order. */
function hostNodesOf(nodes: readonly TreeNode[]): HostNode[] {
  return nodes.flatMap((node) => (node.kind === 'host' ? [node] : hostNodesOf(node.children)));
}

function section(id: string, label: string, hosts: readonly HostNode[]): FileGroupNode {
  return {
    kind: 'file',
    key: `${SECTION_KEY_PREFIX}${id}`,
    label,
    depth: 0,
    descendantHostCount: hosts.length,
    // The hosts keep the key of the container they are really filed in, so a
    // drag out of a section still knows where the host comes from.
    children: hosts.map((node) => ({ ...node, depth: 1 })),
  };
}

/** A view over `tree`: other rows, the same folders, and the hosts its sections list. */
function viewTree(tree: HostTree, roots: ContainerNode[], nodes: readonly HostNode[]): HostTree {
  return { roots, foldersByKey: tree.foldersByKey, hosts: nodes.map((node) => node.host) };
}

export interface HostListOptions {
  grouping: SidebarHostGrouping;
  /** Hosts with a live session, by managed host key. */
  liveKeys: ReadonlySet<string>;
  now: number;
}

/**
 * Every host of `tree` as one flat list in sections. Recent groups by when a
 * host was last connected, newest first inside each stretch; name is a single
 * alphabetical run; kind groups by how the host connects.
 */
export function buildHostListTree(tree: HostTree, options: HostListOptions): HostTree {
  const nodes = hostNodesOf(tree.roots);
  if (options.grouping === 'name') {
    const sorted = nodes.toSorted((a, b) => byName(a.host, b.host));
    return viewTree(tree, sorted.length > 0 ? [section('name', 'All hosts', sorted)] : [], sorted);
  }

  if (options.grouping === 'kind') {
    const byKind = new Map<HostKind, HostNode[]>();
    for (const node of nodes) {
      const kind = managedHostKind(node.host);
      const list = byKind.get(kind);
      if (list) list.push(node);
      else byKind.set(kind, [node]);
    }
    const kinds = (Object.keys(HOST_KIND_LABELS) as HostKind[]).filter((kind) => byKind.has(kind));
    return viewTree(
      tree,
      kinds.map((kind) =>
        section(
          `kind:${kind}`,
          HOST_KIND_LABELS[kind],
          byKind.get(kind)!.toSorted((a, b) => byName(a.host, b.host)),
        ),
      ),
      nodes,
    );
  }

  const buckets = new Map<RecencyBucket, { node: HostNode; time: number }[]>();
  for (const node of nodes) {
    const time = lastConnectedTime(node.host);
    const bucket = options.liveKeys.has(node.key) ? 'open' : recencyBucket(time, options.now);
    const entry = { node, time: time ?? 0 };
    const list = buckets.get(bucket);
    if (list) list.push(entry);
    else buckets.set(bucket, [entry]);
  }
  return viewTree(
    tree,
    RECENCY_ORDER.filter((bucket) => buckets.has(bucket)).map((bucket) =>
      section(
        `recent:${bucket}`,
        RECENCY_LABELS[bucket],
        buckets
          .get(bucket)!
          .toSorted((a, b) => b.time - a.time || byName(a.node.host, b.node.host))
          .map((entry) => entry.node),
      ),
    ),
    nodes,
  );
}

export interface HostScope {
  tree: HostTree;
  /** The folder in scope with its stored casing; '' when it is every host. */
  path: string;
  /** The folder in scope, absent at the top. */
  folder?: FolderNode;
}

/** The folder a scope path names, however it is cased. */
export function scopeFolder(tree: HostTree, path: string): FolderNode | undefined {
  return folderSegments(path).length > 0 ? tree.foldersByKey.get(folderKey(path)) : undefined;
}

/**
 * One folder at a time: the folders directly inside the scope, to step into,
 * then every host anywhere below it as one alphabetical run. A scope whose
 * folder is gone — deleted, renamed, or filtered away — falls back to the top.
 */
export function buildHostScopeTree(tree: HostTree, scopePath: string): HostScope {
  const folder = scopeFolder(tree, scopePath);
  const folders = folder
    ? folder.children.filter((child) => child.kind === 'folder')
    : tree.roots.filter((root) => root.kind === 'folder');
  const nodes = hostNodesOf(folder ? folder.children : tree.roots).toSorted((a, b) =>
    byName(a.host, b.host),
  );
  const roots: ContainerNode[] = [...folders];
  if (nodes.length > 0) {
    const label = folder
      ? folders.length > 0
        ? `Everything in ${folder.label}`
        : 'Hosts'
      : 'All hosts';
    roots.push(section('scope', label, nodes));
  }
  return { tree: viewTree(tree, roots, nodes), path: folder?.path ?? '', folder };
}

/** The crumbs leading to a scope: every ancestor, then the folder itself. */
export function scopeCrumbs(path: string): { label: string; path: string }[] {
  const segments = folderSegments(path);
  return segments.map((label, index) => ({
    label,
    path: segments.slice(0, index + 1).join('/'),
  }));
}

/** Whether a host is filed in `path` or anywhere below it. */
export function isHostInScope(host: ManagedHost, path: string): boolean {
  const group = host.entry.metadata?.group ?? '';
  return isSamePath(group, path) || isDescendantPath(group, path);
}

/** The managed host keys of every host in a tree, for quick membership tests. */
export function treeHostKeys(tree: HostTree): Set<string> {
  return new Set(tree.hosts.map(managedHostKey));
}
