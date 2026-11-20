import { describe, expect, it } from 'vitest';
import {
  savedHostHop,
  type FolderSettingsRecord,
  type SavedHostProfile,
  type SshHostEntry,
} from '@muxus/shared';
import type { ManagedHost } from '../../../client/src/managed-hosts.js';
import { parseSharedSessions } from '../../../client/src/shared-sessions.js';
import { shareFolder, sharedSessionsFilename } from '../../../client/src/shared-sessions-export.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
const ALL = { includeUsers: true, includeKeyPaths: true };

function saved(
  id: string,
  profile: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): ManagedHost {
  return {
    kind: 'profile',
    entry: {
      id,
      kind: profile.kind,
      name: id,
      profile: { ...profile, profileId: id },
      metadata: { profileId: id, connectCount: 0, ...metadata },
      createdAt: '',
      updatedAt: '',
    } as unknown as SavedHostProfile,
  };
}

function configured(
  alias: string,
  resolved: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
): ManagedHost {
  return {
    kind: 'ssh',
    entry: {
      alias,
      aliases: [alias],
      file: '/home/me/.ssh/config',
      options,
      resolved: {
        hostname: alias,
        port: 22,
        identityFiles: [],
        certificateFiles: [],
        identitiesOnly: false,
        forwardAgent: false,
        proxyJump: [],
        forwards: [],
        passwordOnly: false,
        ...resolved,
      },
      metadata: { profileId: `meta-${alias}`, connectCount: 0, ...metadata },
    } as unknown as SshHostEntry,
  };
}

const hosts: ManagedHost[] = [
  saved('leaf', { kind: 'ssh', target: 'leaf-01.lab.example.net', useConfig: false, user: 'admin', identityFiles: ['~/.ssh/lab'], proxyJump: [savedHostHop('bastion')] }, { group: 'Lab/Fabric', color: '#a855f7', icon: 'router' }),
  saved('console', { kind: 'telnet', host: 'console.lab.example.net', port: 2001 }, { group: 'Lab' }),
  saved('desk', { kind: 'vnc', host: '10.0.0.9', port: 5900, username: 'me', sshGateway: { target: 'gw' } }, { group: 'lab/Desktops' }),
  configured('build', { hostname: 'build-01.lab.example.net', user: 'ci', port: 2222, proxyJump: ['gw'], forwardAgent: true, proxyCommand: 'nc %h %p' }, { group: 'Lab', displayName: 'Build box' }, { remoteCommand: 'tmux attach', strictHostKeyChecking: 'no' }),
  // Outside the folder: only what the folder's hosts go through comes along.
  saved('bastion', { kind: 'ssh', target: 'bastion.example.net', useConfig: false, user: 'jump', proxyJump: ['gw'] }, { group: 'Infra' }),
  configured('gw', { hostname: 'gw.example.net', user: 'ops' }, { group: 'Infra' }),
  saved('other', { kind: 'ssh', target: 'other.example.net', useConfig: false }, { group: 'Production' }),
  saved('labrador', { kind: 'ssh', target: 'dog.example.net', useConfig: false }, { group: 'Labrador' }),
];

