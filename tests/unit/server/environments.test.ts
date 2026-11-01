import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SshProfile } from '@muxus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import {
  actionArgv,
  discoverEnvironments,
} from '../../../server/src/environments/discovery.js';
import {
  containerlabLabs,
  parseDockerPorts,
  parseDockerPs,
  parseInspectAddresses,
  parseKubePods,
  parsePodmanPs,
  parsePveResources,
  parseQemuAgentAddresses,
  parseVirshAddresses,
  parseVirshDisplay,
  parseVirshList,
} from '../../../server/src/environments/parse.js';
import {
  localProbeRunner,
  parseProbeOutput,
  probeFailure,
  probeScript,
  type ProbeResult,
  type ProbeRunner,
} from '../../../server/src/environments/probe-runner.js';
import { environmentSession } from '../../../server/src/ssh/connection-manager.js';

describe('probe script', () => {
  it.skipIf(process.platform === 'win32')('runs each probe on its own and keeps stderr out of stdout', async () => {
    const run = localProbeRunner();
    const results = await run([
      { id: 'ok', argv: ['printf', '%s\n', 'hello world'] },
      { id: 'missing', argv: ['muxus-no-such-tool-anywhere'] },
      { id: 'fails', argv: ['sh', '-c', 'echo out; echo "permission denied" >&2; exit 3'] },
      { id: 'quoted', argv: ['printf', '%s', "it's $(not run)"] },
    ]);
    expect(results.get('ok')).toEqual({ status: 'ran', exitCode: 0, stdout: 'hello world\n', stderr: '' });
    expect(results.get('missing')).toEqual({ status: 'missing' });
    expect(results.get('fails')).toEqual({ status: 'ran', exitCode: 3, stdout: 'out\n', stderr: 'permission denied' });
    expect(results.get('quoted')).toMatchObject({ stdout: "it's $(not run)" });
    expect(probeFailure(results.get('fails'))).toBe('permission denied');
  });

  it('ignores a login banner and reports a cut-off probe as timed out', () => {
    const output = [
      'Welcome! Authorized use only.',
      '',
      '@@muxus-env:a',
      '{"x":1}',
      '@@muxus-env-exit:0',
      '',
      '@@muxus-env:b',
      'partial output',
    ].join('\n');
    const results = parseProbeOutput(output);
    expect(results.get('a')).toEqual({ status: 'ran', exitCode: 0, stdout: '{"x":1}', stderr: '' });
    expect(results.get('b')).toMatchObject({ status: 'ran', exitCode: 124 });
    expect(probeFailure(results.get('b'))).toBe('did not answer in time');
  });

  it('reports the sentence a tool ends with, not its log lines', () => {
    expect(
      probeFailure({
        status: 'ran',
        exitCode: 1,
        stdout: '',
        stderr: [
          'E1101 11:32:54.787058  613673 memcache.go:265] "Unhandled Error" err="couldn\'t get current server API group list"',
          'The connection to the server 127.0.0.1:34121 was refused - did you specify the right host or port?',
        ].join('\n'),
      }),
    ).toBe('The connection to the server 127.0.0.1:34121 was refused - did you specify the right host or port?');
    expect(
      probeFailure({
        status: 'ran',
        exitCode: 1,
        stdout: '',
        stderr: 'setlocale: No such file or directory\nerror: failed to connect to the hypervisor\nerror: authentication unavailable: no polkit agent available',
      }),
    ).toBe('authentication unavailable: no polkit agent available');
  });

  it('quotes every argument', () => {
    expect(probeScript([{ id: 'p', argv: ['docker', 'ps', '--format', '{{json .}}'] }])).toContain(
      "muxus_probe p docker ps --format '{{json .}}'",
    );
  });
});

