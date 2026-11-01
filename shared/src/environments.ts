/**
 * Host environments: the containers, clusters, labs and virtual machines a
 * host runs, found and entered through the host's own command-line tools
 * (docker, podman, kubectl, pvesh, virsh). Nothing is installed on the host.
 *
 * A session into one of them is an ordinary local or SSH session whose
 * profile carries an {@link EnvironmentTarget}. The server, never the client,
 * turns the target into a command, from the fields validated here.
 */

export const CONTAINER_RUNTIMES = ['docker', 'podman'] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

/** Which shell a container session starts; `auto` prefers bash, then ash, then sh. */
export const CONTAINER_SHELLS = ['auto', 'bash', 'sh'] as const;
export type ContainerShell = (typeof CONTAINER_SHELLS)[number];

/** The libvirt connections Muxus looks at: the system daemon and the user's own. */
export const LIBVIRT_URIS = ['qemu:///system', 'qemu:///session'] as const;
export type LibvirtUri = (typeof LIBVIRT_URIS)[number];

/** Docker and Podman container names and IDs. */
export const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
/** Kubernetes object names (DNS-1123 subdomain): pods and namespaces. */
export const KUBE_NAME_PATTERN = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
/** Kubernetes container names (DNS-1123 label). */
export const KUBE_CONTAINER_PATTERN = /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/**
 * kubeconfig context names are free-form ("arn:aws:eks:…/prod", "admin@kind").
 * They travel quoted as `--context=<name>`; only control characters and a
 * leading dash are refused.
 */
// oxlint-disable-next-line no-control-regex
export const KUBE_CONTEXT_PATTERN = /^(?!-)[^\u0000-\u001f\u007f]{1,253}$/;
/** libvirt domain names: anything printable that cannot read as an option. */
// oxlint-disable-next-line no-control-regex
export const LIBVIRT_DOMAIN_PATTERN = /^(?![-\s])[^\u0000-\u001f\u007f]{1,200}$/;
/** Proxmox guest IDs. */
export const PROXMOX_MIN_VMID = 100;
export const PROXMOX_MAX_VMID = 999_999_999;

/** Something inside a host that a terminal session can enter or watch. */
export type EnvironmentTarget =
  | { kind: 'container'; runtime: ContainerRuntime; container: string; shell?: ContainerShell }
  | { kind: 'container-logs'; runtime: ContainerRuntime; container: string }
  | { kind: 'pod'; context?: string; namespace: string; pod: string; container?: string }
  | {
      kind: 'pod-logs';
      context?: string;
      namespace: string;
      pod: string;
      container?: string;
      /** The log of the container's previous run, after a crash. */
      previous?: boolean;
    }
  | { kind: 'proxmox-lxc'; vmid: number }
  | { kind: 'proxmox-serial'; vmid: number }
  | { kind: 'libvirt-console'; domain: string; uri?: LibvirtUri };

/** How many log lines a log session starts with before following. */
export const LOG_TAIL_LINES = 1000;

/** Prefer bash, then ash (Alpine, BusyBox), then plain sh — whatever the image has. */
const AUTO_SHELL =
  'if command -v bash >/dev/null 2>&1; then exec bash; elif command -v ash >/dev/null 2>&1; then exec ash; else exec sh; fi';

function shellArgv(shell: ContainerShell | undefined): string[] {
  if (shell === 'bash') return ['bash'];
  if (shell === 'sh') return ['sh'];
  return ['sh', '-c', AUTO_SHELL];
}

function kubeContextArgs(context: string | undefined): string[] {
  return context ? [`--context=${context}`] : [];
}

/** Whether a target's names and IDs are all ones the commands below accept. */
export function isValidEnvironmentTarget(target: EnvironmentTarget): boolean {
  switch (target.kind) {
    case 'container':
    case 'container-logs':
      return CONTAINER_NAME_PATTERN.test(target.container);
    case 'pod':
    case 'pod-logs':
      return (
        KUBE_NAME_PATTERN.test(target.namespace) &&
        KUBE_NAME_PATTERN.test(target.pod) &&
        (target.container === undefined || KUBE_CONTAINER_PATTERN.test(target.container)) &&
        (target.context === undefined || KUBE_CONTEXT_PATTERN.test(target.context))
      );
    case 'proxmox-lxc':
    case 'proxmox-serial':
      return (
        Number.isInteger(target.vmid) &&
        target.vmid >= PROXMOX_MIN_VMID &&
        target.vmid <= PROXMOX_MAX_VMID
      );
    case 'libvirt-console':
      return (
        LIBVIRT_DOMAIN_PATTERN.test(target.domain) &&
        (target.uri === undefined || (LIBVIRT_URIS as readonly string[]).includes(target.uri))
      );
  }
}

