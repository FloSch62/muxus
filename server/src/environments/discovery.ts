import {
  CONTAINER_NAME_PATTERN,
  type ContainerInfo,
  type ContainerlabTopologyResponse,
  type ContainerRuntime,
  type EnvironmentAction,
  type EnvironmentActionResponse,
  type EnvironmentProblem,
  type HostEnvironment,
  type KubernetesPod,
  type LibvirtDomain,
  type LibvirtEnvironment,
  type LibvirtUri,
} from '@muxus/shared';
import {
  DOCKER_PS_FORMAT,
  INSPECT_NETWORKS_FORMAT,
  containerlabLabs,
  parseCliVersion,
  parseDockerPs,
  parseInspectAddresses,
  parseKubeNamespaces,
  parseKubePods,
  parseKubectlVersion,
  parseLines,
  parseLxcAddresses,
  parsePodmanPs,
  parsePveResources,
  parsePveVersion,
  parseQemuAgentAddresses,
  parseVirshAddresses,
  parseVirshDisplay,
  parseVirshList,
} from './parse.js';
import {
  probeFailure,
  probeOutput,
  type Probe,
  type ProbeResult,
  type ProbeRunner,
} from './probe-runner.js';
import { HttpProblem } from '../util/errors.js';

/** How many lab containers one inspect call asks about. */
const MAX_INSPECTED = 256;

export interface DiscoveryResult {
  environments: HostEnvironment[];
  problems: EnvironmentProblem[];
}

const DISCOVERY_PROBES: Probe[] = [
  { id: 'docker-cli', argv: ['docker', '--version'] },
  { id: 'docker-ps', argv: ['docker', 'ps', '--all', '--no-trunc', '--format', DOCKER_PS_FORMAT] },
  { id: 'podman-cli', argv: ['podman', '--version'] },
  { id: 'podman-ps', argv: ['podman', 'ps', '--all', '--format', 'json'] },
  { id: 'kubectl-version', argv: ['kubectl', 'version', '--client', '-o', 'json'] },
  { id: 'kubectl-contexts', argv: ['kubectl', 'config', 'get-contexts', '-o', 'name'] },
  { id: 'kubectl-current', argv: ['kubectl', 'config', 'current-context'] },
  { id: 'pve-version', argv: ['pveversion'] },
  {
    id: 'pve-resources',
    argv: ['pvesh', 'get', '/cluster/resources', '--type', 'vm', '--output-format', 'json'],
  },
  { id: 'virsh-version', argv: ['virsh', '--version'] },
  { id: 'virsh-system', argv: ['virsh', '-c', 'qemu:///system', 'list', '--all'] },
  { id: 'virsh-session', argv: ['virsh', '-c', 'qemu:///session', 'list', '--all'] },
];

/**
 * podman-docker installs a `docker` that is podman underneath; its containers
 * are podman's, listed once under Podman.
 */
function dockerIsPodman(cli: ProbeResult | undefined): boolean {
  return cli?.status === 'ran' && /podman/i.test(`${cli.stdout}\n${cli.stderr}`);
}

/** Problems worth a line in the panel: the tool exists but would not answer. */
function problem(
  provider: EnvironmentProblem['provider'],
  result: ProbeResult | undefined,
): EnvironmentProblem | undefined {
  const message = probeFailure(result);
  return message ? { provider, message } : undefined;
}