describe('docker and podman', () => {
  it('reads published ports, keeping one entry per port', () => {
    expect(parseDockerPorts('0.0.0.0:18080->80/tcp, :::18080->80/tcp, 443/tcp, [::]:53->53/udp')).toEqual([
      { containerPort: 80, protocol: 'tcp', hostPort: 18080, hostIp: '0.0.0.0' },
      { containerPort: 443, protocol: 'tcp' },
      { containerPort: 53, protocol: 'udp', hostPort: 53, hostIp: '::' },
    ]);
    expect(parseDockerPorts('127.0.0.1:8000-8001->9000-9001/tcp')).toEqual([
      { containerPort: 9000, protocol: 'tcp', hostPort: 8000, hostIp: '127.0.0.1' },
      { containerPort: 9001, protocol: 'tcp', hostPort: 8001, hostIp: '127.0.0.1' },
    ]);
  });

  it('reads docker ps lines with compose and containerlab labels', () => {
    const line = (fields: Record<string, string>) =>
      JSON.stringify({
        id: 'abcdef0123456789',
        image: 'nginx:1.27',
        state: 'running',
        status: 'Up 3 days',
        ports: '',
        project: '',
        clab: '',
        clabNode: '',
        clabKind: '',
        clabTopo: '',
        clabOwner: '',
        clabInternal: '',
        ...fields,
      });
    const containers = parseDockerPs(
      [
        'WARNING: something',
        line({ name: 'web', project: 'shop', ports: '0.0.0.0:8080->80/tcp' }),
        line({ name: 'clab-evpn-leaf1', clab: 'evpn', clabNode: 'leaf1', clabKind: 'nokia_srlinux', clabTopo: '/labs/evpn.clab.yml' }),
        line({ name: 'clab-evpn-sshx', clab: 'evpn', clabNode: 'sshx', clabInternal: 'true' }),
      ].join('\n'),
    );
    expect(containers.map((c) => c.name)).toEqual(['clab-evpn-leaf1', 'clab-evpn-sshx', 'web']);
    expect(containers[2]).toMatchObject({ id: 'abcdef012345', composeProject: 'shop', ports: [{ hostPort: 8080 }] });
    expect(containers[0]!.containerlab).toEqual({
      lab: 'evpn',
      node: 'leaf1',
      kind: 'nokia_srlinux',
      topologyFile: '/labs/evpn.clab.yml',
    });
    // Containerlab's own helpers are not nodes.
    expect(containers[1]!.containerlab).toBeUndefined();
  });

  it('reads podman ps JSON', () => {
    const containers = parsePodmanPs(
      JSON.stringify([
        {
          Id: '0123456789abcdef',
          Names: ['db'],
          Image: 'docker.io/library/postgres:16',
          State: 'running',
          Status: 'Up 2 hours',
          Ports: [{ host_ip: '', container_port: 5432, host_port: 15432, range: 1, protocol: 'tcp' }],
          Labels: { 'io.podman.compose.project': 'shop' },
        },
      ]),
    );
    expect(containers).toEqual([
      {
        id: '0123456789ab',
        name: 'db',
        image: 'docker.io/library/postgres:16',
        state: 'running',
        status: 'Up 2 hours',
        ports: [{ containerPort: 5432, protocol: 'tcp', hostPort: 15432, hostIp: '0.0.0.0' }],
        composeProject: 'shop',
      },
    ]);
  });

  it('builds labs with management addresses from inspect', () => {
    const containers = parseDockerPs(
      JSON.stringify({
        id: 'a1',
        name: 'clab-evpn-spine1',
        image: 'ghcr.io/nokia/srlinux',
        state: 'running',
        status: 'Up',
        ports: '',
        clab: 'evpn',
        clabNode: 'spine1',
        clabKind: 'nokia_srlinux',
        clabTopo: '/labs/evpn.clab.yml',
      }),
    );
    const addresses = parseInspectAddresses(
      JSON.stringify({
        name: '/clab-evpn-spine1',
        mode: 'clab',
        nets: { clab: { IPAddress: '172.20.20.2', GlobalIPv6Address: '3fff:172:20:20::2' } },
      }),
    );
    expect(containerlabLabs('docker', containers, addresses)).toEqual([
      {
        name: 'evpn',
        runtime: 'docker',
        topologyFile: '/labs/evpn.clab.yml',
        nodes: [
          {
            name: 'spine1',
            container: 'clab-evpn-spine1',
            kind: 'nokia_srlinux',
            image: 'ghcr.io/nokia/srlinux',
            state: 'running',
            ipv4: '172.20.20.2',
            ipv6: '3fff:172:20:20::2',
          },
        ],
      },
    ]);
  });
});

