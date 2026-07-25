import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import { groupManagedHosts } from '../../../client/src/managed-hosts.js';
import {
  ancestorPaths,
  buildHostTree,
  expandFolderPaths,
  flattenVisibleTree,
  folderKey,
  folderParentPath,
  folderSegments,
  folderSiblings,
  isDescendantPath,
  knownFolderPaths,
  moveFolderPath,
  normalizeGroupPath,
  renameFolderPath,
  sanitizeFolderName,
  siblingHostKeys,
  TREE_ROOT_KEY,
  type FolderNode,
} from '../../../client/src/host-tree.js';

const ROOT = '/home/test/.ssh/config';

function sshHost(alias: string, group?: string, sortOrder?: number): SshHostEntry {
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
    metadata:
      group || sortOrder !== undefined
        ? { profileId: `ssh-${alias}`, favorite: false, group, sortOrder, connectCount: 0 }
        : undefined,
  };
}

function tree(hosts: readonly SshHostEntry[], knownFolders?: readonly string[]) {
  return buildHostTree(groupManagedHosts(hosts, [], [ROOT], ROOT), { knownFolders });
}

/** Every folder in the tree, keyed by path, for terse assertions. */
function foldersByPath(roots: ReturnType<typeof tree>) {
  return new Map([...roots.foldersByKey.values()].map((folder) => [folder.path, folder]));
}

describe('path helpers', () => {
  it('normalizes padded, doubled and edge separators on read', () => {
    expect(folderSegments('  Production / EU  ')).toEqual(['Production', 'EU']);
    expect(folderSegments('/a//b/')).toEqual(['a', 'b']);
    expect(folderSegments('')).toEqual([]);
    expect(folderSegments(undefined)).toEqual([]);
    expect(normalizeGroupPath(' /Prod// EU /')).toBe('Prod/EU');
  });

  it('keeps a folder name to one segment', () => {
    expect(sanitizeFolderName('k8s/prod')).toBe('k8s prod');
    expect(sanitizeFolderName('  spaced  out  ')).toBe('spaced out');
  });

  it('identifies folders case-insensitively at every level', () => {
    expect(folderKey('Prod/EU')).toBe(folderKey('prod/eu'));
    expect(folderKey('Prod/EU')).not.toBe(folderKey('Prod/US'));
  });

  it('compares ancestry by segment, not by string prefix', () => {
    expect(isDescendantPath('Prod/EU', 'Prod')).toBe(true);
    expect(isDescendantPath('Prod/EU/Edge', 'prod')).toBe(true);
    // The bug this guards: 'Production'.startsWith('Prod') is true.
    expect(isDescendantPath('Production', 'Prod')).toBe(false);
    expect(isDescendantPath('Prod', 'Prod')).toBe(false);
    expect(isDescendantPath('Prod', '')).toBe(false);
  });

  it('walks parents and ancestors', () => {
    expect(folderParentPath('A/B/C')).toBe('A/B');
    expect(folderParentPath('A')).toBe('');
    expect(ancestorPaths('A/B/C')).toEqual(['A', 'A/B']);
    expect(ancestorPaths('A')).toEqual([]);
  });

  it('rewrites descendants when a folder is renamed or re-parented', () => {
    expect(renameFolderPath('Prod', 'Prod', 'Production')).toBe('Production');
    expect(renameFolderPath('Prod/EU/Edge', 'Prod', 'Production')).toBe('Production/EU/Edge');
    expect(renameFolderPath('Production', 'Prod', 'X')).toBeUndefined();
    expect(renameFolderPath('Prodigy/EU', 'Prod', 'X')).toBeUndefined();
    expect(moveFolderPath('Prod/EU', 'Lab')).toBe('Lab/EU');
    expect(moveFolderPath('Prod/EU', '')).toBe('EU');
  });
});