/** Everything a host runs that Muxus can enter: one batch, plus one for lab addresses. */
export async function discoverEnvironments(run: ProbeRunner): Promise<DiscoveryResult> {
  const results = await run(DISCOVERY_PROBES);
  const environments: HostEnvironment[] = [];
  const problems: EnvironmentProblem[] = [];
  const add = (entry: EnvironmentProblem | undefined) => {
    if (entry) problems.push(entry);
  };

  const runtimes: Array<{ runtime: ContainerRuntime; containers: ContainerInfo[] }> = [];
  if (!dockerIsPodman(results.get('docker-cli'))) {
    const ps = probeOutput(results.get('docker-ps'));
    if (ps !== undefined) {
      const containers = parseDockerPs(ps);
      runtimes.push({ runtime: 'docker', containers });
      environments.push({
        kind: 'containers',
        runtime: 'docker',
        version: parseCliVersion(probeOutput(results.get('docker-cli')) ?? ''),
        containers,
      });
    } else add(problem('docker', results.get('docker-ps')));
  }
  const podmanPs = probeOutput(results.get('podman-ps'));
  if (podmanPs !== undefined) {
    const containers = parsePodmanPs(podmanPs);
    runtimes.push({ runtime: 'podman', containers });
    environments.push({
      kind: 'containers',
      runtime: 'podman',
      version: parseCliVersion(probeOutput(results.get('podman-cli')) ?? ''),
      containers,
    });
  } else add(problem('podman', results.get('podman-ps')));

  // Containerlab labels its nodes; their management addresses need one inspect.
  const labRuntimes = runtimes.filter(({ containers }) => containers.some((c) => c.containerlab));
  if (labRuntimes.length > 0) {
    const inspected = await run(
      labRuntimes.map(({ runtime, containers }) => ({
        id: `${runtime}-inspect`,
        argv: [
          runtime,
          'inspect',
          '--format',
          INSPECT_NETWORKS_FORMAT,
          ...containers
            .filter((c) => c.containerlab)
            .slice(0, MAX_INSPECTED)
            .map((c) => c.name),
        ],
      })),
    );
    const labs = labRuntimes.flatMap(({ runtime, containers }) =>
      containerlabLabs(
        runtime,
        containers,
        parseInspectAddresses(
          // inspect fails as a whole when one container vanished meanwhile;
          // whatever it printed for the rest still counts.
          (() => {
            const result = inspected.get(`${runtime}-inspect`);
            return result?.status === 'ran' ? result.stdout : '';
          })(),
        ),
      ),
    );
    if (labs.length > 0) environments.push({ kind: 'containerlab', labs });
  }

  const contexts = probeOutput(results.get('kubectl-contexts'));
  if (contexts !== undefined) {
    const names = parseLines(contexts);
    if (names.length > 0) {
      const current = parseLines(probeOutput(results.get('kubectl-current')) ?? '')[0];
      environments.push({
        kind: 'kubernetes',
        version: parseKubectlVersion(probeOutput(results.get('kubectl-version')) ?? ''),
        contexts: names,
        ...(current && names.includes(current) ? { currentContext: current } : {}),
      });
    }
  }

  const resources = probeOutput(results.get('pve-resources'));
  if (resources !== undefined) {
    environments.push({
      kind: 'proxmox',
      version: parsePveVersion(probeOutput(results.get('pve-version')) ?? ''),
      guests: parsePveResources(resources),
    });
  } else add(problem('proxmox', results.get('pve-resources')));

  environments.push(...libvirtEnvironments(results, add));
  return { environments, problems };
}

/**
 * The system daemon is where most hypervisor hosts keep their VMs; a user's
 * own session daemon adds its VMs to the same list. A virsh that reaches
 * neither is a client without a daemon, not a problem worth reporting,
 * unless it was refused.
 */
function libvirtEnvironments(
  results: Map<string, ProbeResult>,
  add: (entry: EnvironmentProblem | undefined) => void,
): LibvirtEnvironment[] {
  const version = parseCliVersion(`version ${probeOutput(results.get('virsh-version')) ?? ''}`);
  const system = probeOutput(results.get('virsh-system'));
  if (system === undefined) {
    const failure = probeFailure(results.get('virsh-system'));
    if (failure && /denied|authenticat|polkit|authoriz/i.test(failure)) {
      add({ provider: 'libvirt', message: failure });
    }
  }
  const systemDomains = system === undefined ? [] : parseVirshList(system);
  const sessionOutput = probeOutput(results.get('virsh-session'));
  const sessionDomains = sessionOutput === undefined ? [] : parseVirshList(sessionOutput);
  // Some setups answer the session URI with the system daemon: the same VMs twice.
  const systemNames = new Set(systemDomains.map((domain) => domain.name));
  const duplicate =
    sessionDomains.length === systemDomains.length && sessionDomains.every((domain) => systemNames.has(domain.name));
  const domains: LibvirtDomain[] = [
    ...systemDomains.map((domain) => ({ ...domain, uri: 'qemu:///system' as const })),
    ...(duplicate ? [] : sessionDomains.map((domain) => ({ ...domain, uri: 'qemu:///session' as const }))),
  ];
  if (system === undefined && domains.length === 0) return [];
  return [{ kind: 'libvirt', version, domains }];
}