describe('kubernetes', () => {
  it('summarizes pods, with the reason one is not running', () => {
    const pods = parseKubePods(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: 'worker-5d4b8-zq1rt',
              namespace: 'default',
              ownerReferences: [{ kind: 'ReplicaSet', name: 'worker-5d4b8' }],
            },
            spec: { containers: [{ name: 'worker' }], nodeName: 'kind-control-plane' },
            status: {
              phase: 'Running',
              containerStatuses: [
                { ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } },
              ],
            },
          },
          {
            metadata: { name: 'job-1', namespace: 'default' },
            spec: { containers: [{ name: 'job' }] },
            status: {
              phase: 'Succeeded',
              containerStatuses: [{ ready: false, restartCount: 0, state: { terminated: { reason: 'Completed' } } }],
            },
          },
        ],
      }),
    );
    expect(pods[0]).toEqual({
      name: 'job-1',
      namespace: 'default',
      phase: 'Succeeded',
      ready: '0/1',
      restarts: 0,
      containers: ['job'],
    });
    expect(pods[1]).toMatchObject({
      name: 'worker-5d4b8-zq1rt',
      ready: '0/1',
      restarts: 7,
      reason: 'CrashLoopBackOff',
      owner: { kind: 'ReplicaSet', name: 'worker-5d4b8' },
      node: 'kind-control-plane',
    });
  });
});