/**
 * The program and arguments that enter a target, run on the host that owns
 * it. Local sessions spawn this argv directly; SSH sessions send it as the
 * channel's command, each argument quoted by {@link environmentCommandLine}.
 */
export function environmentArgv(target: EnvironmentTarget): string[] {
  if (!isValidEnvironmentTarget(target)) throw new Error('invalid environment target');
  switch (target.kind) {
    case 'container':
      return [
        target.runtime,
        'exec',
        '-it',
        '-e',
        'TERM=xterm-256color',
        target.container,
        ...shellArgv(target.shell),
      ];
    case 'container-logs':
      return [target.runtime, 'logs', '--follow', '--tail', String(LOG_TAIL_LINES), target.container];
    case 'pod':
      return [
        'kubectl',
        ...kubeContextArgs(target.context),
        `--namespace=${target.namespace}`,
        'exec',
        '-it',
        target.pod,
        ...(target.container ? [`--container=${target.container}`] : []),
        '--',
        ...shellArgv('auto'),
      ];
    case 'pod-logs':
      return [
        'kubectl',
        ...kubeContextArgs(target.context),
        `--namespace=${target.namespace}`,
        'logs',
        target.pod,
        ...(target.container ? [`--container=${target.container}`] : []),
        `--tail=${LOG_TAIL_LINES}`,
        ...(target.previous ? ['--previous'] : ['--follow']),
      ];
    case 'proxmox-lxc':
      return ['pct', 'enter', String(target.vmid)];
    case 'proxmox-serial':
      return ['qm', 'terminal', String(target.vmid)];
    case 'libvirt-console':
      return ['virsh', ...(target.uri ? ['-c', target.uri] : []), 'console', target.domain];
  }
}

/** Quote one argument for a POSIX shell. Plain words stay readable. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** {@link environmentArgv} as one POSIX command line, for SSH and for copying. */
export function environmentCommandLine(target: EnvironmentTarget): string {
  return environmentArgv(target).map(shellQuote).join(' ');
}

/** Read-only targets: what they show is output, not a shell to type into. */
export function isLogEnvironment(target: EnvironmentTarget): boolean {
  return target.kind === 'container-logs' || target.kind === 'pod-logs';
}

/** Tab title for a session into a target. */
export function environmentTitle(target: EnvironmentTarget): string {
  switch (target.kind) {
    case 'container':
      return target.container;
    case 'container-logs':
      return `logs · ${target.container}`;
    case 'pod':
      return target.container ? `${target.pod}/${target.container}` : target.pod;
    case 'pod-logs':
      return `logs · ${target.pod}`;
    case 'proxmox-lxc':
      return `CT ${target.vmid}`;
    case 'proxmox-serial':
      return `VM ${target.vmid} · serial`;
    case 'libvirt-console':
      return `${target.domain} · console`;
  }
}

// ---------------------------------------------------------------------------
// Discovery results
// ---------------------------------------------------------------------------

export interface ContainerPort {
  /** Address the port is published on; absent for an unpublished container port. */
  hostIp?: string;
  hostPort?: number;
  containerPort: number;
  protocol: string;
}

/** Containerlab's labels on one lab node's container. */
export interface ContainerlabLabels {
  lab: string;
  node: string;
  kind: string;
  topologyFile?: string;
  owner?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  /** running, exited, restarting, paused, created, dead … as the engine says. */
  state: string;
  /** The engine's human status, such as "Up 3 days" or "Exited (0) 2 weeks ago". */
  status: string;
  ports: ContainerPort[];
  composeProject?: string;
  containerlab?: ContainerlabLabels;
}

export interface ContainerRuntimeEnvironment {
  kind: 'containers';
  runtime: ContainerRuntime;
  version?: string;
  containers: ContainerInfo[];
}