function contextArgs(context: string | undefined): string[] {
  return context ? [`--context=${context}`] : [];
}

async function runOne(run: ProbeRunner, probe: Probe): Promise<ProbeResult | undefined> {
  return (await run([probe])).get(probe.id);
}

/** stdout of a probe that must succeed; a tool that fails is the host's answer, not a Muxus fault. */
function required(result: ProbeResult | undefined, tool: string): string {
  if (!result || result.status === 'missing') throw new HttpProblem(502, `${tool} is not installed on this host`);
  const output = probeOutput(result);
  if (output === undefined) throw new HttpProblem(502, probeFailure(result) ?? `${tool} failed`);
  return output;
}

export async function kubernetesNamespaces(run: ProbeRunner, context?: string): Promise<string[]> {
  const result = await runOne(run, {
    id: 'namespaces',
    argv: ['kubectl', ...contextArgs(context), 'get', 'namespaces', '-o', 'name', '--request-timeout=10s'],
  });
  return parseKubeNamespaces(required(result, 'kubectl'));
}

/** Pods of one namespace, or of all of them when `namespace` is undefined. */
export async function kubernetesPods(
  run: ProbeRunner,
  context: string | undefined,
  namespace: string | undefined,
): Promise<KubernetesPod[]> {
  const result = await runOne(run, {
    id: 'pods',
    argv: [
      'kubectl',
      ...contextArgs(context),
      'get',
      'pods',
      ...(namespace ? [`--namespace=${namespace}`] : ['--all-namespaces']),
      '-o',
      'json',
      '--request-timeout=10s',
    ],
  });
  return parseKubePods(required(result, 'kubectl'));
}

const LAB_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** An absolute topology file path, as containerlab records it. */
// oxlint-disable-next-line no-control-regex
const TOPOLOGY_PATH = /^\/[^\u0000-\u001f\u007f]*\.ya?ml$/;
const MAX_TOPOLOGY_BYTES = 4 * 1024 * 1024;

/**
 * A running lab's topology file and saved annotations. The path is the one
 * the lab's own containers carry, never one the caller names.
 */
export async function containerlabTopology(
  run: ProbeRunner,
  runtime: ContainerRuntime,
  lab: string,
): Promise<ContainerlabTopologyResponse> {
  if (!LAB_NAME.test(lab)) throw new HttpProblem(400, 'invalid lab name');
  const located = await runOne(run, {
    id: 'locate',
    argv: [
      runtime,
      'ps',
      '--all',
      '--filter',
      `label=containerlab=${lab}`,
      '--format',
      '{{.Label "clab-topo-file"}}',
    ],
  });
  const topologyFile = parseLines(required(located, runtime)).find((line) => TOPOLOGY_PATH.test(line));
  if (!topologyFile) throw new HttpProblem(404, `lab "${lab}" does not say where its topology file is`);
  const files = await run([
    { id: 'yaml', argv: ['head', '-c', String(MAX_TOPOLOGY_BYTES), topologyFile] },
    { id: 'annotations', argv: ['head', '-c', String(MAX_TOPOLOGY_BYTES), `${topologyFile}.annotations.json`] },
  ]);
  const yaml = probeOutput(files.get('yaml'));
  if (yaml === undefined) {
    throw new HttpProblem(502, `could not read ${topologyFile}: ${probeFailure(files.get('yaml')) ?? 'unknown error'}`);
  }
  const annotations = probeOutput(files.get('annotations'))?.trim();
  return { path: topologyFile, yaml, ...(annotations ? { annotations } : {}) };
}