describe('sharing a folder as a session list', () => {
  it('lists the folder’s hosts with the folders they sit in', () => {
    const { document, hostCount, jumpHostCount } = shareFolder('Lab', hosts, [], ALL, NOW);

    expect(hostCount).toBe(4);
    expect(jumpHostCount).toBe(2);
    expect(document).toMatchObject({
      format: 'muxus-shared-sessions',
      version: 1,
      name: 'Lab',
      createdAt: '2026-11-20T10:00:00.000Z',
    });
    expect(document.hosts.map((host) => [host.name, host.folder])).toEqual([
      ['leaf', 'Fabric'],
      ['console', undefined],
      ['desk', 'Desktops'],
      ['Build box', undefined],
      ['bastion', 'Jump hosts'],
      ['gw', 'Jump hosts'],
    ]);
    expect(document.hosts[0]).toEqual({
      id: 'leaf',
      name: 'leaf',
      folder: 'Fabric',
      color: '#a855f7',
      icon: 'router',
      profile: {
        kind: 'ssh',
        target: 'leaf-01.lab.example.net',
        useConfig: false,
        user: 'admin',
        identityFiles: ['~/.ssh/lab'],
        proxyJump: [savedHostHop('bastion')],
      },
    });
  });

  it('writes ssh_config hosts with what they resolve to, and names every hop by its entry', () => {
    const { document } = shareFolder('Lab', hosts, [], ALL, NOW);
    const byId = new Map(document.hosts.map((host) => [host.id, host]));

    expect(byId.get('ssh:build')!.profile).toEqual({
      kind: 'ssh',
      target: 'build-01.lab.example.net',
      useConfig: false,
      user: 'ci',
      port: 2222,
      proxyJump: [savedHostHop('ssh:gw')],
      remoteCommand: 'tmux attach',
    });
    expect(byId.get('bastion')!.profile).toMatchObject({ proxyJump: [savedHostHop('ssh:gw')] });
    expect(byId.get('desk')!.profile).toMatchObject({
      sshGateway: { target: 'gw.example.net', profileId: 'ssh:gw' },
    });
    expect(byId.get('ssh:gw')!.profile).toEqual({
      kind: 'ssh',
      target: 'gw.example.net',
      useConfig: false,
      user: 'ops',
    });
  });

  it('leaves user names and key paths out when asked to', () => {
    const { document } = shareFolder('Lab', hosts, [], { includeUsers: false, includeKeyPaths: false }, NOW);
    const byId = new Map(document.hosts.map((host) => [host.id, host]));

    expect(byId.get('leaf')!.profile).toEqual({
      kind: 'ssh',
      target: 'leaf-01.lab.example.net',
      useConfig: false,
      proxyJump: [savedHostHop('bastion')],
    });
    expect(byId.get('desk')!.profile).not.toHaveProperty('username');
    expect(byId.get('ssh:build')!.profile).not.toHaveProperty('user');
  });

  it('fills in what a host inherits from its folder', () => {
    const settings = [
      { id: '1', path: 'Lab', auth: { user: 'labuser', port: 2200, identityFiles: ['~/.ssh/folder'] }, hasPassword: true },
      { id: '2', path: 'Lab/Fabric', auth: { user: 'fabric' } },
    ] as unknown as FolderSettingsRecord[];
    const inheriting = [
      saved('a', { kind: 'ssh', target: 'a.example.net', useConfig: false }, { group: 'Lab/Fabric' }),
      saved('b', { kind: 'ssh', target: 'b.example.net', useConfig: false, user: 'own' }, { group: 'Lab' }),
      configured('c', { hostname: 'c.example.net' }, { group: 'Lab' }),
    ];

    const { document } = shareFolder('Lab', inheriting, settings, ALL, NOW);

    expect(document.hosts.map((host) => host.profile)).toEqual([
      { kind: 'ssh', target: 'a.example.net', useConfig: false, user: 'fabric', port: 2200, identityFiles: ['~/.ssh/folder'] },
      { kind: 'ssh', target: 'b.example.net', useConfig: false, user: 'own', port: 2200, identityFiles: ['~/.ssh/folder'] },
      { kind: 'ssh', target: 'c.example.net', useConfig: false, user: 'labuser', port: 2200, identityFiles: ['~/.ssh/folder'] },
    ]);
  });

  it('names the file after the folder', () => {
    expect(sharedSessionsFilename('Teams/Lab EU (new)')).toBe('lab-eu-new.muxus-sessions.json');
    expect(sharedSessionsFilename('…')).toBe('shared.muxus-sessions.json');
  });
});

describe('following a shared folder', () => {
  it('rebuilds the folder, with every hop pointing at the host the list brought', () => {
    const { document } = shareFolder('Lab', hosts, [], ALL, NOW);

    const list = parseSharedSessions(JSON.stringify(document), { id: 'link', folder: 'Team lab' });
    const byName = new Map(list.hosts.map((host) => [host.name, host]));
    const id = (name: string) => byName.get(name)!.id;

    expect(list.format).toBe('muxus');
    expect(list.skipped).toBe(0);
    expect(list.hosts.map((host) => [host.name, host.group])).toEqual([
      ['leaf', 'Team lab/Fabric'],
      ['console', 'Team lab'],
      ['desk', 'Team lab/Desktops'],
      ['Build box', 'Team lab'],
      ['bastion', 'Team lab/Jump hosts'],
      ['gw', 'Team lab/Jump hosts'],
    ]);
    expect(byName.get('leaf')).toMatchObject({
      color: '#a855f7',
      icon: 'router',
      profile: { user: 'admin', proxyJump: [savedHostHop(id('bastion'))] },
    });
    expect(byName.get('bastion')!.profile).toMatchObject({ proxyJump: [savedHostHop(id('gw'))] });
    expect(byName.get('Build box')!.profile).toMatchObject({ proxyJump: [savedHostHop(id('gw'))] });
    expect(byName.get('desk')!.profile).toMatchObject({
      sshGateway: { target: 'gw.example.net', profileId: id('gw') },
    });
    expect(list.hosts.every((host) => host.id.startsWith('shared-'))).toBe(true);
  });

  it('refuses a list from a newer Muxus instead of guessing', () => {
    expect(() =>
      parseSharedSessions(
        JSON.stringify({ format: 'muxus-shared-sessions', version: 2, hosts: [] }),
        { id: 'link', folder: 'Lab' },
      ),
    ).toThrow('This session list was written by a newer Muxus. Update Muxus to follow it.');
  });

  it('reads a hand-written list that has only names and profiles', () => {
    const list = parseSharedSessions(
      JSON.stringify({
        format: 'muxus-shared-sessions',
        hosts: [
          { name: 'node0', folder: 'clab', profile: { kind: 'ssh', target: 'node0.lab.example.net', user: 'alice' } },
          { name: 'broken' },
        ],
      }),
      { id: 'link', folder: 'Lab' },
    );

    expect(list.skipped).toBe(1);
    expect(list.hosts).toEqual([
      {
        id: expect.stringMatching(/^shared-/),
        name: 'node0',
        group: 'Lab/clab',
        profile: { kind: 'ssh', target: 'node0.lab.example.net', user: 'alice', useConfig: false },
      },
    ]);
  });
});
