import {
  folderDepth,
  folderPath,
  folderSegments,
  isDescendantPath,
  isSamePath,
  MAX_FOLDER_DEPTH,
  type ContainerNode,
  type HostTree,
  type VisibleNode,
} from '../../host-tree.js';

export type DragSource =
  | { kind: 'host'; hostKey: string; parentKey: string }
  | { kind: 'folder'; folderKey: string; path: string };

export type DropTarget =
  | { kind: 'into-folder'; folderKey: string }
  | { kind: 'host-edge'; hostKey: string; parentKey: string; edge: 'before' | 'after' }
  | {
      kind: 'folder-edge';
      folderKey: string;
      /** Parent of the folder being dropped next to; absent means top level. */
      parentKey?: string;
      edge: 'before' | 'after';
    }
  | { kind: 'root' };

/**
 * What a pointer at `ratio` down a row means, per node kind. A folder's middle
 * band drops inside it; its top and bottom quarters place the dragged item
 * beside it, which is what makes folders manually orderable.
 */
export function dropTargetForRow(row: VisibleNode, ratio: number): DropTarget | undefined {
  if (row.node.kind === 'host') {
    return {
      kind: 'host-edge',
      hostKey: row.key,
      parentKey: row.node.parentKey,
      edge: ratio < 0.5 ? 'before' : 'after',
    };
  }
  if (ratio > 0.25 && ratio < 0.75) return { kind: 'into-folder', folderKey: row.key };
  // ssh_config file groups have no order of their own to join.
  if (row.node.kind !== 'folder') return { kind: 'root' };
  return {
    kind: 'folder-edge',
    folderKey: row.key,
    parentKey: row.node.parentKey,
    edge: ratio <= 0.25 ? 'before' : 'after',
  };
}

export function dragSourceForRow(row: VisibleNode): DragSource | undefined {
  if (row.node.kind === 'host') {
    return { kind: 'host', hostKey: row.key, parentKey: row.node.parentKey };
  }
  // ssh_config file groups belong to the config file, not to the sidebar.
  if (row.node.kind !== 'folder') return undefined;
  return { kind: 'folder', folderKey: row.key, path: row.node.path };
}

/**
 * The folder path a drop target lands in; '' is the root.
 *
 * Undefined rather than '' when the target resolves to an ssh_config file
 * group: that is not a folder, and nothing may be dropped into it.
 */
export function targetPath(target: DropTarget, tree: HostTree): string | undefined {
  switch (target.kind) {
    case 'root':
      return '';
    case 'into-folder':
      return tree.foldersByKey.get(target.folderKey)?.path;
    case 'host-edge':
      return tree.foldersByKey.get(target.parentKey)?.path;
    case 'folder-edge':
      // Beside a top-level folder means joining the top level.
      return target.parentKey ? tree.foldersByKey.get(target.parentKey)?.path : '';
  }
}

export function containerFor(target: DropTarget, tree: HostTree): ContainerNode | undefined {
  const key =
    target.kind === 'into-folder'
      ? target.folderKey
      : target.kind === 'host-edge' || target.kind === 'folder-edge'
        ? target.parentKey
        : undefined;
  if (!key) return undefined;
  return tree.foldersByKey.get(key) ?? tree.roots.find((root) => root.key === key);
}

/**
 * Whether a drop is allowed. Kept pure and exhaustive because the drag preview
 * and the commit both have to agree — a target that highlights but refuses on
 * release reads as a bug.
 */
export function canDrop(source: DragSource, target: DropTarget, tree: HostTree): boolean {
  const destination = targetPath(target, tree);

  if (source.kind === 'host') {
    if (target.kind === 'host-edge' && target.hostKey === source.hostKey) return false;
    // Reordering within the container a host already sits in changes no group,
    // so it stays available even inside a read-only ssh_config file group.
    if (isPureReorder(source, target)) return true;
    // Otherwise the host is changing folders, and a file group is not one.
    return destination !== undefined;
  }

  if (destination === undefined) return false;
  const folder = tree.foldersByKey.get(source.folderKey);
  if (!folder) return false;
  if (isSamePath(destination, source.path) || isDescendantPath(destination, source.path)) {
    return false;
  }
  // Dropping a folder beside itself would not move it anywhere.
  if (target.kind === 'folder-edge' && target.folderKey === source.folderKey) return false;
  // Landing in the parent it already has is a reorder when a position was
  // named, and a no-op when it was not.
  const currentParent = folderPath(folderSegments(source.path).slice(0, -1));
  if (isSamePath(destination, currentParent) && target.kind !== 'folder-edge') return false;
  return folderDepth(destination) + subtreeHeight(folder) + 1 <= MAX_FOLDER_DEPTH;
}

/**
 * The sibling order after dropping a folder beside another. The dragged folder
 * may arrive from elsewhere, so its old key is removed and its new one — which
 * differs whenever the drop also re-parents it — is inserted.
 */
export function folderOrderAfterDrop(
  siblingKeys: readonly string[],
  sourceOldKey: string,
  sourceNewKey: string,
  targetKey: string | undefined,
  edge: 'before' | 'after' = 'after',
): string[] {
  const next = siblingKeys.filter((key) => key !== sourceOldKey && key !== sourceNewKey);
  if (!targetKey) return [...next, sourceNewKey];
  const index = next.indexOf(targetKey);
  if (index < 0) return [...next, sourceNewKey];
  next.splice(index + (edge === 'after' ? 1 : 0), 0, sourceNewKey);
  return next;
}

/**
 * Whether two drop targets mean the same landing spot, so a dragover that
 * resolves to the one already held can leave state untouched.
 *
 * Every field that moves the drop has to be compared. Treating two edges of the
 * same kind as interchangeable would keep the first one the pointer touched and
 * commit there, wherever the drag was actually released.
 */
export function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'into-folder' && b.kind === 'into-folder') return a.folderKey === b.folderKey;
  if (a.kind === 'host-edge' && b.kind === 'host-edge') {
    return a.hostKey === b.hostKey && a.edge === b.edge;
  }
  if (a.kind === 'folder-edge' && b.kind === 'folder-edge') {
    return a.folderKey === b.folderKey && a.edge === b.edge;
  }
  // Only the root is left, and there is one of it.
  return true;
}

/** A drop that only changes order, never which container the host is in. */
export function isPureReorder(source: DragSource, target: DropTarget): boolean {
  if (source.kind !== 'host') return false;
  if (target.kind === 'host-edge') return target.parentKey === source.parentKey;
  if (target.kind === 'folder-edge') return target.parentKey === source.parentKey;
  return target.kind === 'into-folder' && target.folderKey === source.parentKey;
}

/** Deepest nesting below a folder, in levels; a leaf folder is 0. */
function subtreeHeight(folder: ContainerNode): number {
  if (folder.kind !== 'folder') return 0;
  let deepest = 0;
  for (const child of folder.children) {
    if (child.kind === 'folder') deepest = Math.max(deepest, subtreeHeight(child) + 1);
  }
  return deepest;
}

/** The path a dragged folder ends up at, keeping its own name. */
export function droppedFolderPath(source: DragSource, destination: string): string {
  if (source.kind !== 'folder') return destination;
  return folderPath([...folderSegments(destination), ...folderSegments(source.path).slice(-1)]);
}
