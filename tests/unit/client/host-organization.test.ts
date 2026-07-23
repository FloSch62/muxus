import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import { groupHosts, hostOrderAfterDrop } from '../../../client/src/host-organization.js';

const host = (
  alias: string,
  options: { file?: string; group?: string; favorite?: boolean; displayName?: string; sortOrder?: number } = {},
): SshHostEntry => ({
  alias,
  aliases: [alias],
  file: options.file ?? '/home/test/.ssh/config',
  options: {},
  resolved: {
    hostname: `${alias}.example.com`,
    port: 22,
    identityFiles: [],
    identitiesOnly: false,
    forwardAgent: false,
    proxyJump: [],
    forwards: [],
    passwordOnly: false,
  },
  metadata:
    options.group || options.favorite || options.displayName || options.sortOrder !== undefined
      ? {
          profileId: alias,
          favorite: options.favorite ?? false,
          group: options.group,
          displayName: options.displayName,
          sortOrder: options.sortOrder,
          connectCount: 0,
        }
      : undefined,
});

describe('host organization', () => {
  it('builds same-group and cross-group drop orders', () => {
    expect(hostOrderAfterDrop(['alpha', 'bravo', 'charlie'], 'alpha', 'bravo', 'after')).toEqual([
      'bravo',
      'alpha',
      'charlie',
    ]);
    expect(hostOrderAfterDrop(['alpha', 'bravo'], 'charlie', 'alpha', 'before')).toEqual([
      'charlie',
      'alpha',
      'bravo',
    ]);
    expect(hostOrderAfterDrop(['alpha', 'bravo'], 'charlie')).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('puts custom groups first while retaining config-file structure for ungrouped hosts', () => {
    const groups = groupHosts(
      [
        host('plain'),
        host('database', { group: 'Production' }),
        host('api', { group: 'Production', favorite: true }),
        host('lab', { file: '/home/test/.ssh/config.d/lab.conf' }),
      ],
      ['/home/test/.ssh/config', '/home/test/.ssh/config.d/lab.conf'],
      '/home/test/.ssh/config',
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Production',
      'Ungrouped',
      'Ungrouped · lab',
    ]);
    expect(groups[0]?.hosts.map((entry) => entry.alias)).toEqual(['api', 'database']);
  });

  it('searches group and display names', () => {
    const hosts = [
      host('db-01', { group: 'Production', displayName: 'Primary database' }),
      host('web-01', { group: 'Staging' }),
    ];

    expect(groupHosts(hosts, [], undefined, 'production')[0]?.hosts[0]?.alias).toBe('db-01');
    expect(groupHosts(hosts, [], undefined, 'primary')[0]?.hosts[0]?.alias).toBe('db-01');
  });

  it('uses a persisted drag order ahead of favorites and display names', () => {
    const groups = groupHosts(
      [
        host('alpha', { favorite: true, sortOrder: 2 }),
        host('bravo', { sortOrder: 0 }),
        host('charlie', { sortOrder: 1 }),
      ],
      ['/home/test/.ssh/config'],
      '/home/test/.ssh/config',
    );

    expect(groups[0]?.hosts.map((entry) => entry.alias)).toEqual(['bravo', 'charlie', 'alpha']);
  });
});