describe('proxmox and libvirt', () => {
  it('reads cluster resources', () => {
    expect(
      parsePveResources(
        JSON.stringify([
          { vmid: 201, type: 'lxc', name: 'pihole', status: 'running', node: 'pve', cpu: 0.03, maxcpu: 1 },
          { vmid: 101, type: 'qemu', name: 'runner', status: 'stopped', template: 1 },
          { type: 'storage', id: 'local' },
        ]),
      ),
    ).toEqual([
      { vmid: 101, type: 'qemu', name: 'runner', status: 'stopped', template: true },
      { vmid: 201, type: 'lxc', name: 'pihole', status: 'running', node: 'pve', cpu: 0.03, maxcpu: 1 },
    ]);
  });

  it('reads virsh tables', () => {
    expect(
      parseVirshList(
        [' Id   Name            State', '--------------------------------', ' 1    runner          running', ' -    win 11          shut off', ''].join('\n'),
      ),
    ).toEqual([
      { name: 'runner', state: 'running', id: 1 },
      { name: 'win 11', state: 'shut off' },
    ]);
    expect(
      parseVirshAddresses(
        [
          ' Name       MAC address          Protocol     Address',
          '-------------------------------------------------------',
          ' vnet0      52:54:00:aa:bb:cc    ipv6         fe80::1/64',
          ' vnet0      52:54:00:aa:bb:cc    ipv4         192.168.122.10/24',
        ].join('\n'),
      ),
    ).toEqual(['192.168.122.10']);
    expect(parseVirshDisplay('vnc://127.0.0.1:0\n')).toEqual({ host: '127.0.0.1', port: 5900 });
    expect(parseVirshDisplay('vnc://:3')).toEqual({ host: '127.0.0.1', port: 5903 });
    expect(parseVirshDisplay('spice://127.0.0.1:5930')).toBeUndefined();
  });

  it('reads guest agent addresses without loopback or link-local ones', () => {
    expect(
      parseQemuAgentAddresses(
        JSON.stringify([
          { name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1' }] },
          {
            name: 'eth0',
            'ip-addresses': [{ 'ip-address': 'fe80::5054:ff:fe00:1' }, { 'ip-address': '10.0.0.21' }, { 'ip-address': '2001:db8::21' }],
          },
        ]),
      ),
    ).toEqual(['10.0.0.21', '2001:db8::21']);
  });
});

function fakeRunner(outputs: Record<string, ProbeResult>, calls: string[][] = []): ProbeRunner {
  return async (probes) => {
    const results = new Map<string, ProbeResult>();
    for (const probe of probes) {
      calls.push(probe.argv);
      results.set(probe.id, outputs[probe.id] ?? { status: 'missing' });
    }
    return results;
  };
}

const ran = (stdout: string, exitCode = 0, stderr = ''): ProbeResult => ({ status: 'ran', exitCode, stdout, stderr });

describe('discoverEnvironments', () => {
  it('reports only the tools a host has, and why one would not answer', async () => {
    const result = await discoverEnvironments(
      fakeRunner({
        'docker-cli': ran('Docker version 28.0.1, build 068a01e\n'),
        'docker-ps': ran('', 1, 'permission denied while trying to connect to the Docker daemon socket'),
        'kubectl-version': ran('{"clientVersion":{"gitVersion":"v1.31.0"}}'),
        'kubectl-contexts': ran('kind-dev\nprod-eu\n'),
        'kubectl-current': ran('kind-dev\n'),
        'virsh-version': ran('10.0.0\n'),
        'virsh-system': ran(' Id   Name     State\n------\n 1    runner   running\n'),
        'virsh-session': ran(' Id   Name   State\n------\n'),
      }),
    );
    expect(result.problems).toEqual([
      { provider: 'docker', message: 'permission denied while trying to connect to the Docker daemon socket' },
    ]);
    expect(result.environments).toEqual([
      { kind: 'kubernetes', version: 'v1.31.0', contexts: ['kind-dev', 'prod-eu'], currentContext: 'kind-dev' },
      {
        kind: 'libvirt',
        version: '10.0.0',
        domains: [{ name: 'runner', state: 'running', id: 1, uri: 'qemu:///system' }],
      },
    ]);
  });

  it('lists libvirt once, with the session VMs after the system ones', async () => {
    const list = (rows: string) => ran(` Id   Name   State\n------\n${rows}`);
    const libvirt = async (system: string, session: string) =>
      (
        await discoverEnvironments(
          fakeRunner({ 'virsh-version': ran('10.0.0\n'), 'virsh-system': list(system), 'virsh-session': list(session) }),
        )
      ).environments.filter((environment) => environment.kind === 'libvirt');
    expect(await libvirt(' 1    runner   running\n', ' -    desk     shut off\n')).toEqual([
      {
        kind: 'libvirt',
        version: '10.0.0',
        domains: [
          { name: 'runner', state: 'running', id: 1, uri: 'qemu:///system' },
          { name: 'desk', state: 'shut off', uri: 'qemu:///session' },
        ],
      },
    ]);
    // A session URI answered by the system daemon lists the same VMs: shown once.
    expect(await libvirt(' 1    runner   running\n', ' 1    runner   running\n')).toEqual([
      { kind: 'libvirt', version: '10.0.0', domains: [{ name: 'runner', state: 'running', id: 1, uri: 'qemu:///system' }] },
    ]);
  });

  it('lists podman-docker once, under Podman', async () => {
    const result = await discoverEnvironments(
      fakeRunner({
        'docker-cli': ran('', 0, 'Emulate Docker CLI using podman.'),
        'docker-ps': ran('{"id":"x","name":"twice","state":"running"}'),
        'podman-cli': ran('podman version 5.2.0\n'),
        'podman-ps': ran('[]'),
      }),
    );
    expect(result.environments).toEqual([{ kind: 'containers', runtime: 'podman', version: '5.2.0', containers: [] }]);
  });

  it('asks for lab addresses only when there are lab nodes', async () => {
    const calls: string[][] = [];
    await discoverEnvironments(
      fakeRunner(
        {
          'docker-ps': ran(
            JSON.stringify({ id: 'a', name: 'clab-x-n1', state: 'running', clab: 'x', clabNode: 'n1', clabKind: 'linux' }),
          ),
        },
        calls,
      ),
    );
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['docker', 'inspect']);
    expect(calls.at(-1)?.at(-1)).toBe('clab-x-n1');
  });
});

