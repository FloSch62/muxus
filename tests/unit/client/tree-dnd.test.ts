import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import { groupManagedHosts } from '../../../client/src/managed-hosts.js';
import {
  buildHostTree,
  flattenVisibleTree,
  folderKey,
  type VisibleNode,
} from '../../../client/src/host-tree.js';
import {
  canDrop,
  containerFor,
  dragSourceForRow,
  dropTargetForRow,
  droppedFolderPath,
  folderOrderAfterDrop,
  isPureReorder,
  targetPath,
  type DragSource,
} from '../../../client/src/components/sidebar/tree-dnd.js';

const ROOT = '/home/test/.ssh/config';

function sshHost(alias: string, group?: string): SshHostEntry {
  return {
    alias,
    aliases: [alias],
    file: ROOT,
    options: {},
    resolved: {
      hostname: `${alias}.example.test`,
      port: 22,
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump: [],
      forwards: [],
      passwordOnly: false,
    },
    metadata: group ? { profileId: alias, favorite: false, group, connectCount: 0 } : undefined,
  };
}

/**
 *  Prod            folder
 *    EU            folder
 *      edge        host
 *    core          host
 *  Lab             folder
 *    lab-1         host
 *  Hosts           ssh_config file group
 *    loose         host
 */
const HOSTS = [
  sshHost('edge', 'Prod/EU'),
  sshHost('core', 'Prod'),
  sshHost('lab-1', 'Lab'),
  sshHost('loose'),
];

const tree = buildHostTree(groupManagedHosts(HOSTS, [], [ROOT], ROOT));
const rows = flattenVisibleTree(tree, () => true);
const row = (key: string): VisibleNode => rows.find((entry) => entry.key === key)!;

const fileGroupKey = `file:${ROOT}`;
const dragEdge: DragSource = { kind: 'host', hostKey: 'ssh:edge', parentKey: folderKey('Prod/EU') };
const dragLoose: DragSource = { kind: 'host', hostKey: 'ssh:loose', parentKey: fileGroupKey };
const dragProd: DragSource = { kind: 'folder', folderKey: folderKey('Prod'), path: 'Prod' };
const dragLab: DragSource = { kind: 'folder', folderKey: folderKey('Lab'), path: 'Lab' };

describe('dropTargetForRow', () => {
  it('splits a host row into a before and an after half', () => {
    expect(dropTargetForRow(row('ssh:edge'), 0.2)).toMatchObject({ edge: 'before' });
    expect(dropTargetForRow(row('ssh:edge'), 0.8)).toMatchObject({ edge: 'after' });
  });

  it('treats the middle of a folder as "drop inside"', () => {
    expect(dropTargetForRow(row(folderKey('Lab')), 0.5)).toEqual({
      kind: 'into-folder',
      folderKey: folderKey('Lab'),
    });
  });

  it('treats a folder edge as "place beside this folder"', () => {
    expect(dropTargetForRow(row(folderKey('Prod/EU')), 0.1)).toEqual({
      kind: 'folder-edge',
      folderKey: folderKey('Prod/EU'),
      parentKey: folderKey('Prod'),
      edge: 'before',
    });
    // A top-level folder has no parent key: its edges join the top level.
    expect(dropTargetForRow(row(folderKey('Prod')), 0.9)).toEqual({
      kind: 'folder-edge',
      folderKey: folderKey('Prod'),
      parentKey: undefined,
      edge: 'after',
    });
  });

  it('sends an ssh_config file group edge to the root', () => {
    expect(dropTargetForRow(row(fileGroupKey), 0.9)).toEqual({ kind: 'root' });
  });
});

