import { describe, expect, it } from 'vitest';
import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';
import {
  DEFAULT_HOSTS_TABLE_SORT,
  formatLastUsed,
  hostFolderLabel,
  hostJumpRoute,
  hostsTableRow,
  isHostsTableSort,
  managedHostKind,
  nextHostsTableSort,
  sortHostsTableRows,
} from '../../../client/src/hosts-table.js';
import type { ManagedHost } from '../../../client/src/managed-hosts.js';

function sshHost(
  alias: string,
  options: { group?: string; lastConnectedAt?: string; proxyJump?: string[] } = {},
): ManagedHost {
  const entry: SshHostEntry = {
    alias,
    aliases: [alias],
    file: '/home/test/.ssh/config',
    options: {},
    resolved: {
      hostname: `${alias}.example.test`,
      port: 22,
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump: options.proxyJump ?? [],
      forwards: [],
      passwordOnly: false,
    },
    metadata: {
      profileId: `ssh-${alias}`,
      group: options.group,
      lastConnectedAt: options.lastConnectedAt,
      connectCount: 0,
    },
  };
  return { kind: 'ssh', entry };
}

function telnetHost(name: string): ManagedHost {
  const entry = {
    id: name,
    name,
    kind: 'telnet',
    profile: { kind: 'telnet', host: `${name}.example.test`, port: 23 },
    metadata: {},
  } as unknown as SavedHostProfile;
  return { kind: 'profile', entry };
}

const rows = (hosts: readonly ManagedHost[]) => hosts.map((host) => hostsTableRow(host));
const names = (sorted: readonly { name: string }[]) => sorted.map((row) => row.name);

describe('what a table row says', () => {
  it('reads the kind, the folder and the jump route of a host', () => {
    const host = sshHost('db-01', { group: 'Production/Data', proxyJump: ['bastion', 'edge'] });
    expect(managedHostKind(host)).toBe('ssh');
    expect(managedHostKind(telnetHost('console'))).toBe('telnet');
    expect(hostFolderLabel(host)).toBe('Production / Data');
    expect(hostFolderLabel(host, 1)).toBe('Data');
    expect(hostFolderLabel(sshHost('loose'))).toBe('');
    expect(hostJumpRoute(host)).toBe('bastion → edge');
    expect(hostJumpRoute(sshHost('direct'))).toBe('');
  });
});

describe('sorting the table', () => {
  const hosts = [
    sshHost('web-10', { group: 'Production/Web', lastConnectedAt: '2026-11-20T10:00:00Z' }),
    sshHost('web-2', { group: 'Production/Web' }),
    telnetHost('console'),
    sshHost('build', { group: 'Lab', lastConnectedAt: '2026-11-01T10:00:00Z' }),
  ];

  it('keeps the given order while no column is picked', () => {
    expect(names(sortHostsTableRows(rows(hosts), DEFAULT_HOSTS_TABLE_SORT))).toEqual([
      'web-10',
      'web-2',
      'console',
      'build',
    ]);
  });

  it('sorts names the way people count', () => {
    expect(names(sortHostsTableRows(rows(hosts), { column: 'name', descending: false }))).toEqual([
      'build',
      'console',
      'web-2',
      'web-10',
    ]);
  });

  it('sinks empty cells to the bottom in either direction', () => {
    const ascending = names(sortHostsTableRows(rows(hosts), { column: 'folder', descending: false }));
    const descending = names(sortHostsTableRows(rows(hosts), { column: 'folder', descending: true }));
    expect(ascending).toEqual(['build', 'web-2', 'web-10', 'console']);
    expect(descending).toEqual(['web-2', 'web-10', 'build', 'console']);
  });

  it('puts hosts never connected after every one that was', () => {
    expect(names(sortHostsTableRows(rows(hosts), { column: 'lastUsed', descending: true }))).toEqual([
      'web-10',
      'build',
      'console',
      'web-2',
    ]);
    expect(names(sortHostsTableRows(rows(hosts), { column: 'lastUsed', descending: false }))).toEqual([
      'build',
      'web-10',
      'console',
      'web-2',
    ]);
  });
});

describe('clicking a column header', () => {
  it('goes ascending, descending, then back to the folders', () => {
    const first = nextHostsTableSort(DEFAULT_HOSTS_TABLE_SORT, 'name');
    expect(first).toEqual({ column: 'name', descending: false });
    const second = nextHostsTableSort(first, 'name');
    expect(second).toEqual({ column: 'name', descending: true });
    expect(nextHostsTableSort(second, 'name')).toEqual(DEFAULT_HOSTS_TABLE_SORT);
  });

  it('starts last used with the newest', () => {
    const first = nextHostsTableSort(DEFAULT_HOSTS_TABLE_SORT, 'lastUsed');
    expect(first).toEqual({ column: 'lastUsed', descending: true });
    expect(nextHostsTableSort(first, 'lastUsed')).toEqual({ column: 'lastUsed', descending: false });
  });

  it('starts over on another column', () => {
    expect(nextHostsTableSort({ column: 'name', descending: true }, 'kind')).toEqual({
      column: 'kind',
      descending: false,
    });
  });
});

describe('a saved sort', () => {
  it('is accepted only in a shape the table knows', () => {
    expect(isHostsTableSort({ descending: false })).toBe(true);
    expect(isHostsTableSort({ column: 'address', descending: true })).toBe(true);
    expect(isHostsTableSort({ column: 'owner', descending: true })).toBe(false);
    expect(isHostsTableSort({ column: 'name' })).toBe(false);
    expect(isHostsTableSort(null)).toBe(false);
  });
});

describe('when a host was last used', () => {
  const now = new Date(2026, 10, 21, 15, 0).getTime();
  const at = (year: number, month: number, day: number, hour = 12) =>
    new Date(year, month, day, hour).getTime();

  it('counts calendar days, not hours', () => {
    expect(formatLastUsed(undefined, now)).toBe('Never');
    expect(formatLastUsed(at(2026, 10, 21, 1), now)).toBe('Today');
    expect(formatLastUsed(at(2026, 10, 20, 23), now)).toBe('Yesterday');
    expect(formatLastUsed(at(2026, 10, 16), now)).toBe('5 days ago');
    expect(formatLastUsed(at(2026, 9, 31), now)).toBe('3 weeks ago');
    expect(formatLastUsed(at(2026, 6, 1), now)).toBe('4 months ago');
    expect(formatLastUsed(at(2025, 6, 1), now)).toBe('A year ago');
    expect(formatLastUsed(at(2023, 6, 1), now)).toBe('3 years ago');
  });
});
