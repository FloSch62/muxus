import { beforeEach, describe, expect, it } from 'vitest';
import { savedHostHop, type SavedHostProfile, type SshHostEntry } from '@muxus/shared';
import {
  enterHostDraft,
  jumpHostDraft,
  localEnterProfile,
  type HostDirectory,
} from '../../../client/src/environment-hosts.js';
import type { EnvironmentHost } from '../../../client/src/state/environments.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';

const saved = {
  id: 'p-hv',
  kind: 'ssh',
  name: 'Hypervisor',
  profile: { kind: 'ssh', target: 'hv.lab', useConfig: false, user: 'root', port: 2222, profileId: 'p-hv' },
  metadata: { profileId: 'p-hv', group: 'Lab', connectCount: 0 },
  createdAt: '',
  updatedAt: '',
} as unknown as SavedHostProfile;
const openssh = {
  alias: 'build-01',
  aliases: ['build-01'],
  file: '/home/u/.ssh/config',
  options: { user: 'ci', localForwards: [] },
  resolved: { hostname: 'build-01.example.test', port: 22, identityFiles: [], certificateFiles: [] },
  metadata: { group: 'CI' },
} as unknown as SshHostEntry;
const hosts: HostDirectory = { sshHosts: [openssh], savedProfiles: [saved] };
const savedHost: EnvironmentHost = { key: 'profile:p-hv', label: 'Hypervisor', profile: { ...saved.profile, kind: 'ssh' } as EnvironmentHost['profile'] };
const configHost: EnvironmentHost = { key: 'ssh:build-01', label: 'build-01', profile: { kind: 'ssh', target: 'build-01' } };

beforeEach(() => usePrefsStore.setState({ newSshHostStorage: 'openssh' }));

describe('adding what a host runs to the sidebar', () => {
  it('copies a saved host and runs the container as its remote command', () => {
    const draft = enterHostDraft(savedHost, hosts, 'web', { kind: 'container', runtime: 'docker', container: 'web' })!;
    expect(draft).toMatchObject({
      storage: 'muxus',
      aliasText: 'web',
      hostname: 'hv.lab',
      user: 'root',
      port: '2222',
      group: 'Lab',
      remoteCommandMode: 'command',
      requestTty: 'force',
      disableSftp: true,
      discoverEnvironments: 'off',
    });
    expect(draft.remoteCommand).toMatch(/^docker exec -it .* web sh -c /);
  });

  it('gives a copied OpenSSH block the host name its alias stood for', () => {
    const draft = enterHostDraft(configHost, hosts, 'my db', { kind: 'container', runtime: 'podman', container: 'db' })!;
    expect(draft).toMatchObject({ storage: 'openssh', aliasText: 'my-db', hostname: 'build-01.example.test', user: 'ci' });
  });

  it('jumps through the host to an address only it reaches', () => {
    expect(jumpHostDraft(savedHost, hosts, { name: 'lab-srl1', address: '172.20.20.2', user: 'admin', group: 'lab' })).toMatchObject({
      storage: 'muxus',
      aliasText: 'lab-srl1',
      hostname: '172.20.20.2',
      user: 'admin',
      group: 'lab',
      routeMode: 'jump',
      proxyJump: [savedHostHop('p-hv')],
    });
    expect(jumpHostDraft(configHost, hosts, { name: 'vm 1', address: '192.168.122.5' })).toMatchObject({
      storage: 'openssh',
      aliasText: 'vm-1',
      routeMode: 'jump',
      proxyJump: ['build-01'],
    });
    // This computer reaches its own guests directly.
    expect(jumpHostDraft({ key: 'local', label: 'This computer' }, hosts, { name: 'vm', address: '10.0.0.5' })).toMatchObject({
      routeMode: 'direct',
      proxyJump: [],
    });
  });

  it('keeps a container on this computer as a local terminal profile', () => {
    expect(localEnterProfile('web', { kind: 'container', runtime: 'docker', container: 'web' })).toMatchObject({
      name: 'web',
      shell: 'docker',
      args: expect.arrayContaining(['exec', '-it', 'web']),
    });
  });
});
