import { isRunning, plainContainers, showHostEnvironments, type EnvironmentBadgeKind } from './environments.js';
import { openContainerlabNode, openEnvironmentTarget, nodeUsesSsh } from './environment-sessions.js';
import type { HostEnvironmentsEntry } from './state/environments.js';

/** One container, lab node, guest, VM or cluster the launcher can open. */
export interface EnvironmentLaunchItem {
  id: string;
  kind: EnvironmentBadgeKind;
  label: string;
  detail: string;
  keywords: string[];
  open: () => void;
}

/**
 * Everything running on the hosts read so far, ready to open from the quick
 * launcher: a container's shell, a lab node, a guest's console. Only what is
 * running is offered; clusters and labs open their host in the panel.
 */
export function environmentLaunchItems(entries: readonly HostEnvironmentsEntry[]): EnvironmentLaunchItem[] {
  const items: EnvironmentLaunchItem[] = [];
  for (const host of entries) {
    const where = host.label;
    for (const environment of host.environments) {
      switch (environment.kind) {
        case 'containers':
          for (const container of plainContainers(environment.containers)) {
            if (!isRunning(container.state)) continue;
            items.push({
              id: `environment:${host.key}:${environment.runtime}:${container.name}`,
              kind: environment.runtime,
              label: container.name,
              detail: `${where} › ${environment.runtime === 'docker' ? 'Docker' : 'Podman'}${container.composeProject ? ` · ${container.composeProject}` : ''} · ${container.image}`,
              keywords: ['container', environment.runtime, container.image, container.composeProject ?? '', where],
              open: () =>
                void openEnvironmentTarget(host, {
                  kind: 'container',
                  runtime: environment.runtime,
                  container: container.name,
                }),
            });
          }
          break;
        case 'containerlab':
          for (const lab of environment.labs) {
            items.push({
              id: `environment:${host.key}:lab:${lab.name}`,
              kind: 'containerlab',
              label: lab.name,
              detail: `${where} › Containerlab lab · ${lab.nodes.length} nodes`,
              keywords: ['containerlab', 'lab', 'topology', where],
              open: () => showHostEnvironments(host),
            });
            for (const node of lab.nodes) {
              if (!isRunning(node.state)) continue;
              items.push({
                id: `environment:${host.key}:lab:${lab.name}:${node.name}`,
                kind: 'containerlab',
                label: node.name,
                detail: `${where} › ${lab.name} · ${node.kind}${node.ipv4 ? ` · ${node.ipv4}` : ''}${nodeUsesSsh(node) ? ' · SSH' : ''}`,
                keywords: ['containerlab', 'node', lab.name, node.kind, node.ipv4 ?? '', where],
                open: () => openContainerlabNode(host, lab, node),
              });
            }
          }
          break;
        case 'kubernetes':
          for (const context of environment.contexts) {
            items.push({
              id: `environment:${host.key}:kubernetes:${context}`,
              kind: 'kubernetes',
              label: context,
              detail: `${where} › Kubernetes context${context === environment.currentContext ? ' · current' : ''}`,
              keywords: ['kubernetes', 'k8s', 'kubectl', 'cluster', 'pods', where],
              open: () => showHostEnvironments(host),
            });
          }
          break;
        case 'proxmox':
          for (const guest of environment.guests) {
            if (guest.status !== 'running') continue;
            items.push({
              id: `environment:${host.key}:proxmox:${guest.vmid}`,
              kind: 'proxmox',
              label: guest.name,
              detail: `${where} › Proxmox ${guest.type === 'qemu' ? 'VM' : 'CT'} ${guest.vmid} · ${guest.type === 'qemu' ? 'serial console' : 'pct enter'}`,
              keywords: ['proxmox', 'vm', 'lxc', String(guest.vmid), where],
              open: () =>
                void openEnvironmentTarget(
                  host,
                  guest.type === 'lxc'
                    ? { kind: 'proxmox-lxc', vmid: guest.vmid }
                    : { kind: 'proxmox-serial', vmid: guest.vmid },
                ),
            });
          }
          break;
        case 'libvirt':
          for (const domain of environment.domains) {
            if (domain.state !== 'running') continue;
            items.push({
              id: `environment:${host.key}:libvirt:${environment.uri ?? ''}:${domain.name}`,
              kind: 'libvirt',
              label: domain.name,
              detail: `${where} › libvirt VM · serial console`,
              keywords: ['libvirt', 'virsh', 'kvm', 'qemu', 'vm', where],
              open: () =>
                void openEnvironmentTarget(host, {
                  kind: 'libvirt-console',
                  domain: domain.name,
                  uri: environment.uri,
                }),
            });
          }
          break;
      }
    }
  }
  return items;
}
