import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import { groupHosts } from '../../../client/src/host-organization.js';
import {
  bestManagedHostMatch,
  managedHostKey,
  type ManagedHost,
} from '../../../client/src/managed-hosts.js';

const ROOT = '/home/test/.ssh/config';

function sshHost(
  alias: string,
  options: { group?: string; favorite?: boolean; hostname?: string } = {},
): SshHostEntry {
  return {
    alias,
    aliases: [alias],
    file: ROOT,
    options: {},
    resolved: {
      hostname: options.hostname ?? `${alias}.example.test`,
      port: 22,
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump: [],
      forwards: [],
      passwordOnly: false,
    },
    metadata: {
      profileId: `ssh-${alias}`,
      favorite: options.favorite ?? false,
      group: options.group,
      connectCount: 0,
    },
  };
}

const managed = (entry: SshHostEntry): ManagedHost => ({ kind: 'ssh', entry });

describe('host search', () => {
  it('matches every token separately, across name and folder', () => {
    const hosts = [
      sshHost('MyAirframe1Tail', { group: 'AF-Tails' }),
      sshHost('MyAirframe1', { group: 'AFs' }),
    ];
    const aliases = groupHosts(hosts, [ROOT], ROOT, 'af tail').flatMap((group) =>
      group.hosts.map((host) => host.alias),
    );
    expect(aliases).toEqual(['MyAirframe1Tail']);
  });

  it('keeps matching a plain substring anywhere in the host', () => {
    const hosts = [sshHost('router', { hostname: 'edge01.lab.test' }), sshHost('switch')];
    const aliases = groupHosts(hosts, [ROOT], ROOT, 'edge01').flatMap((group) =>
      group.hosts.map((host) => host.alias),
    );
    expect(aliases).toEqual(['router']);
  });

  it('ranks an exact name over a prefix, and a prefix over a metadata hit', () => {
    const hosts = [
      managed(sshHost('lab-gateway')),
      managed(sshHost('gateway-backup')),
      managed(sshHost('router', { group: 'gateway' })),
      managed(sshHost('gateway')),
    ];
    expect(bestManagedHostMatch(hosts, 'gateway')).toBe(hosts[3]);
    expect(bestManagedHostMatch(hosts.slice(0, 3), 'gateway')).toBe(hosts[1]);
    expect(bestManagedHostMatch(hosts.slice(2, 3), 'gateway')).toBe(hosts[2]);
  });

  it('breaks an even tie with the starred host', () => {
    const hosts = [
      managed(sshHost('edge-a', { hostname: 'core.example.test' })),
      managed(sshHost('edge-b', { hostname: 'core.example.test', favorite: true })),
    ];
    expect(bestManagedHostMatch(hosts, 'core')).toBe(hosts[1]);
  });

  it('has no answer for an empty query or a query nothing matches', () => {
    const hosts = [managed(sshHost('router'))];
    expect(bestManagedHostMatch(hosts, '')).toBeUndefined();
    expect(bestManagedHostMatch(hosts, 'nothing-like-this')).toBeUndefined();
  });

  it('identifies the winner by the same key the tree rows carry', () => {
    const host = managed(sshHost('router'));
    expect(managedHostKey(bestManagedHostMatch([host], 'router')!)).toBe('ssh:router');
  });
});
