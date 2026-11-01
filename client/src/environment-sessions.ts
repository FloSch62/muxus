import {
  environmentTitle,
  savedHostHop,
  type ContainerlabLab,
  type ContainerlabNode,
  type EnvironmentTarget,
  type SessionProfile,
  type SshProfile,
  type VncProfile,
} from '@muxus/shared';
import { openRemotePort } from './api/environments.js';
import { environmentSource } from './environments.js';
import { openSessionProfile } from './session-actions.js';
import { confirmAction, promptForText } from './state/dialogs.js';
import type { EnvironmentHost } from './state/environments.js';
import { useMultiExecStore } from './state/multi-exec.js';
import {
  isMultiExecTarget,
  useTabsStore,
  type SessionSetEntry,
  type SessionSetLayout,
} from './state/tabs.js';
import { showToast } from './state/toast.js';

function hostSuffix(host: EnvironmentHost): string {
  return host.profile ? ` · ${host.label}` : '';
}

/** The profile of a session that enters `target` on `host`. */
export function environmentProfile(host: EnvironmentHost, target: EnvironmentTarget): SessionProfile {
  return host.profile ? { ...host.profile, environment: target } : { kind: 'local', environment: target };
}

/** Open a terminal into a container, pod, guest or console. */
export function openEnvironmentTarget(host: EnvironmentHost, target: EnvironmentTarget): string {
  return openSessionProfile(
    environmentProfile(host, target),
    `${environmentTitle(target)}${hostSuffix(host)}`,
    host.color,
  );
}

/** How a hop through `host` is written in a ProxyJump list. */
function jumpThrough(host: EnvironmentHost): string | undefined {
  if (!host.profile) return undefined;
  return host.profile.profileId ? savedHostHop(host.profile.profileId) : host.profile.target;
}

