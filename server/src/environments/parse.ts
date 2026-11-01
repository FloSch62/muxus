import type {
  ContainerInfo,
  ContainerlabLab,
  ContainerlabLabels,
  ContainerPort,
  ContainerRuntime,
  KubernetesPod,
  LibvirtDomain,
  ProxmoxGuest,
} from '@muxus/shared';

/**
 * Parsers for what docker, podman, kubectl, pvesh and virsh print. Each takes
 * the tool's raw stdout and returns only well-formed entries: a host is free
 * to print anything, and a line that does not parse is skipped, not fatal.
 */

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function jsonLines(output: string): unknown[] {
  const values: unknown[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // A warning or a truncated line.
    }
  }
  return values;
}

function jsonValue(output: string): unknown {
  const start = output.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return undefined;
  }
}

/** The `docker ps --format` template whose lines {@link parseDockerPs} reads. */
export const DOCKER_PS_FORMAT =
  '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},' +
  '"status":{{json .Status}},"ports":{{json .Ports}},' +
  '"project":{{json (.Label "com.docker.compose.project")}},' +
  '"clab":{{json (.Label "containerlab")}},"clabNode":{{json (.Label "clab-node-name")}},' +
  '"clabKind":{{json (.Label "clab-node-kind")}},"clabTopo":{{json (.Label "clab-topo-file")}},' +
  '"clabOwner":{{json (.Label "clab-owner")}},"clabInternal":{{json (.Label "clab-internal-node")}}}';

/**
 * Docker's port column: "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp".
 * The IPv4 and IPv6 bindings of one port become one entry.
 */