function virshArgs(uri: LibvirtUri | undefined): string[] {
  return ['virsh', ...(uri ? ['-c', uri] : [])];
}

/** A domain's addresses: from the guest's DHCP lease, else the ARP table. */
export async function libvirtAddresses(
  run: ProbeRunner,
  uri: LibvirtUri | undefined,
  domain: string,
): Promise<string[]> {
  const results = await run([
    { id: 'lease', argv: [...virshArgs(uri), 'domifaddr', domain] },
    { id: 'agent', argv: [...virshArgs(uri), 'domifaddr', domain, '--source', 'agent'] },
    { id: 'arp', argv: [...virshArgs(uri), 'domifaddr', domain, '--source', 'arp'] },
  ]);
  for (const id of ['lease', 'agent', 'arp']) {
    const addresses = parseVirshAddresses(probeOutput(results.get(id)) ?? '');
    if (addresses.length > 0) return addresses;
  }
  const first = results.get('lease');
  if (!first || first.status === 'missing') throw new HttpProblem(502, 'virsh is not installed on this host');
  return [];
}

export async function libvirtDisplay(
  run: ProbeRunner,
  uri: LibvirtUri | undefined,
  domain: string,
): Promise<{ host: string; port: number } | undefined> {
  const result = await runOne(run, { id: 'display', argv: [...virshArgs(uri), 'domdisplay', domain] });
  return parseVirshDisplay(required(result, 'virsh'));
}

export async function proxmoxAddresses(
  run: ProbeRunner,
  type: 'qemu' | 'lxc',
  vmid: number,
): Promise<string[]> {
  if (type === 'lxc') {
    const result = await runOne(run, { id: 'lxc', argv: ['lxc-info', '-n', String(vmid), '-iH'] });
    return parseLxcAddresses(required(result, 'lxc-info'));
  }
  const result = await runOne(run, {
    id: 'agent',
    argv: ['qm', 'guest', 'cmd', String(vmid), 'network-get-interfaces'],
  });
  const output = probeOutput(result);
  if (output === undefined) {
    throw new HttpProblem(
      502,
      result?.status === 'missing'
        ? 'qm is not installed on this host'
        : `the QEMU guest agent did not answer (${probeFailure(result) ?? 'no reply'})`,
    );
  }
  return parseQemuAgentAddresses(output);
}

const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** The command behind one power or lifecycle action. */
export function actionArgv(action: EnvironmentAction): string[] {
  switch (action.kind) {
    case 'container':
      if (!CONTAINER_NAME_PATTERN.test(action.container)) throw new HttpProblem(400, 'invalid container name');
      // A running container is stopped first; volumes it named are kept.
      if (action.action === 'remove') return [action.runtime, 'rm', '--force', action.container];
      return [action.runtime, action.action, action.container];
    case 'compose':
      if (!COMPOSE_PROJECT.test(action.project)) throw new HttpProblem(400, 'invalid compose project');
      return [action.runtime, 'compose', '--project-name', action.project, action.action];
    case 'proxmox':
      return [action.type === 'qemu' ? 'qm' : 'pct', action.action, String(action.vmid)];
    case 'libvirt':
      return [...virshArgs(action.uri), action.action, action.domain];
  }
}

export async function runEnvironmentAction(
  run: ProbeRunner,
  action: EnvironmentAction,
): Promise<EnvironmentActionResponse> {
  const argv = actionArgv(action);
  const result = await runOne(run, { id: 'action', argv });
  if (!result || result.status === 'missing') {
    return { ok: false, output: `${argv[0]} is not installed on this host` };
  }
  const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 2000);
  return { ok: result.exitCode === 0, output };
}