export interface ContainerlabNode {
  /** Node name in the topology. */
  name: string;
  /** Container name, `clab-<lab>-<node>` unless the topology changes the prefix. */
  container: string;
  kind: string;
  image: string;
  state: string;
  /** Management addresses without prefix length. */
  ipv4?: string;
  ipv6?: string;
}

export interface ContainerlabLab {
  name: string;
  runtime: ContainerRuntime;
  topologyFile?: string;
  owner?: string;
  nodes: ContainerlabNode[];
}

export interface ContainerlabEnvironment {
  kind: 'containerlab';
  labs: ContainerlabLab[];
}

export interface KubernetesEnvironment {
  kind: 'kubernetes';
  version?: string;
  contexts: string[];
  currentContext?: string;
}

export interface ProxmoxGuest {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  /** running, stopped, paused … */
  status: string;
  node?: string;
  /** CPU use as a fraction of `maxcpu` cores. */
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
  template?: boolean;
}

export interface ProxmoxEnvironment {
  kind: 'proxmox';
  version?: string;
  guests: ProxmoxGuest[];
}

export interface LibvirtDomain {
  name: string;
  /** running, shut off, paused … as virsh says. */
  state: string;
  id?: number;
}

export interface LibvirtEnvironment {
  kind: 'libvirt';
  uri?: LibvirtUri;
  version?: string;
  domains: LibvirtDomain[];
}

export type HostEnvironment =
  | ContainerRuntimeEnvironment
  | ContainerlabEnvironment
  | KubernetesEnvironment
  | ProxmoxEnvironment
  | LibvirtEnvironment;

export type EnvironmentProvider = 'docker' | 'podman' | 'kubernetes' | 'proxmox' | 'libvirt';

/** A tool that is installed but did not answer, such as docker without access to its socket. */
export interface EnvironmentProblem {
  provider: EnvironmentProvider;
  message: string;
}

export type EnvironmentsResponse =
  | {
      status: 'ok';
      sampledAt: number;
      environments: HostEnvironment[];
      problems: EnvironmentProblem[];
    }
  /** The host was not asked, e.g. a router CLI that cannot run commands. */
  | { status: 'unsupported'; message: string };

export interface KubernetesPod {
  name: string;
  namespace: string;
  /** Pending, Running, Succeeded, Failed, Unknown. */
  phase: string;
  /** Ready containers over all containers, such as "1/2". */
  ready: string;
  restarts: number;
  /** Why the pod is not running normally, such as CrashLoopBackOff. */
  reason?: string;
  owner?: { kind: string; name: string };
  containers: string[];
  node?: string;
  createdAt?: string;
}

export interface KubernetesPodsResponse {
  pods: KubernetesPod[];
}

export interface KubernetesNamespacesResponse {
  namespaces: string[];
}

export interface ContainerlabTopologyResponse {
  path: string;
  yaml: string;
  /** Saved positions and annotations beside the topology, when there are any. */
  annotations?: string;
}

export interface EnvironmentAddressesResponse {
  /** Reachable addresses from the host, IPv4 first. */
  addresses: string[];
}

export interface LibvirtDisplayResponse {
  /** VNC endpoint as seen from the hypervisor; absent when the domain has none. */
  vnc?: { host: string; port: number };
}

/** Power and lifecycle actions offered on discovered things. */
export type EnvironmentAction =
  | {
      kind: 'container';
      runtime: ContainerRuntime;
      container: string;
      action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause';
    }
  | {
      kind: 'compose';
      runtime: ContainerRuntime;
      project: string;
      action: 'start' | 'stop' | 'restart';
    }
  | {
      kind: 'proxmox';
      type: 'qemu' | 'lxc';
      vmid: number;
      action: 'start' | 'shutdown' | 'reboot' | 'stop';
    }
  | {
      kind: 'libvirt';
      uri?: LibvirtUri;
      domain: string;
      action: 'start' | 'shutdown' | 'reboot' | 'destroy';
    };

export interface EnvironmentActionResponse {
  ok: boolean;
  /** What the tool printed, trimmed; shown when it failed. */
  output: string;
}

/** A port on the far side of an SSH host, opened as a local listener. */
export interface EnvironmentPortResponse {
  forwardId: string;
  localPort: number;
}
