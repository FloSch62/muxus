import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import { buildHostTree, flattenVisibleTree, type HostTree } from '../../../client/src/host-tree.js';
import {
  buildHostListTree,
  buildHostScopeTree,
  isSectionKey,
  recencyBucket,
  scopeCrumbs,
} from '../../../client/src/host-views.js';
import { groupManagedHosts, managedHostDisplayName } from '../../../client/src/managed-hosts.js';

const ROOT = '/home/test/.ssh/config';
const NOW = new Date(2026, 10, 21, 15, 0).getTime();
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function sshHost(alias: string, group?: string, lastConnectedAt?: string): SshHostEntry {
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
    metadata: { profileId: `ssh-${alias}`, group, lastConnectedAt, connectCount: 0 },
  };
}

const HOSTS = [
  sshHost('web-01', 'Production/Web', daysAgo(0)),
  sshHost('web-02', 'Production/Web', daysAgo(3)),
  sshHost('db-01', 'Production/Data', daysAgo(20)),
  sshHost('bastion', 'Production', daysAgo(90)),
  sshHost('build-01', 'Lab'),
  sshHost('loose'),
];

function tree(hosts: readonly SshHostEntry[] = HOSTS): HostTree {
  return buildHostTree(groupManagedHosts(hosts, [], [ROOT], ROOT));
}

/** Section labels with the hosts under each, as the list reads top to bottom. */
function outline(view: HostTree): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current = '';
  for (const row of flattenVisibleTree(view, () => true)) {
    if (row.node.kind === 'host') out[current]!.push(managedHostDisplayName(row.node.host));
    else out[(current = row.node.label)] = [];
  }
  return out;
}

describe('how long ago a host was connected', () => {
  it('falls into stretches of calendar days', () => {
    const at = (days: number) => NOW - days * 24 * 60 * 60 * 1000;
    expect(recencyBucket(undefined, NOW)).toBe('never');
    expect(recencyBucket(at(0), NOW)).toBe('today');
    expect(recencyBucket(at(1), NOW)).toBe('week');
    expect(recencyBucket(at(6), NOW)).toBe('week');
    expect(recencyBucket(at(7), NOW)).toBe('month');
    expect(recencyBucket(at(30), NOW)).toBe('month');
    expect(recencyBucket(at(31), NOW)).toBe('earlier');
  });
});

describe('the flat list', () => {
  it('groups by when a host was last connected, with open sessions first', () => {
    const view = buildHostListTree(tree(), {
      grouping: 'recent',
      liveKeys: new Set(['ssh:db-01']),
      now: NOW,
    });
    expect(outline(view)).toEqual({
      'Open now': ['db-01'],
      Today: ['web-01'],
      'This week': ['web-02'],
      Earlier: ['bastion'],
      'Not connected yet': ['build-01', 'loose'],
    });
    expect(view.roots.every((root) => isSectionKey(root.key))).toBe(true);
  });

  it('is one alphabetical run when grouped by name', () => {
    const view = buildHostListTree(tree(), { grouping: 'name', liveKeys: new Set(), now: NOW });
    expect(outline(view)).toEqual({
      'All hosts': ['bastion', 'build-01', 'db-01', 'loose', 'web-01', 'web-02'],
    });
  });

  it('groups by kind, naming only the kinds in use', () => {
    const view = buildHostListTree(tree(), { grouping: 'kind', liveKeys: new Set(), now: NOW });
    expect(Object.keys(outline(view))).toEqual(['SSH']);
    expect(view.hosts).toHaveLength(HOSTS.length);
  });

  it('keeps the folder a host is really filed in, so a drag knows where it comes from', () => {
    const real = tree();
    const view = buildHostListTree(real, { grouping: 'name', liveKeys: new Set(), now: NOW });
    const row = flattenVisibleTree(view, () => true).find((entry) => entry.key === 'ssh:web-01');
    expect(row?.node.kind === 'host' && row.node.parentKey).toBe('folder:production/web');
    expect(row?.depth).toBe(1);
  });

  it('has no sections at all without hosts', () => {
    const view = buildHostListTree(tree([]), { grouping: 'name', liveKeys: new Set(), now: NOW });
    expect(view.roots).toEqual([]);
  });
});

describe('one folder at a time', () => {
  it('lists the top-level folders and every host at the top', () => {
    const scope = buildHostScopeTree(tree(), '');
    expect(scope.path).toBe('');
    expect(scope.tree.roots.map((root) => root.label)).toEqual(['Lab', 'Production', 'All hosts']);
    expect(scope.tree.hosts).toHaveLength(HOSTS.length);
  });

  it('narrows to a folder: its subfolders to step into, then everything below it', () => {
    const scope = buildHostScopeTree(tree(), 'production');
    expect(scope.path).toBe('Production');
    expect(scope.tree.roots.map((root) => root.label)).toEqual([
      'Data',
      'Web',
      'Everything in Production',
    ]);
    const section = scope.tree.roots[2]!;
    expect(section.children.map((child) => child.key)).toEqual([
      'ssh:bastion',
      'ssh:db-01',
      'ssh:web-01',
      'ssh:web-02',
    ]);
  });

  it('calls the hosts of a folder without subfolders just hosts', () => {
    const scope = buildHostScopeTree(tree(), 'Production/Web');
    expect(scope.tree.roots.map((root) => root.label)).toEqual(['Hosts']);
  });

  it('falls back to the top when the folder is gone', () => {
    const scope = buildHostScopeTree(tree(), 'Staging');
    expect(scope.path).toBe('');
    expect(scope.folder).toBeUndefined();
  });

  it('does not unfold the folders it lists', () => {
    const scope = buildHostScopeTree(tree(), '');
    const rows = flattenVisibleTree(scope.tree, (key) => isSectionKey(key));
    expect(rows.filter((row) => row.node.kind === 'folder').map((row) => row.depth)).toEqual([0, 0]);
    expect(rows.filter((row) => row.node.kind === 'host')).toHaveLength(HOSTS.length);
  });
});

describe('the crumbs of a scope', () => {
  it('names every folder on the way down', () => {
    expect(scopeCrumbs('')).toEqual([]);
    expect(scopeCrumbs('Production/Web')).toEqual([
      { label: 'Production', path: 'Production' },
      { label: 'Web', path: 'Production/Web' },
    ]);
  });
});