describe('buildHostTree', () => {
  it('nests a three-level path with correct depth and parents', () => {
    const built = tree([
      sshHost('edge-1', 'Production/EU/Edge'),
      sshHost('core-1', 'Production/EU/Core'),
      sshHost('us-1', 'Production/US'),
    ]);
    const folders = foldersByPath(built);

    expect(folders.get('Production')).toMatchObject({ depth: 0, parentKey: undefined });
    expect(folders.get('Production/EU')).toMatchObject({
      depth: 1,
      parentKey: folderKey('Production'),
      label: 'EU',
    });
    expect(folders.get('Production/EU/Edge')).toMatchObject({
      depth: 2,
      parentKey: folderKey('Production/EU'),
    });
    // Every host is grouped, so no ssh_config file group survives.
    expect(built.roots.map((root) => root.label)).toEqual(['Production']);
  });

  it('synthesizes intermediate folders that hold no host of their own', () => {
    const built = tree([sshHost('deep', 'A/B/C')]);
    const folders = foldersByPath(built);

    expect([...folders.keys()].sort()).toEqual(['A', 'A/B', 'A/B/C']);
    expect(folders.get('A')!.children.map((child) => child.kind)).toEqual(['folder']);
    expect(folders.get('A/B/C')!.children.map((child) => child.kind)).toEqual(['host']);
  });

  it('rolls the host count up through every ancestor', () => {
    const built = tree([
      sshHost('a', 'P/EU/Edge'),
      sshHost('b', 'P/EU/Edge'),
      sshHost('c', 'P/EU'),
      sshHost('d', 'P/US'),
    ]);
    const folders = foldersByPath(built);

    expect(folders.get('P')!.descendantHostCount).toBe(4);
    expect(folders.get('P/EU')!.descendantHostCount).toBe(3);
    expect(folders.get('P/EU/Edge')!.descendantHostCount).toBe(2);
    expect(folders.get('P/US')!.descendantHostCount).toBe(1);
  });

  it('collapses case-variant paths onto one folder', () => {
    const built = tree([sshHost('a', 'Prod/EU'), sshHost('b', 'prod/eu')]);
    const folders = foldersByPath(built);

    expect(folders.size).toBe(2);
    expect([...folders.values()].find((folder) => folder.depth === 1)!.descendantHostCount).toBe(2);
  });

  it('picks a shared ancestor casing independently of host order', () => {
    // Two distinct group labels disagree on how to spell their common parent;
    // which spelling wins must not depend on which host was seen first.
    const hosts = [sshHost('a', 'Prod/EU'), sshHost('b', 'prod/US')];
    const forward = [...foldersByPath(tree(hosts)).keys()].sort();
    const reversed = [...foldersByPath(tree([...hosts].reverse())).keys()].sort();

    expect(forward).toEqual(reversed);
    expect(forward).toHaveLength(3);
  });

  it('sorts folders before hosts and keeps the host order it was given', () => {
    const built = tree([
      sshHost('zulu', 'Ops', 2),
      sshHost('alpha', 'Ops', 1),
      sshHost('nested', 'Ops/Sub'),
    ]);
    const ops = foldersByPath(built).get('Ops')!;

    expect(ops.children.map((child) => (child.kind === 'folder' ? child.label : child.key))).toEqual([
      'Sub',
      'ssh:alpha',
      'ssh:zulu',
    ]);
    expect(siblingHostKeys(ops)).toEqual(['ssh:alpha', 'ssh:zulu']);
  });

  it('sorts sibling folders alphabetically until the user places them', () => {
    const built = tree([sshHost('a', 'Zed'), sshHost('b', 'Alpha'), sshHost('c', 'mid')]);
    expect(built.roots.map((root) => root.label)).toEqual(['Alpha', 'mid', 'Zed']);
  });

  it('honours a manual sibling order, alphabetical for the rest', () => {
    const hosts = [sshHost('a', 'Zed'), sshHost('b', 'Alpha'), sshHost('c', 'mid')];
    const order: Record<string, string[]> = {
      [TREE_ROOT_KEY]: [folderKey('Zed'), folderKey('mid')],
    };
    const built = buildHostTree(groupManagedHosts(hosts, [], [ROOT], ROOT), {
      folderOrder: (parentKey) => order[parentKey],
    });

    // Placed folders keep their order; Alpha was never dragged, so it follows.
    expect(built.roots.map((root) => root.label)).toEqual(['Zed', 'mid', 'Alpha']);
  });

  it('orders nested folders under their own parent key', () => {
    const hosts = [sshHost('a', 'P/Zed'), sshHost('b', 'P/Alpha')];
    const order: Record<string, string[]> = {
      [folderKey('P')]: [folderKey('P/Zed'), folderKey('P/Alpha')],
    };
    const built = buildHostTree(groupManagedHosts(hosts, [], [ROOT], ROOT), {
      folderOrder: (parentKey) => order[parentKey],
    });

    expect(
      foldersByPath(built)
        .get('P')!
        .children.map((child) => (child.kind === 'folder' ? child.label : child.key)),
    ).toEqual(['Zed', 'Alpha']);
  });

  it('keeps folders before hosts whatever the manual order says', () => {
    const hosts = [sshHost('nested', 'Ops/Sub'), sshHost('direct', 'Ops')];
    const order: Record<string, string[]> = { [folderKey('Ops')]: [folderKey('Ops/Sub')] };
    const built = buildHostTree(groupManagedHosts(hosts, [], [ROOT], ROOT), {
      folderOrder: (parentKey) => order[parentKey],
    });

    expect(foldersByPath(built).get('Ops')!.children.map((child) => child.kind)).toEqual([
      'folder',
      'host',
    ]);
  });

  it('ignores order entries for folders that no longer exist', () => {
    const order: Record<string, string[]> = {
      [TREE_ROOT_KEY]: [folderKey('Gone'), folderKey('Zed')],
    };
    const built = buildHostTree(
      groupManagedHosts([sshHost('a', 'Zed'), sshHost('b', 'Alpha')], [], [ROOT], ROOT),
      { folderOrder: (parentKey) => order[parentKey] },
    );

    expect(built.roots.map((root) => root.label)).toEqual(['Zed', 'Alpha']);
  });

  it('reports where a folder sits among its siblings', () => {
    const built = tree([sshHost('a', 'Zed'), sshHost('b', 'Alpha'), sshHost('c', 'Alpha/Deep')]);

    expect(folderSiblings(built, folderKey('Zed'))).toEqual({
      parentKey: TREE_ROOT_KEY,
      keys: [folderKey('Alpha'), folderKey('Zed')],
    });
    expect(folderSiblings(built, folderKey('Alpha/Deep'))).toEqual({
      parentKey: folderKey('Alpha'),
      keys: [folderKey('Alpha/Deep')],
    });
    expect(folderSiblings(built, 'folder:nope')).toBeUndefined();
  });

  it('pins ssh_config file groups last and never nests them', () => {
    const built = tree([sshHost('grouped', 'Ops'), sshHost('loose')]);
    const last = built.roots.at(-1)!;

    expect(last.kind).toBe('file');
    expect(last.depth).toBe(0);
    expect(last.children.every((child) => child.kind === 'host')).toBe(true);
  });

  it('materializes known folders that hold no host yet', () => {
    const built = tree([sshHost('a', 'Ops')], ['Staging/Blue']);
    const folders = foldersByPath(built);

    expect(folders.get('Staging')).toMatchObject({ empty: true, descendantHostCount: 0 });
    expect(folders.get('Staging/Blue')).toMatchObject({ empty: true, descendantHostCount: 0 });
    expect(folders.get('Ops')!.empty).toBe(false);
  });
});

