import { beforeEach, describe, expect, it } from 'vitest';
import {
  savedHostHop,
  type ContainerlabLab,
  type HostEnvironment,
  type KubernetesPod,
  type SavedHostProfile,
  type SshHostEntry,
} from '@muxus/shared';
import {
  environmentBadges,
  environmentHostForManaged,
  environmentHostForProfile,
  discoveryEnabledFor,
  forgetDisconnectedHosts,
  liveConnectionFor,
  podWorkload,
} from '../../../client/src/environments.js';
import {
  containerlabNodeEntry,
  environmentProfile,
  kubusPodRoute,
  portScheme,
  sshThroughHost,
} from '../../../client/src/environment-sessions.js';
import { environmentLaunchItems } from '../../../client/src/environment-launcher.js';
import { useEnvironmentsStore, type HostEnvironmentsEntry } from '../../../client/src/state/environments.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useTabsStore, type TerminalTab } from '../../../client/src/state/tabs.js';

const savedPve = {
  id: 'p-pve',
  name: 'PVE',
  profile: { kind: 'ssh', target: 'pve.example.test', useConfig: false, user: 'root' },
  metadata: { color: '#e8862f' },
} as unknown as SavedHostProfile;
const configHost = { alias: 'build-01', aliases: ['build-01'], metadata: {} } as unknown as SshHostEntry;

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    unreadOutputIds: new Set(),
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
  });
});

describe('environment hosts', () => {
  it('stands for SSH hosts only, keyed like the sidebar', () => {
    expect(environmentHostForManaged({ kind: 'profile', entry: savedPve })).toEqual({
      key: 'profile:p-pve',
      label: 'PVE',
      profile: { kind: 'ssh', target: 'pve.example.test', useConfig: false, user: 'root', profileId: 'p-pve' },
      color: '#e8862f',
    });
    expect(environmentHostForManaged({ kind: 'ssh', entry: configHost })?.profile).toEqual({
      kind: 'ssh',
      target: 'build-01',
    });
    const serial = { ...savedPve, profile: { kind: 'serial', path: '/dev/ttyUSB0' } } as unknown as SavedHostProfile;
    expect(environmentHostForManaged({ kind: 'profile', entry: serial })).toBeUndefined();
  });

  it('maps a tab to its host, or to an ad-hoc target', () => {
    expect(environmentHostForProfile({ kind: 'ssh', target: 'build-01' }, [configHost], [])?.key).toBe('ssh:build-01');
    expect(environmentHostForProfile({ kind: 'ssh', target: 'admin@10.0.0.9' }, [], [])).toMatchObject({
      key: 'target:admin@10.0.0.9',
      profile: { kind: 'ssh', target: 'admin@10.0.0.9' },
    });
    expect(environmentHostForProfile({ kind: 'local' }, [], [])).toBeUndefined();
  });

  it('finds a connected tab’s transport to the same host', () => {
    const host = environmentHostForManaged({ kind: 'profile', entry: savedPve })!;
    useTabsStore.setState({
      tabs: [
        { id: 'a', status: 'connecting', connId: 'c1', profile: { kind: 'ssh', target: 'x', profileId: 'p-pve' } },
        { id: 'b', status: 'connected', connId: 'c2', profile: { kind: 'ssh', target: 'pve.example.test' } },
        { id: 'c', status: 'connected', connId: 'c3', profile: { kind: 'ssh', target: 'x', profileId: 'p-pve' } },
      ] as unknown as TerminalTab[],
    });
    expect(liveConnectionFor(host)).toBe('c3');
  });

  it('follows a host’s own discovery choice before the global setting', () => {
    const host = environmentHostForManaged({
      kind: 'profile',
      entry: { ...savedPve, metadata: { discoverEnvironments: false } } as unknown as SavedHostProfile,
    })!;
    expect(host.discover).toBe(false);
    usePrefsStore.setState({ discoverEnvironments: true });
    expect(discoveryEnabledFor(host)).toBe(false);
    expect(discoveryEnabledFor({ ...host, discover: undefined })).toBe(true);
    usePrefsStore.setState({ discoverEnvironments: false });
    expect(discoveryEnabledFor({ ...host, discover: true })).toBe(true);
    expect(discoveryEnabledFor({ ...host, discover: undefined })).toBe(false);
  });

  it('forgets hosts nobody is connected to, except this computer and the one the panel shows', () => {
    const pve = environmentHostForManaged({ kind: 'profile', entry: savedPve })!;
    const build = environmentHostForManaged({ kind: 'ssh', entry: configHost })!;
    const store = useEnvironmentsStore.getState();
    for (const host of [{ key: 'local', label: 'This computer' }, pve, build]) {
      store.update(host, { status: 'ready', environments: [{ kind: 'kubernetes', contexts: ['a'] }] });
    }
    useTabsStore.setState({
      tabs: [
        { id: 'a', status: 'connected', connId: 'c1', profile: { kind: 'ssh', target: 'x', profileId: 'p-pve' } },
      ] as unknown as TerminalTab[],
    });
    forgetDisconnectedHosts(build.key);
    expect(Object.keys(useEnvironmentsStore.getState().entries).sort()).toEqual(['local', 'profile:p-pve', 'ssh:build-01']);
    forgetDisconnectedHosts();
    expect(Object.keys(useEnvironmentsStore.getState().entries).sort()).toEqual(['local', 'profile:p-pve']);
    useTabsStore.setState({ tabs: [] });
    forgetDisconnectedHosts();
    expect(Object.keys(useEnvironmentsStore.getState().entries)).toEqual(['local']);
  });
});