function bracketed(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

/**
 * SSH to an address only the host can reach (a lab node, a VM on a private
 * bridge), jumping through the host. This computer's own addresses need no jump.
 */
export function sshThroughHost(host: EnvironmentHost, address: string, user?: string): SshProfile {
  const jump = jumpThrough(host);
  return {
    kind: 'ssh',
    target: `${user ? `${user}@` : ''}${bracketed(address)}`,
    ...(jump ? { proxyJump: [jump] } : {}),
  };
}

const lastUsers = new Map<string, string>();

/** Ask which user to log in as, offering the last one used for this host. */
async function askUser(host: EnvironmentHost, address: string): Promise<string | null> {
  const value = await promptForText({
    title: `SSH to ${address}`,
    description: host.profile ? `Through ${host.label}.` : undefined,
    label: 'User',
    initialValue: lastUsers.get(host.key) ?? '',
    placeholder: 'Your local user name',
    allowEmpty: true,
    confirmLabel: 'Connect',
  });
  if (value === null) return null;
  lastUsers.set(host.key, value.trim());
  return value.trim();
}

/** SSH to a guest's address, asking for the user first. */
export async function openSshToAddress(host: EnvironmentHost, address: string, name: string): Promise<void> {
  const user = await askUser(host, address);
  if (user === null) return;
  openSessionProfile(sshThroughHost(host, address, user || undefined), `${name}${hostSuffix(host)}`, host.color);
}

/** A VNC display on the host, through the host when it is remote. */
export function openVncOnHost(
  host: EnvironmentHost,
  display: { host: string; port: number },
  name: string,
): void {
  const profile: VncProfile = {
    kind: 'vnc',
    host: display.host,
    port: display.port,
    ...(host.profile
      ? {
          sshGateway: {
            target: host.profile.target,
            ...(host.profile.profileId ? { profileId: host.profile.profileId } : {}),
          },
        }
      : {}),
  };
  openSessionProfile(profile, `${name}${hostSuffix(host)}`, host.color);
}

// ---------------------------------------------------------------------------
// Containerlab
// ---------------------------------------------------------------------------

/** Kinds that are plain Linux containers: entered with exec, not SSH. */
const EXEC_KINDS = new Set(['linux', 'k8s-kind', 'ext-container']);

/** Whether a lab node opens with SSH to its management address. */
export function nodeUsesSsh(node: ContainerlabNode): boolean {
  return !!node.ipv4 && !EXEC_KINDS.has(node.kind);
}

/** Network operating systems in containerlab log in as admin unless a topology says otherwise. */
const NODE_USER = 'admin';

export function containerlabNodeEntry(
  host: EnvironmentHost,
  lab: ContainerlabLab,
  node: ContainerlabNode,
): SessionSetEntry {
  const title = `${node.name}${hostSuffix(host)}`;
  if (nodeUsesSsh(node)) {
    return { profile: sshThroughHost(host, node.ipv4!, NODE_USER), title, color: host.color };
  }
  return {
    profile: environmentProfile(host, { kind: 'container', runtime: lab.runtime, container: node.container }),
    title,
    color: host.color,
  };
}

export function openContainerlabNode(host: EnvironmentHost, lab: ContainerlabLab, node: ContainerlabNode): void {
  const entry = containerlabNodeEntry(host, lab, node);
  openSessionProfile(entry.profile, entry.title, entry.color);
}

/**
 * Open several sessions side by side, replacing the current layout the way
 * launching a sidebar folder does, and type into all of them at once.
 */
export async function openSessionGrid(
  label: string,
  entries: readonly SessionSetEntry[],
  options: { layout?: SessionSetLayout; multiExec?: boolean } = {},
): Promise<void> {
  if (entries.length === 0) return;
  const live = useTabsStore.getState().tabs.some((tab) => tab.profile && tab.status !== 'closed');
  if (
    live &&
    !(await confirmAction({
      title: `Open ${label}`,
      description: `${entries.length} sessions replace the current layout. Live sessions in it are closed.`,
      confirmLabel: 'Open',
    }))
  ) {
    return;
  }
  const ids = useTabsStore
    .getState()
    .launchSet(entries, options.layout ?? (entries.length > 1 ? 'grid' : 'tabs'));
  useMultiExecStore.getState().setGroups([]);
  if (options.multiExec && ids.length > 1) mirrorOnceConnected(ids);
}

/** Give up on sessions that have not connected by then and mirror the rest. */
const MIRROR_WAIT_MS = 30_000;

/**
 * Mirrored input only reaches connected terminals, so a freshly launched set
 * joins it as its sessions come up: once all are connected, or with whatever
 * has connected when the wait runs out.
 */
function mirrorOnceConnected(ids: readonly string[]): void {
  let settled = false;
  const connected = () =>
    useTabsStore
      .getState()
      .tabs.filter((tab) => ids.includes(tab.id) && isMultiExecTarget(tab))
      .map((tab) => tab.id);
  const finish = (targets: string[]) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    window.clearTimeout(timer);
    if (targets.length > 1) useMultiExecStore.getState().setSelection(targets);
  };
  const unsubscribe = useTabsStore.subscribe((state) => {
    const open = state.tabs.filter((tab) => ids.includes(tab.id));
    // The set was closed or replaced before it came up.
    if (open.length === 0) return finish([]);
    const ready = connected();
    if (ready.length === open.length) finish(ready);
  });
  const timer = window.setTimeout(() => finish(connected()), MIRROR_WAIT_MS);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

const HTTPS_PORTS = new Set([443, 8006, 8443, 9443, 10443]);

export function portScheme(port: number): 'http' | 'https' {
  return HTTPS_PORTS.has(port) ? 'https' : 'http';
}

function loopbackFor(address: string | undefined): string {
  return !address || address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address;
}

/**
 * Open a port the host serves in the browser: directly on this computer,
 * through an SSH forward otherwise. The forward shows in the forwarding
 * panel and stops with the connection.
 */
export async function openHostPort(
  host: EnvironmentHost,
  address: string | undefined,
  port: number,
  scheme: 'http' | 'https' = portScheme(port),
): Promise<void> {
  // The window must open within the click, before any await.
  const view = window.open('about:blank', '_blank');
  try {
    let url: string;
    if (!host.profile) {
      const target = loopbackFor(address);
      url = `${scheme}://${target === '127.0.0.1' ? 'localhost' : bracketed(target)}:${port}/`;
    } else {
      const source = await environmentSource(host, true);
      if (source?.kind !== 'ssh') throw new Error(`${host.label} is not connected`);
      const forward = await openRemotePort(source.connId, loopbackFor(address), port);
      url = `${scheme}://127.0.0.1:${forward.localPort}/`;
    }
    if (view) view.location.href = url;
    else window.open(url, '_blank', 'noopener');
  } catch (error) {
    view?.close();
    showToast('error', `Could not open port ${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Kubus
// ---------------------------------------------------------------------------

let kubusInstalled: Promise<boolean> | undefined;

/** Whether the Kubus desktop app can take kubus:// links on this computer. */
export function kubusAvailable(): Promise<boolean> {
  kubusInstalled ??= window.muxusDesktop?.kubusAvailable?.().catch(() => false) ?? Promise.resolve(false);
  return kubusInstalled;
}

/** Kubus's own route for a pod's details. */
export function kubusPodRoute(context: string, namespace: string, pod: string): string {
  const selection = new URLSearchParams({ sel: `${context}|${namespace}|${pod}` });
  return `/r/core/v1/pods?${selection.toString()}`;
}

export function openInKubus(route: string): void {
  void window.muxusDesktop?.openKubus?.(route);
}