describe('flattenVisibleTree', () => {
  const built = () =>
    tree([sshHost('edge', 'P/EU/Edge'), sshHost('us', 'P/US'), sshHost('loose')]);

  it('hides an entire subtree when its folder is collapsed', () => {
    const collapsed = folderKey('P/EU');
    const rows = flattenVisibleTree(built(), (key) => key !== collapsed);

    expect(rows.map((row) => row.key)).toContain(collapsed);
    expect(rows.some((row) => row.key === 'ssh:edge')).toBe(false);
    expect(rows.some((row) => row.key === 'ssh:us')).toBe(true);
  });

  it('reports aria level, position and set size per level', () => {
    const rows = flattenVisibleTree(built(), () => true);
    const eu = rows.find((row) => row.key === folderKey('P/EU'))!;
    const edgeHost = rows.find((row) => row.key === 'ssh:edge')!;

    expect(eu).toMatchObject({ level: 2, posInSet: 1, setSize: 2 });
    expect(edgeHost).toMatchObject({ level: 4, depth: 3 });
    // Two roots: the P folder and the ssh_config file group.
    expect(rows.filter((row) => row.level === 1).map((row) => row.setSize)).toEqual([2, 2]);
  });

  it('omits aria-expanded on hosts and reports it on containers', () => {
    const rows = flattenVisibleTree(built(), () => true);
    expect(rows.find((row) => row.key === 'ssh:edge')!.expanded).toBeUndefined();
    expect(rows.find((row) => row.key === folderKey('P'))!.expanded).toBe(true);
  });

  it('inherits the rail colour from the nearest coloured ancestor', () => {
    const colored = folderKey('P');
    const rows = flattenVisibleTree(
      built(),
      () => true,
      (key) => (key === colored ? '#ef5350' : undefined),
    );

    expect(rows.find((row) => row.key === folderKey('P/EU'))!.railColor).toBe('#ef5350');
    expect(rows.find((row) => row.key === 'ssh:edge')!.railColor).toBe('#ef5350');
    expect(rows.find((row) => row.key === 'ssh:loose')!.railColor).toBeUndefined();
  });

  it('lists ancestors outermost first so indent guides can be drawn', () => {
    const rows = flattenVisibleTree(built(), () => true);
    expect(rows.find((row) => row.key === 'ssh:edge')!.ancestors).toEqual([
      folderKey('P'),
      folderKey('P/EU'),
      folderKey('P/EU/Edge'),
    ]);
  });
});

