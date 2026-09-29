import { describe, expect, it } from 'vitest';
import type {
  SavedHostProfile,
  SshHostEntry,
  WorkspaceSummary,
} from '@muxus/shared';
import {
  resolveCommandLineFolder,
  resolveCommandLineHost,
  resolveCommandLineWorkspace,
} from '../../../client/src/command-line-launch.js';
import { managedHostKey } from '../../../client/src/managed-hosts.js';

const ROOT = '/home/test/.ssh/config';
const LAB_FILE = '/home/test/.ssh/lab.conf';

function sshHost(
  alias: string,
  group?: string,
  file = ROOT,
  displayName?: string,
): SshHostEntry {
  return {
    alias,
    aliases: [alias, `${alias}.example.test`],
    file,
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
      group || displayName
        ? { profileId: `ssh-${alias}`, group, displayName, connectCount: 0 }
        : undefined,
  };
}

function savedHost(name: string, group?: string, displayName?: string): SavedHostProfile {
  return {
    id: `saved-${name.toLocaleLowerCase().replaceAll(' ', '-')}`,
    kind: 'telnet',
    name,
    profile: {
      kind: 'telnet',
      profileId: `saved-${name}`,
      host: `${name.toLocaleLowerCase()}.example.test`,
      port: 23,
    },
    metadata: {
      profileId: `saved-${name}`,
      group,
      displayName,
      connectCount: 0,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function workspace(id: string, name: string): WorkspaceSummary {
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isLocked: false,
    isStartup: false,
  };
}

describe('command-line host resolution', () => {
  it('matches SSH aliases and saved-host names case-insensitively', () => {
    const ssh = sshHost('edge-1');
    const saved = savedHost('Console One');

    const sshResolution = resolveCommandLineHost('EDGE-1.EXAMPLE.TEST', [ssh], [saved]);
    const savedResolution = resolveCommandLineHost('console one', [ssh], [saved]);

    expect(sshResolution.status).toBe('found');
    expect(savedResolution.status).toBe('found');
    if (sshResolution.status === 'found') {
      expect(managedHostKey(sshResolution.value)).toBe('ssh:edge-1');
    }
    if (savedResolution.status === 'found') {
      expect(managedHostKey(savedResolution.value)).toBe('profile:saved-console-one');
    }
  });

  it('uses display names only after stable names and reports collisions', () => {
    const stable = sshHost('core', undefined, ROOT, 'Shared');
    const duplicateDisplay = savedHost('Console', undefined, 'Shared');

    expect(resolveCommandLineHost('core', [stable], [duplicateDisplay])).toMatchObject({
      status: 'found',
      value: { kind: 'ssh' },
    });
    expect(resolveCommandLineHost('shared', [stable], [duplicateDisplay])).toEqual({
      status: 'ambiguous',
      count: 2,
    });
  });
});

describe('command-line folder resolution', () => {
  const hosts = [
    sshHost('edge-eu', 'Production/EU/Edge'),
    sshHost('core-eu', 'Production/EU/Core'),
    sshHost('edge-us', 'Production/US/Edge'),
    sshHost('lab-router', undefined, LAB_FILE),
  ];
  const saved = [savedHost('EU console', 'Production/EU')];

  it('launches every descendant of an exact folder path', () => {
    const resolution = resolveCommandLineFolder(
      'production/eu',
      hosts,
      saved,
      [ROOT, LAB_FILE],
      ROOT,
    );

    expect(resolution.status).toBe('found');
    if (resolution.status === 'found') {
      expect(resolution.value.label).toBe('Production/EU');
      expect(resolution.value.hosts.map(managedHostKey).sort()).toEqual([
        'profile:saved-eu-console',
        'ssh:core-eu',
        'ssh:edge-eu',
      ]);
    }
  });

  it('accepts ssh_config file-group labels and rejects ambiguous leaf labels', () => {
    const fileResolution = resolveCommandLineFolder(
      'lab',
      hosts,
      saved,
      [ROOT, LAB_FILE],
      ROOT,
    );
    const ambiguous = resolveCommandLineFolder(
      'Edge',
      hosts,
      saved,
      [ROOT, LAB_FILE],
      ROOT,
    );

    expect(fileResolution.status).toBe('found');
    if (fileResolution.status === 'found') {
      expect(fileResolution.value.hosts.map(managedHostKey)).toEqual(['ssh:lab-router']);
    }
    expect(ambiguous).toEqual({ status: 'ambiguous', count: 2 });
  });
});

describe('command-line workspace resolution', () => {
  const workspaces = [
    workspace('production-id', 'Production'),
    workspace('duplicate-a', 'Lab'),
    workspace('duplicate-b', 'lab'),
  ];

  it('matches IDs before names and detects duplicate names', () => {
    expect(resolveCommandLineWorkspace('PRODUCTION-ID', workspaces)).toMatchObject({
      status: 'found',
      value: { id: 'production-id' },
    });
    expect(resolveCommandLineWorkspace('production', workspaces)).toMatchObject({
      status: 'found',
      value: { id: 'production-id' },
    });
    expect(resolveCommandLineWorkspace('lab', workspaces)).toEqual({
      status: 'ambiguous',
      count: 2,
    });
    expect(resolveCommandLineWorkspace('missing', workspaces)).toEqual({
      status: 'not-found',
    });
  });
});
