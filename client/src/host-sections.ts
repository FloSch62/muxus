import { hostOrderAfterDrop } from './host-organization.js';
import type { ContainerNode, HostTree, TreeNode } from './host-tree.js';
import { managedHostKey, type ManagedHost } from './managed-hosts.js';
import type { DragSource } from './components/sidebar/tree-dnd.js';

/**
 * The hosts tab lays the folder tree out flat: one section per folder, in the
 * tree's own order, each holding the hosts filed directly in it. Kept free of
 * React, with the rules for dragging hosts between and within sections.
 */
export interface HostSection {
  /** The key of the folder or ssh_config file group behind the section. */
  key: string;
  kind: 'folder' | 'file';
  /** The folder path; absent for a file group, which nothing can be moved into. */
  path?: string;
  /** `Production / Web`, or the file group's own label. */
  label: string;
  /** Hint for the heading, such as the ssh_config file a group comes from. */
  tooltip?: string;
  depth: number;
  /** The hosts filed directly in the folder, in the sidebar's order. */
  hosts: ManagedHost[];
}

/** Every folder and file group of a tree, depth-first, as the sidebar orders them. */
export function hostSections(tree: HostTree): HostSection[] {
  const sections: HostSection[] = [];
  const directHosts = (children: readonly TreeNode[]) =>
    children.flatMap((child) => (child.kind === 'host' ? [child.host] : []));
  const walk = (node: ContainerNode) => {
    if (node.kind === 'file') {
      sections.push({
        key: node.key,
        kind: 'file',
        label: node.label,
        tooltip: node.tooltip,
        depth: 0,
        hosts: directHosts(node.children),
      });
      return;
    }
    sections.push({
      key: node.key,
      kind: 'folder',
      path: node.path,
      label: node.path.split('/').join(' / '),
      depth: node.depth,
      hosts: directHosts(node.children),
    });
    for (const child of node.children) {
      if (child.kind === 'folder') walk(child);
    }
  };
  for (const root of tree.roots) walk(root);
  return sections;
}

/** Where a drop lands: in a section, before one of its hosts or at its end. */
export interface SectionDropTarget {
  sectionKey: string;
  beforeKey?: string;
}

export function sameSectionTarget(
  a: SectionDropTarget | null,
  b: SectionDropTarget | null,
): boolean {
  if (!a || !b) return a === b;
  return a.sectionKey === b.sectionKey && a.beforeKey === b.beforeKey;
}

/**
 * Whether dragged hosts may land in a section. Any host can be filed in a
 * folder. An ssh_config file group is defined by its config file, so it only
 * takes its own hosts back — reordering them changes no group.
 */
export function canDropOnSection(source: DragSource, section: HostSection): boolean {
  if (source.kind !== 'host' || source.hosts.length === 0) return false;
  if (section.kind === 'folder') return true;
  return source.hosts.every((host) => host.parentKey === section.key);
}

export interface SectionDropPlan {
  hostKeys: string[];
  /** The folder the hosts move into; absent when only their order changes. */
  path: string | undefined;
  /** The section's hosts in their order after the drop. */
  order: string[];
}

/**
 * What a drop changes, or nothing when the hosts already sit exactly there —
 * letting go of a card where it was picked up must not write anything.
 */
export function planSectionDrop(
  source: DragSource,
  section: HostSection,
  target: SectionDropTarget,
): SectionDropPlan | undefined {
  if (!canDropOnSection(source, section) || source.kind !== 'host') return undefined;
  const hostKeys = source.hosts.map((host) => host.hostKey);
  // A host cannot be placed before itself; it lands where the next one not
  // being dragged is, which is what the insertion line shows.
  const dragged = new Set(hostKeys);
  const current = section.hosts.map(managedHostKey);
  let beforeKey = target.beforeKey;
  if (beforeKey && dragged.has(beforeKey)) {
    beforeKey = current.slice(current.indexOf(beforeKey) + 1).find((key) => !dragged.has(key));
  }
  const order = hostOrderAfterDrop(current, hostKeys, beforeKey, 'before');
  const reorderOnly = source.hosts.every((host) => host.parentKey === section.key);
  if (reorderOnly && order.every((key, index) => key === current[index])) return undefined;
  return { hostKeys, path: reorderOnly ? undefined : section.path, order };
}