export function parseDockerPorts(column: string): ContainerPort[] {
  const ports: ContainerPort[] = [];
  const seen = new Set<string>();
  for (const raw of column.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = /^(?:(.*):(\d+)(?:-(\d+))?->)?(\d+)(?:-(\d+))?\/(\w+)$/.exec(entry);
    if (!match) continue;
    const [, hostIp, hostStart, hostEnd, containerStart, containerEnd, protocol] = match;
    const first = Number(containerStart);
    const last = containerEnd ? Number(containerEnd) : first;
    // A published range lists each port; keep a sane bound on what it expands to.
    for (let offset = 0; offset <= Math.min(last - first, 63); offset++) {
      const port: ContainerPort = { containerPort: first + offset, protocol: protocol! };
      if (hostStart) {
        port.hostPort = Number(hostStart) + (hostEnd ? offset : 0);
        const ip = hostIp!.replace(/^\[|\]$/g, '');
        port.hostIp = ip || '0.0.0.0';
      }
      const key = `${port.hostPort ?? ''}:${port.containerPort}/${port.protocol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push(port);
    }
  }
  return ports;
}

function clabLabels(fields: {
  lab?: string;
  node?: string;
  kind?: string;
  topo?: string;
  owner?: string;
  internal?: string;
}): ContainerlabLabels | undefined {
  // Containerlab's own helpers (sshx, gotty …) are not nodes of the topology.
  if (!fields.lab || !fields.node || fields.internal === 'true') return undefined;
  return {
    lab: fields.lab,
    node: fields.node,
    kind: fields.kind ?? '',
    ...(fields.topo ? { topologyFile: fields.topo } : {}),
    ...(fields.owner ? { owner: fields.owner } : {}),
  };
}

/** `docker ps -a --format` lines in the {@link DOCKER_PS_FORMAT} shape. */
export function parseDockerPs(output: string): ContainerInfo[] {
  const containers: ContainerInfo[] = [];
  for (const value of jsonLines(output)) {
    const row = record(value);
    if (!row) continue;
    const name = text(row.name)?.split(',')[0];
    const id = text(row.id);
    if (!name || !id) continue;
    const containerlab = clabLabels({
      lab: text(row.clab),
      node: text(row.clabNode),
      kind: text(row.clabKind),
      topo: text(row.clabTopo),
      owner: text(row.clabOwner),
      internal: text(row.clabInternal),
    });
    containers.push({
      id: id.slice(0, 12),
      name,
      image: text(row.image) ?? '',
      state: text(row.state)?.toLowerCase() ?? 'unknown',
      status: text(row.status) ?? '',
      ports: parseDockerPorts(text(row.ports) ?? ''),
      ...(text(row.project) ? { composeProject: text(row.project) } : {}),
      ...(containerlab ? { containerlab } : {}),
    });
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

/** `podman ps -a --format json`: one JSON array. */
export function parsePodmanPs(output: string): ContainerInfo[] {
  const value = jsonValue(output);
  if (!Array.isArray(value)) return [];
  const containers: ContainerInfo[] = [];
  for (const item of value) {
    const row = record(item);
    if (!row) continue;
    const names = Array.isArray(row.Names) ? row.Names : [row.Names];
    const name = text(names[0]);
    const id = text(row.Id) ?? text(row.ID);
    if (!name || !id) continue;
    const labels = record(row.Labels) ?? {};
    const ports: ContainerPort[] = [];
    for (const entry of Array.isArray(row.Ports) ? row.Ports : []) {
      const port = record(entry);
      const containerPort = count(port?.container_port);
      if (!port || containerPort === undefined) continue;
      const range = Math.max(1, Math.min(count(port.range) ?? 1, 64));
      const hostPort = count(port.host_port);
      for (let offset = 0; offset < range; offset++) {
        ports.push({
          containerPort: containerPort + offset,
          protocol: text(port.protocol) ?? 'tcp',
          ...(hostPort ? { hostPort: hostPort + offset, hostIp: text(port.host_ip) ?? '0.0.0.0' } : {}),
        });
      }
    }
    const containerlab = clabLabels({
      lab: text(labels.containerlab),
      node: text(labels['clab-node-name']),
      kind: text(labels['clab-node-kind']),
      topo: text(labels['clab-topo-file']),
      owner: text(labels['clab-owner']),
      internal: text(labels['clab-internal-node']),
    });
    const project = text(labels['com.docker.compose.project']) ?? text(labels['io.podman.compose.project']);
    containers.push({
      id: id.slice(0, 12),
      name,
      image: text(row.Image) ?? '',
      state: text(row.State)?.toLowerCase() ?? 'unknown',
      status: text(row.Status) ?? '',
      ports,
      ...(project ? { composeProject: project } : {}),
      ...(containerlab ? { containerlab } : {}),
    });
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

/** The `inspect --format` template whose lines {@link parseInspectAddresses} reads. */
export const INSPECT_NETWORKS_FORMAT =
  '{"name":{{json .Name}},"mode":{{json .HostConfig.NetworkMode}},"nets":{{json .NetworkSettings.Networks}}}';

/** Management addresses by container name, from the container's own network. */
export function parseInspectAddresses(output: string): Map<string, { ipv4?: string; ipv6?: string }> {
  const addresses = new Map<string, { ipv4?: string; ipv6?: string }>();
  for (const value of jsonLines(output)) {
    const row = record(value);
    const name = text(row?.name)?.replace(/^\//, '');
    const networks = record(row?.nets);
    if (!name || !networks) continue;
    const mode = text(row?.mode);
    const network = record((mode && networks[mode]) ?? Object.values(networks)[0]);
    if (!network) continue;
    const ipv4 = text(network.IPAddress);
    const ipv6 = text(network.GlobalIPv6Address);
    addresses.set(name, { ...(ipv4 ? { ipv4 } : {}), ...(ipv6 ? { ipv6 } : {}) });
  }
  return addresses;
}

/** Labs from the containerlab labels of a runtime's containers. */
export function containerlabLabs(
  runtime: ContainerRuntime,
  containers: readonly ContainerInfo[],
  addresses: ReadonlyMap<string, { ipv4?: string; ipv6?: string }> = new Map(),
): ContainerlabLab[] {
  const labs = new Map<string, ContainerlabLab>();
  for (const container of containers) {
    const labels = container.containerlab;
    if (!labels) continue;
    let lab = labs.get(labels.lab);
    if (!lab) {
      lab = {
        name: labels.lab,
        runtime,
        nodes: [],
        ...(labels.topologyFile ? { topologyFile: labels.topologyFile } : {}),
        ...(labels.owner ? { owner: labels.owner } : {}),
      };
      labs.set(labels.lab, lab);
    }
    const address = addresses.get(container.name);
    lab.nodes.push({
      name: labels.node,
      container: container.name,
      kind: labels.kind,
      image: container.image,
      state: container.state,
      ...(address?.ipv4 ? { ipv4: address.ipv4 } : {}),
      ...(address?.ipv6 ? { ipv6: address.ipv6 } : {}),
    });
  }
  for (const lab of labs.values()) lab.nodes.sort((a, b) => a.name.localeCompare(b.name));
  return [...labs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "Docker version 28.0.1, build …" / "podman version 5.2.0" → the version. */
export function parseCliVersion(output: string): string | undefined {
  return /\bversion\s+v?([0-9][\w.+-]*)/i.exec(output)?.[1]?.replace(/,$/, '');
}

/** Non-empty lines, such as `kubectl config get-contexts -o name`. */
export function parseLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** `kubectl version --client -o json`. */
export function parseKubectlVersion(output: string): string | undefined {
  const version = record(record(jsonValue(output))?.clientVersion);
  return text(version?.gitVersion);
}

/** `kubectl get namespaces -o name`: "namespace/default" per line. */
export function parseKubeNamespaces(output: string): string[] {
  return parseLines(output)
    .map((line) => line.replace(/^namespace\//, ''))
    .filter((name) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

/** `kubectl get pods -o json`, reduced to what a pod row shows. */
export function parseKubePods(output: string): KubernetesPod[] {
  const items = record(jsonValue(output))?.items;
  if (!Array.isArray(items)) return [];
  const pods: KubernetesPod[] = [];
  for (const item of items) {
    const pod = record(item);
    const metadata = record(pod?.metadata);
    const spec = record(pod?.spec);
    const status = record(pod?.status);
    const name = text(metadata?.name);
    const namespace = text(metadata?.namespace);
    if (!name || !namespace) continue;
    const statuses = (Array.isArray(status?.containerStatuses) ? status.containerStatuses : [])
      .map(record)
      .filter((entry): entry is Record<string, unknown> => !!entry);
    const containers = (Array.isArray(spec?.containers) ? spec.containers : [])
      .map((entry) => text(record(entry)?.name))
      .filter((entry): entry is string => !!entry);
    const ready = statuses.filter((entry) => entry.ready === true).length;
    const restarts = statuses.reduce((sum, entry) => sum + (count(entry.restartCount) ?? 0), 0);
    let reason: string | undefined;
    if (metadata?.deletionTimestamp) reason = 'Terminating';
    for (const entry of statuses) {
      if (reason) break;
      const state = record(entry.state);
      reason = text(record(state?.waiting)?.reason) ?? text(record(state?.terminated)?.reason);
      if (reason === 'Completed' && text(status?.phase) === 'Succeeded') reason = undefined;
    }
    reason ??= text(status?.reason);
    const owner = record(Array.isArray(metadata?.ownerReferences) ? metadata.ownerReferences[0] : undefined);
    const ownerKind = text(owner?.kind);
    const ownerName = text(owner?.name);
    pods.push({
      name,
      namespace,
      phase: text(status?.phase) ?? 'Unknown',
      ready: `${ready}/${containers.length || statuses.length}`,
      restarts,
      containers,
      ...(reason ? { reason } : {}),
      ...(ownerKind && ownerName ? { owner: { kind: ownerKind, name: ownerName } } : {}),
      ...(text(spec?.nodeName) ? { node: text(spec?.nodeName) } : {}),
      ...(text(metadata?.creationTimestamp) ? { createdAt: text(metadata?.creationTimestamp) } : {}),
    });
  }
  return pods.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

/** `pveversion`: "pve-manager/8.3.0/c1689ccb1065a83b (running kernel: …)". */
export function parsePveVersion(output: string): string | undefined {
  return /pve-manager\/([\w.-]+)/.exec(output)?.[1];
}

/** `pvesh get /cluster/resources --type vm --output-format json`. */
export function parsePveResources(output: string): ProxmoxGuest[] {
  const value = jsonValue(output);
  if (!Array.isArray(value)) return [];
  const guests: ProxmoxGuest[] = [];
  for (const item of value) {
    const row = record(item);
    const vmid = count(row?.vmid);
    const type = row?.type;
    if (!row || vmid === undefined || (type !== 'qemu' && type !== 'lxc')) continue;
    guests.push({
      vmid,
      type,
      name: text(row.name) ?? `${type === 'qemu' ? 'VM' : 'CT'} ${vmid}`,
      status: text(row.status) ?? 'unknown',
      ...(text(row.node) ? { node: text(row.node) } : {}),
      ...(count(row.cpu) !== undefined ? { cpu: count(row.cpu) } : {}),
      ...(count(row.maxcpu) !== undefined ? { maxcpu: count(row.maxcpu) } : {}),
      ...(count(row.mem) !== undefined ? { mem: count(row.mem) } : {}),
      ...(count(row.maxmem) !== undefined ? { maxmem: count(row.maxmem) } : {}),
      ...(count(row.uptime) !== undefined ? { uptime: count(row.uptime) } : {}),
      ...(row.template === 1 || row.template === true ? { template: true } : {}),
    });
  }
  return guests.sort((a, b) => a.vmid - b.vmid);
}

/**
 * `virsh list --all`:
 *
 *      Id   Name        State
 *     ----------------------------
 *      1    runner      running
 *      -    win11       shut off
 */
export function parseVirshList(output: string): LibvirtDomain[] {
  const domains: LibvirtDomain[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+|-)\s+(\S(?:.*?\S)?)\s{2,}(\S.*?)\s*$/.exec(line);
    if (!match || match[2] === 'Name') continue;
    const [, id, name, state] = match;
    domains.push({ name: name!, state: state!, ...(id !== '-' ? { id: Number(id) } : {}) });
  }
  return domains.sort((a, b) => a.name.localeCompare(b.name));
}

function usableAddress(address: string): boolean {
  return (
    !!address &&
    !address.startsWith('127.') &&
    address !== '::1' &&
    !address.toLowerCase().startsWith('fe80:') &&
    !address.startsWith('169.254.')
  );
}

function ipv4First(addresses: Iterable<string>): string[] {
  const unique = [...new Set(addresses)].filter(usableAddress);
  return [...unique.filter((a) => !a.includes(':')), ...unique.filter((a) => a.includes(':'))];
}

/** `virsh domifaddr`: " vnet0  52:54:00:…  ipv4  192.168.122.10/24". */
export function parseVirshAddresses(output: string): string[] {
  const addresses: string[] = [];
  for (const line of output.split('\n')) {
    const match = /\s(ipv4|ipv6)\s+([0-9a-fA-F:.]+)(?:\/\d+)?\s*$/.exec(line);
    if (match) addresses.push(match[2]!);
  }
  return ipv4First(addresses);
}

/** `virsh domdisplay`: "vnc://127.0.0.1:0" names display 0, port 5900. */
export function parseVirshDisplay(output: string): { host: string; port: number } | undefined {
  const match = /^vnc:\/\/(\[[^\]]*\]|[^:/\s]*)(?::(\d+))?/m.exec(output.trim());
  if (!match) return undefined;
  const display = Number(match[2] ?? 0);
  const rawHost = match[1]!.replace(/^\[|\]$/g, '');
  const host = !rawHost || rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  return { host, port: display >= 5900 ? display : 5900 + display };
}

/** `qm guest cmd <vmid> network-get-interfaces`: the guest agent's view. */
export function parseQemuAgentAddresses(output: string): string[] {
  const value = jsonValue(output);
  if (!Array.isArray(value)) return [];
  const addresses: string[] = [];
  for (const item of value) {
    const iface = record(item);
    if (text(iface?.name) === 'lo') continue;
    for (const entry of Array.isArray(iface?.['ip-addresses']) ? iface['ip-addresses'] : []) {
      const address = text(record(entry)?.['ip-address']);
      if (address) addresses.push(address);
    }
  }
  return ipv4First(addresses);
}

/** `lxc-info -n <vmid> -iH`: one address per line. */
export function parseLxcAddresses(output: string): string[] {
  return ipv4First(parseLines(output).filter((line) => /^[0-9a-fA-F:.]+$/.test(line)));
}
