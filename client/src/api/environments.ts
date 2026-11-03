import type {
  ContainerlabTopologyResponse,
  ContainerRuntime,
  EnvironmentAction,
  EnvironmentActionResponse,
  EnvironmentAddressesResponse,
  EnvironmentPortResponse,
  EnvironmentsResponse,
  KubernetesNamespacesResponse,
  KubernetesPodsResponse,
  LibvirtDisplayResponse,
  LibvirtUri,
} from '@muxus/shared';
import { apiFetch } from './http.js';

/** Where a host's tools run: this computer, or the far end of a live SSH connection. */
export type EnvironmentSource = { kind: 'local' } | { kind: 'ssh'; connId: string };

function base(source: EnvironmentSource): string {
  return source.kind === 'local'
    ? '/api/environments/local'
    : `/api/environments/ssh/${encodeURIComponent(source.connId)}`;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function fetchEnvironments(source: EnvironmentSource, auto: boolean): Promise<EnvironmentsResponse> {
  return apiFetch<EnvironmentsResponse>(`${base(source)}${auto ? '?auto=1' : ''}`);
}

export function fetchKubernetesNamespaces(
  source: EnvironmentSource,
  context: string | undefined,
): Promise<KubernetesNamespacesResponse> {
  return apiFetch(`${base(source)}/kubernetes/namespaces${query({ context })}`);
}

/** `namespace` undefined lists every namespace. */
export function fetchKubernetesPods(
  source: EnvironmentSource,
  context: string | undefined,
  namespace: string | undefined,
): Promise<KubernetesPodsResponse> {
  return apiFetch(`${base(source)}/kubernetes/pods${query({ context, namespace })}`);
}

export function fetchContainerlabTopology(
  source: EnvironmentSource,
  runtime: ContainerRuntime,
  lab: string,
): Promise<ContainerlabTopologyResponse> {
  return apiFetch(`${base(source)}/containerlab/topology${query({ runtime, lab })}`);
}

export function fetchLibvirtAddresses(
  source: EnvironmentSource,
  uri: LibvirtUri | undefined,
  domain: string,
): Promise<EnvironmentAddressesResponse> {
  return apiFetch(`${base(source)}/libvirt/addresses${query({ uri, domain })}`);
}

export function fetchLibvirtDisplay(
  source: EnvironmentSource,
  uri: LibvirtUri | undefined,
  domain: string,
): Promise<LibvirtDisplayResponse> {
  return apiFetch(`${base(source)}/libvirt/display${query({ uri, domain })}`);
}

export function fetchProxmoxAddresses(
  source: EnvironmentSource,
  type: 'qemu' | 'lxc',
  vmid: number,
): Promise<EnvironmentAddressesResponse> {
  return apiFetch(`${base(source)}/proxmox/addresses${query({ type, vmid })}`);
}

export function runEnvironmentAction(
  source: EnvironmentSource,
  action: EnvironmentAction,
): Promise<EnvironmentActionResponse> {
  return apiFetch(`${base(source)}/actions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(action),
  });
}

/** Forward a port on the far side of an SSH connection to a free local port. */
export function openRemotePort(connId: string, host: string, port: number): Promise<EnvironmentPortResponse> {
  return apiFetch(`/api/environments/ssh/${encodeURIComponent(connId)}/ports`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ host, port }),
  });
}