describe('actionArgv', () => {
  it('maps actions to the tools that perform them', () => {
    expect(actionArgv({ kind: 'container', runtime: 'docker', container: 'web', action: 'restart' })).toEqual([
      'docker',
      'restart',
      'web',
    ]);
    expect(actionArgv({ kind: 'container', runtime: 'podman', container: 'old-db', action: 'remove' })).toEqual([
      'podman',
      'rm',
      '--force',
      'old-db',
    ]);
    expect(actionArgv({ kind: 'compose', runtime: 'podman', project: 'shop', action: 'stop' })).toEqual([
      'podman',
      'compose',
      '--project-name',
      'shop',
      'stop',
    ]);
    expect(actionArgv({ kind: 'proxmox', type: 'lxc', vmid: 201, action: 'shutdown' })).toEqual(['pct', 'shutdown', '201']);
    expect(actionArgv({ kind: 'libvirt', domain: 'runner', action: 'destroy' })).toEqual(['virsh', 'destroy', 'runner']);
    expect(() => actionArgv({ kind: 'compose', runtime: 'docker', project: '-p', action: 'stop' })).toThrow();
  });
});

describe('environment sessions over SSH', () => {
  it('runs the target instead of the login shell, always with a terminal', () => {
    const profile: SshProfile = {
      kind: 'ssh',
      target: 'build-01',
      environment: { kind: 'container', runtime: 'docker', container: 'web', shell: 'sh' },
    };
    expect(environmentSession({ env: { LANG: 'C' }, remoteCommand: 'tmux', requestTty: 'auto' }, profile)).toEqual({
      env: { LANG: 'C' },
      remoteCommand: 'docker exec -it -e TERM=xterm-256color web sh',
      requestTty: 'force',
    });
    const plain = { remoteCommand: 'tmux' };
    expect(environmentSession(plain, { kind: 'ssh', target: 'build-01' })).toBe(plain);
  });
});

describe('environment routes', () => {
  const TOKEN = 'environment-route-test-token';
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];

  beforeEach(async () => {
    ({ app, ctx } = await buildApp(
      resolveConfig({
        token: TOKEN,
        databasePath: ':memory:',
        openBrowser: false,
        prettyLogs: false,
        staticRoot: '/path/that/does/not/exist',
      }),
    ));
  });

  afterEach(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TOKEN}` };

  it('needs a live connection', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/environments/ssh/nope', headers });
    expect(response.statusCode).toBe(404);
  });

  it('validates names before running anything', async () => {
    const pods = await app.inject({
      method: 'GET',
      url: '/api/environments/local/kubernetes/pods?namespace=Not_Valid',
      headers,
    });
    expect(pods.statusCode).toBe(400);
    const action = await app.inject({
      method: 'POST',
      url: '/api/environments/local/actions',
      headers,
      payload: { kind: 'container', runtime: 'docker', container: '--rm', action: 'stop' },
    });
    expect(action.statusCode).toBe(400);
  });

  it('takes connection settings from the saved host and the environment from the session', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers,
      payload: {
        id: 'muxus-ssh-pve',
        name: 'PVE',
        profile: { kind: 'ssh', target: 'pve.example.test', useConfig: false, user: 'root' },
      },
    });
    expect(saved.statusCode).toBe(200);
    const resolved = ctx.connections.resolveProfile({
      kind: 'ssh',
      target: 'stale-target',
      profileId: 'muxus-ssh-pve',
      environment: { kind: 'proxmox-lxc', vmid: 200 },
    });
    expect(resolved).toMatchObject({
      target: 'pve.example.test',
      user: 'root',
      environment: { kind: 'proxmox-lxc', vmid: 200 },
    });
  });
});
