import {
  isLoopbackOnlyPort,
  listeningPortTarget,
  type ContainerPort,
  type ContainerRuntime,
  type ForwardInfo,
  type HostEnvironment,
  type ListeningPort,
} from '@muxus/shared';

/**
 * The ports list of the containers and VMs panel, kept free of React so it
 * can be tested: how a port's reach is worded, which container publishes it,
 * which running forward already carries it, and what the filter matches.
 */

/** The TCP ports a container publishes on its host, as discovery read them. */
export function publishedContainerPorts(
  environments: readonly HostEnvironment[],
  runtime: ContainerRuntime,
  container: string,
): ContainerPort[] {
  for (const environment of environments) {
    if (environment.kind !== 'containers' || environment.runtime !== runtime) continue;
    const found = environment.containers.find((candidate) => candidate.name === container);
    if (found) return found.ports.filter((port) => port.hostPort && port.protocol === 'tcp');
  }
  return [];
}

/** The container behind a port of its host. */
export interface PortPublisher {
  container: string;
  runtime: ContainerRuntime;
  /** The port inside the container the host's port leads to. */
  containerPort: number;
  /** Address the port is published on. */
  hostIp?: string;
  /** The Containerlab lab the container is a node of. */
  lab?: string;
}

/**
 * Host ports that containers publish, by number. On the host such a port
 * belongs to `docker-proxy`, or to no program at all when the engine forwards
 * it in the kernel, so the container is what tells the user which service it is.
 */
export function portPublishers(environments: readonly HostEnvironment[]): Map<number, PortPublisher> {
  const publishers = new Map<number, PortPublisher>();
  for (const environment of environments) {
    if (environment.kind !== 'containers') continue;
    for (const container of environment.containers) {
      for (const port of container.ports) {
        if (!port.hostPort || port.protocol !== 'tcp' || publishers.has(port.hostPort)) continue;
        publishers.set(port.hostPort, {
          container: container.name,
          runtime: environment.runtime,
          containerPort: port.containerPort,
          ...(port.hostIp ? { hostIp: port.hostIp } : {}),
          ...(container.containerlab ? { lab: container.containerlab.lab } : {}),
        });
      }
    }
  }
  return publishers;
}

/**
 * The host's listening ports plus the published container ports that nothing
 * listens on: an engine without its userland proxy forwards those in the
 * kernel, where `ss` does not see them.
 */
export function withPublishedPorts(
  ports: readonly ListeningPort[],
  publishers: ReadonlyMap<number, PortPublisher>,
): ListeningPort[] {
  const listening = new Set(ports.map((port) => port.port));
  const added: ListeningPort[] = [];
  for (const [port, publisher] of publishers) {
    if (!listening.has(port)) added.push({ port, addresses: [publisher.hostIp ?? '0.0.0.0'] });
  }
  if (added.length === 0) return [...ports];
  return [...ports, ...added].sort((a, b) => a.port - b.port);
}

const ANY_ADDRESS = new Set(['*', '0.0.0.0', '::']);

/** Who can reach the port, in a few words. */
export function portReach(port: ListeningPort): string {
  if (isLoopbackOnlyPort(port)) return 'this host only';
  if (port.addresses.some((address) => ANY_ADDRESS.has(address))) return 'all addresses';
  return port.addresses.join(', ');
}

/** Lower-cased `filter` against the port number, its program, its container and its addresses. */
export function portMatches(port: ListeningPort, filter: string, container?: string): boolean {
  if (!filter) return true;
  return (
    String(port.port).includes(filter) ||
    !!port.process?.toLowerCase().includes(filter) ||
    !!container?.toLowerCase().includes(filter) ||
    port.addresses.some((address) => address.toLowerCase().includes(filter))
  );
}

/** The running local forward that already carries a port of this connection. */
export function forwardForPort(
  forwards: readonly ForwardInfo[],
  connId: string | undefined,
  port: ListeningPort,
): ForwardInfo | undefined {
  if (!connId) return undefined;
  const target = listeningPortTarget(port);
  return forwards.find(
    (forward) =>
      forward.connId === connId &&
      forward.type === 'local' &&
      forward.status === 'active' &&
      forward.targetPort === port.port &&
      forward.targetHost === target,
  );
}

/** `3 ports`, or `2 of 14 ports` while a filter hides some. */
export function portCountLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'port' : 'ports';
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}