describe('expandFolderPaths', () => {
  it('offers every ancestor and dedupes case-insensitively', () => {
    expect(expandFolderPaths(['Production/EU/Edge', 'Production/EU', 'Lab'])).toEqual([
      'Lab',
      'Production',
      'Production/EU',
      'Production/EU/Edge',
    ]);
  });

  it('rebuilds deeper paths from the casing their ancestors settled on', () => {
    // Never offer "production/eu" and "Production/EU/Edge" in the same list.
    expect(expandFolderPaths(['Production/EU/Edge', 'production/eu'])).toEqual([
      'production',
      'production/eu',
      'production/eu/Edge',
    ]);
  });

  it('drops blank and separator-only entries', () => {
    expect(expandFolderPaths(['', '  ', '///'])).toEqual([]);
  });
});

describe('tree invariants', () => {
  it('exposes every host exactly once in render order', () => {
    const built = tree([sshHost('b', 'Ops'), sshHost('a', 'Ops'), sshHost('loose')]);
    const keys = built.hosts.map((host) =>
      host.kind === 'ssh' ? host.entry.alias : host.entry.id,
    );
    expect(keys).toEqual(['a', 'b', 'loose']);
  });

  it('keeps foldersByKey and the root list consistent', () => {
    const built = tree([sshHost('a', 'A/B')]);
    const roots = built.roots.filter((root): root is FolderNode => root.kind === 'folder');
    for (const root of roots) expect(built.foldersByKey.get(root.key)).toBe(root);
  });
});

describe('knownFolderPaths', () => {
  it('offers every folder in use plus its ancestors', () => {
    expect(knownFolderPaths([sshHost('a', 'Production/EU/Edge'), sshHost('b', 'Lab')], [])).toEqual([
      'Lab',
      'Production',
      'Production/EU',
      'Production/EU/Edge',
    ]);
  });

  it('includes folders that exist only in preferences', () => {
    expect(knownFolderPaths([sshHost('a', 'Lab')], [], ['Staging/Blue'])).toEqual([
      'Lab',
      'Staging',
      'Staging/Blue',
    ]);
  });

  it('offers nothing when no host is grouped', () => {
    expect(knownFolderPaths([sshHost('a')], [])).toEqual([]);
  });
});