describe('folder ordering', () => {
  it('reorders a folder among the siblings it already has', () => {
    const target = {
      kind: 'folder-edge' as const,
      folderKey: folderKey('Lab'),
      parentKey: undefined,
      edge: 'before' as const,
    };
    expect(canDrop(dragProd, target, tree)).toBe(true);
    expect(targetPath(target, tree)).toBe('');
  });

  it('refuses to drop a folder beside itself', () => {
    expect(
      canDrop(
        dragProd,
        { kind: 'folder-edge', folderKey: folderKey('Prod'), parentKey: undefined, edge: 'after' },
        tree,
      ),
    ).toBe(false);
  });

  it('still refuses a folder edge inside its own subtree', () => {
    expect(
      canDrop(
        dragProd,
        {
          kind: 'folder-edge',
          folderKey: folderKey('Prod/EU'),
          parentKey: folderKey('Prod'),
          edge: 'before',
        },
        tree,
      ),
    ).toBe(false);
  });

  it('inserts before or after the folder it was dropped on', () => {
    const siblings = ['a', 'b', 'c'];
    expect(folderOrderAfterDrop(siblings, 'c', 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(folderOrderAfterDrop(siblings, 'a', 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
  });

  it('appends when no target folder was named', () => {
    expect(folderOrderAfterDrop(['a', 'b'], 'x', 'x', undefined)).toEqual(['a', 'b', 'x']);
  });

  it('uses the new key when the drop also re-parents the folder', () => {
    // Dragging Lab into Prod changes its key from folder:lab to folder:prod/lab.
    expect(folderOrderAfterDrop(['a', 'b'], 'folder:lab', 'folder:prod/lab', 'a', 'after')).toEqual(
      ['a', 'folder:prod/lab', 'b'],
    );
  });
});

describe('dragSourceForRow', () => {
  it('describes hosts and folders', () => {
    expect(dragSourceForRow(row('ssh:edge'))).toEqual(dragEdge);
    expect(dragSourceForRow(row(folderKey('Prod')))).toEqual(dragProd);
  });

  it('refuses to drag an ssh_config file group', () => {
    expect(dragSourceForRow(row(fileGroupKey))).toBeUndefined();
  });
});

describe('targetPath', () => {
  it('resolves folders and the root, but not file groups', () => {
    expect(targetPath({ kind: 'root' }, tree)).toBe('');
    expect(targetPath({ kind: 'into-folder', folderKey: folderKey('Prod/EU') }, tree)).toBe('Prod/EU');
    expect(targetPath({ kind: 'into-folder', folderKey: fileGroupKey }, tree)).toBeUndefined();
  });
});

describe('canDrop', () => {
  it('moves a host between folders and out to the root', () => {
    expect(canDrop(dragEdge, { kind: 'into-folder', folderKey: folderKey('Lab') }, tree)).toBe(true);
    expect(canDrop(dragEdge, { kind: 'root' }, tree)).toBe(true);
  });

  it('never drops anything into an ssh_config file group', () => {
    expect(canDrop(dragEdge, { kind: 'into-folder', folderKey: fileGroupKey }, tree)).toBe(false);
    expect(canDrop(dragProd, { kind: 'into-folder', folderKey: fileGroupKey }, tree)).toBe(false);
  });

  it('still allows reordering inside a file group, which changes no folder', () => {
    const target = {
      kind: 'host-edge' as const,
      hostKey: 'ssh:other',
      parentKey: fileGroupKey,
      edge: 'after' as const,
    };
    expect(canDrop(dragLoose, target, tree)).toBe(true);
    expect(isPureReorder(dragLoose, target)).toBe(true);
  });

  it('refuses to drop a host onto itself', () => {
    const onSelf = {
      kind: 'host-edge' as const,
      hostKey: 'ssh:edge',
      parentKey: folderKey('Prod/EU'),
      edge: 'before' as const,
    };
    expect(canDrop(dragEdge, onSelf, tree)).toBe(false);
  });

  it('refuses to move a folder into itself or a descendant', () => {
    expect(canDrop(dragProd, { kind: 'into-folder', folderKey: folderKey('Prod') }, tree)).toBe(false);
    expect(canDrop(dragProd, { kind: 'into-folder', folderKey: folderKey('Prod/EU') }, tree)).toBe(
      false,
    );
  });

  it('refuses a folder move that changes nothing', () => {
    // Lab is already at the root.
    expect(canDrop(dragLab, { kind: 'root' }, tree)).toBe(false);
    // EU is already inside Prod.
    const eu: DragSource = { kind: 'folder', folderKey: folderKey('Prod/EU'), path: 'Prod/EU' };
    expect(canDrop(eu, { kind: 'into-folder', folderKey: folderKey('Prod') }, tree)).toBe(false);
  });

  it('allows a genuine folder re-parent', () => {
    expect(canDrop(dragLab, { kind: 'into-folder', folderKey: folderKey('Prod') }, tree)).toBe(true);
  });

  it('allows a move that lands exactly on the depth cap', () => {
    // target/a/b/c/d/e/f/g is eight levels, which is MAX_FOLDER_DEPTH.
    const deep = buildHostTree(
      groupManagedHosts([sshHost('x', 'a/b/c/d/e/f/g'), sshHost('y', 'target')], [], [ROOT], ROOT),
    );
    const source: DragSource = { kind: 'folder', folderKey: folderKey('a'), path: 'a' };
    expect(canDrop(source, { kind: 'into-folder', folderKey: folderKey('target') }, deep)).toBe(
      true,
    );
  });

  it('refuses a move that would nest past the depth cap', () => {
    const deeper = buildHostTree(
      groupManagedHosts(
        [sshHost('x', 'a/b/c/d/e/f/g/h'), sshHost('y', 'target')],
        [],
        [ROOT],
        ROOT,
      ),
    );
    const source: DragSource = { kind: 'folder', folderKey: folderKey('a'), path: 'a' };
    expect(canDrop(source, { kind: 'into-folder', folderKey: folderKey('target') }, deeper)).toBe(
      false,
    );
  });
});

describe('containerFor', () => {
  it('finds folders and file groups alike', () => {
    expect(containerFor({ kind: 'into-folder', folderKey: folderKey('Prod') }, tree)?.key).toBe(
      folderKey('Prod'),
    );
    expect(
      containerFor(
        { kind: 'host-edge', hostKey: 'ssh:loose', parentKey: fileGroupKey, edge: 'after' },
        tree,
      )?.key,
    ).toBe(fileGroupKey);
    expect(containerFor({ kind: 'root' }, tree)).toBeUndefined();
  });
});

describe('droppedFolderPath', () => {
  it('keeps the folder name and swaps its parent', () => {
    expect(droppedFolderPath(dragProd, 'Lab')).toBe('Lab/Prod');
    expect(droppedFolderPath(dragProd, '')).toBe('Prod');
    const eu: DragSource = { kind: 'folder', folderKey: folderKey('Prod/EU'), path: 'Prod/EU' };
    expect(droppedFolderPath(eu, 'Lab')).toBe('Lab/EU');
  });
});