describe('environmentBadges', () => {
  it('counts what runs, leaving lab nodes to their lab', () => {
    const environments: HostEnvironment[] = [
      {
        kind: 'containers',
        runtime: 'docker',
        containers: [
          { id: '1', name: 'web', image: 'nginx', state: 'running', status: 'Up', ports: [] },
          { id: '2', name: 'old', image: 'nginx', state: 'exited', status: 'Exited (0)', ports: [] },
          {
            id: '3',
            name: 'clab-x-n1',
            image: 'srl',
            state: 'running',
            status: 'Up',
            ports: [],
            containerlab: { lab: 'x', node: 'n1', kind: 'nokia_srlinux' },
          },
        ],
      },
      { kind: 'containerlab', labs: [{ name: 'x', runtime: 'docker', nodes: [] }] },
      { kind: 'kubernetes', contexts: ['a', 'b'] },
      { kind: 'libvirt', domains: [{ name: 'off', state: 'shut off', uri: 'qemu:///session' }] },
    ];
    expect(environmentBadges(environments).map(({ kind, count }) => [kind, count])).toEqual([
      ['docker', 1],
      ['containerlab', 1],
      ['kubernetes', 2],
      // A hypervisor shows even when its VMs are stopped.
      ['libvirt', 0],
    ]);
    // A host with no running containers, or a hypervisor without VMs, shows nothing.
    expect(
      environmentBadges([
        { kind: 'containers', runtime: 'podman', containers: [] },
        { kind: 'libvirt', domains: [] },
        { kind: 'proxmox', guests: [] },
      ]),
    ).toEqual([]);
  });
});

describe('environment sessions', () => {
  const remote = environmentHostForManaged({ kind: 'profile', entry: savedPve })!;
  const local = { key: 'local', label: 'This computer' };

  it('enters a target locally or through the host’s own profile', () => {
    const target = { kind: 'container', runtime: 'docker', container: 'web' } as const;
    expect(environmentProfile(local, target)).toEqual({ kind: 'local', environment: target });
    expect(environmentProfile(remote, target)).toMatchObject({ kind: 'ssh', profileId: 'p-pve', environment: target });
  });

  it('jumps through the host to addresses only it can reach', () => {
    expect(sshThroughHost(remote, '10.0.0.21', 'ubuntu')).toEqual({
      kind: 'ssh',
      target: 'ubuntu@10.0.0.21',
      proxyJump: [savedHostHop('p-pve')],
    });
    expect(sshThroughHost({ key: 'ssh:b', label: 'b', profile: { kind: 'ssh', target: 'b' } }, 'fd00::1')).toEqual({
      kind: 'ssh',
      target: '[fd00::1]',
      proxyJump: ['b'],
    });
    expect(sshThroughHost(local, '172.20.20.2', 'admin')).toEqual({ kind: 'ssh', target: 'admin@172.20.20.2' });
  });

  it('opens network OS lab nodes with SSH and Linux nodes with exec', () => {
    const lab: ContainerlabLab = {
      name: 'evpn',
      runtime: 'docker',
      nodes: [
        { name: 'leaf1', container: 'clab-evpn-leaf1', kind: 'nokia_srlinux', image: 'srl', state: 'running', ipv4: '172.20.20.4' },
        { name: 'client1', container: 'clab-evpn-client1', kind: 'linux', image: 'alpine', state: 'running', ipv4: '172.20.20.7' },
      ],
    };
    expect(containerlabNodeEntry(local, lab, lab.nodes[0]!).profile).toEqual({ kind: 'ssh', target: 'admin@172.20.20.4' });
    expect(containerlabNodeEntry(local, lab, lab.nodes[1]!).profile).toEqual({
      kind: 'local',
      environment: { kind: 'container', runtime: 'docker', container: 'clab-evpn-client1' },
    });
  });

  it('knows web ports and Kubus routes', () => {
    expect(portScheme(8006)).toBe('https');
    expect(portScheme(3000)).toBe('http');
    expect(kubusPodRoute('kind-dev', 'default', 'api-1')).toBe('/r/core/v1/pods?sel=kind-dev%7Cdefault%7Capi-1');
  });
});

describe('podWorkload', () => {
  it('names the Deployment behind a ReplicaSet', () => {
    const pod = (owner?: KubernetesPod['owner']) =>
      ({ name: 'p', namespace: 'n', phase: 'Running', ready: '1/1', restarts: 0, containers: [], owner }) as KubernetesPod;
    expect(podWorkload(pod({ kind: 'ReplicaSet', name: 'api-7f9c4d' }))).toEqual({ kind: 'Deployment', name: 'api' });
    expect(podWorkload(pod({ kind: 'StatefulSet', name: 'postgres' }))).toEqual({ kind: 'StatefulSet', name: 'postgres' });
    expect(podWorkload(pod())).toBeUndefined();
  });
});

describe('environmentLaunchItems', () => {
  it('offers running things by name, with where they run', () => {
    const entry = {
      key: 'local',
      label: 'This computer',
      status: 'ready',
      automatic: true,
      problems: [],
      environments: [
        {
          kind: 'containers',
          runtime: 'docker',
          containers: [
            { id: '1', name: 'grafana', image: 'grafana/grafana:11', state: 'running', status: 'Up', ports: [], composeProject: 'monitoring' },
            { id: '2', name: 'stopped', image: 'x', state: 'exited', status: 'Exited', ports: [] },
          ],
        },
        { kind: 'proxmox', guests: [{ vmid: 101, name: 'runner', type: 'qemu', status: 'running' }] },
      ],
    } as HostEnvironmentsEntry;
    expect(environmentLaunchItems([entry]).map(({ label, detail }) => [label, detail])).toEqual([
      ['grafana', 'This computer › Docker · monitoring · grafana/grafana:11'],
      ['runner', 'This computer › Proxmox VM 101 · serial console'],
    ]);
  });
});
