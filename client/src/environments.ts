import type {
  ContainerInfo,
  HostEnvironment,
  KubernetesPod,
  SavedHostProfile,
  SessionProfile,
  SshHostEntry,
} from '@muxus/shared';
import { ApiError } from './api/http.js';
import { dialProfile, type DialedConnection, type DialHandlers } from './api/dial.js';
import { fetchEnvironments, type EnvironmentSource } from './api/environments.js';
import {
  editableManagedHostForProfile,
  managedHostDisplayName,
  managedHostKey,
  type ManagedHost,
} from './managed-hosts.js';
import {
  LOCAL_ENVIRONMENT_KEY,
  useEnvironmentsStore,
  type EnvironmentHost,
  type HostEnvironmentsEntry,
} from './state/environments.js';
import { usePrefsStore } from './state/prefs.js';
import { useTabsStore } from './state/tabs.js';
import { useUiStore } from './state/ui.js';

export const LOCAL_ENVIRONMENT_HOST: EnvironmentHost = {
  key: LOCAL_ENVIRONMENT_KEY,
  label: 'This computer',
};

/** The SSH host a sidebar entry stands for; other protocols run no commands. */
export function environmentHostForManaged(host: ManagedHost): EnvironmentHost | undefined {
  if (host.kind === 'ssh') {
    return {
      key: managedHostKey(host),
      label: managedHostDisplayName(host),
      profile: { kind: 'ssh', target: host.entry.alias },
      color: host.entry.metadata?.color,
      discover: host.entry.metadata?.discoverEnvironments,
    };
  }
  if (host.entry.profile.kind !== 'ssh') return undefined;
  return {
    key: managedHostKey(host),
    label: managedHostDisplayName(host),
    profile: { ...host.entry.profile, profileId: host.entry.id },
    color: host.entry.metadata.color,
    discover: host.entry.metadata.discoverEnvironments,
  };
}

/** The host a live tab is connected to: a sidebar host, or an ad-hoc target. */
export function environmentHostForProfile(
  profile: SessionProfile,
  sshHosts: readonly SshHostEntry[],
  savedProfiles: readonly SavedHostProfile[],
): EnvironmentHost | undefined {
  if (profile.kind !== 'ssh') return undefined;
  const managed = editableManagedHostForProfile(profile, sshHosts, savedProfiles);
  if (managed) return environmentHostForManaged(managed);
  if (profile.profileId || profile.useConfig === false) return undefined;
  return { key: `target:${profile.target}`, label: profile.target, profile: { kind: 'ssh', target: profile.target } };
}

function sameHost(profile: SessionProfile | null, host: EnvironmentHost): boolean {
  if (profile?.kind !== 'ssh' || !host.profile) return false;
  if (host.profile.profileId) return profile.profileId === host.profile.profileId;
  return !profile.profileId && profile.target === host.profile.target;
}

/** A transport to the host some tab already holds. */
export function liveConnectionFor(host: EnvironmentHost): string | undefined {
  const tabs = useTabsStore.getState().tabs;
  return tabs.find((tab) => tab.status === 'connected' && tab.connId && sameHost(tab.profile, host))?.connId;
}

/**
 * Shell-less transports dialed for the panel, by host key. They keep the
 * host readable while the panel shows it and are let go when it closes.
 */
const dials = new Map<string, DialedConnection>();
/** Answers the panel gives to password and host key prompts while it is open. */
let dialHandlers: DialHandlers | undefined;

export function setEnvironmentDialHandlers(handlers: DialHandlers | undefined): void {
  dialHandlers = handlers;
}

export function releaseEnvironmentDials(): void {
  for (const dial of dials.values()) dial.close();
  dials.clear();
  forgetDisconnectedHosts();
}

/** Whether Muxus can read the host now without connecting: this computer, a connected tab, or the panel's own connection. */
export function hostConnected(host: EnvironmentHost): boolean {
  return !host.profile || dials.has(host.key) || liveConnectionFor(host) !== undefined;
}

/**
 * Drop what is known about hosts nobody is connected to, so nothing is shown
 * for them. `keep` is the host the panel is open on, which may be connecting.
 */
export function forgetDisconnectedHosts(keep?: string): void {
  const store = useEnvironmentsStore.getState();
  for (const key of store.order) {
    const entry = store.entries[key];
    if (!entry || key === keep || reading.has(key) || hostConnected(entry)) continue;
    store.remove(key);
  }
}

/**
 * Where to run a host's tools. `interactive` may dial the host, asking for
 * passwords through the open panel; otherwise only an existing transport counts.
 */
export async function environmentSource(
  host: EnvironmentHost,
  interactive: boolean,
): Promise<EnvironmentSource | undefined> {
  if (!host.profile) return { kind: 'local' };
  const live = liveConnectionFor(host);
  if (live) return { kind: 'ssh', connId: live };
  const held = dials.get(host.key);
  if (held) return { kind: 'ssh', connId: held.connId };
  if (!interactive || !dialHandlers) return undefined;
  const dialed = await dialProfile(host.profile, dialHandlers);
  dials.set(host.key, dialed);
  return { kind: 'ssh', connId: dialed.connId };
}

/** Forget a dial whose transport went away, so the next request dials again. */
function dropDial(host: EnvironmentHost, connId: string): void {
  const held = dials.get(host.key);
  if (held?.connId !== connId) return;
  held.close();
  dials.delete(host.key);
}

const reading = new Map<string, Promise<void>>();

interface ReadOptions {
  automatic: boolean;
  interactive: boolean;
  /** A background refresh: keep showing the last result until the new one arrives. */
  quiet?: boolean;
}

/** Read what a host runs and store it. Concurrent requests for one host share a reading. */
export function discoverHost(host: EnvironmentHost, options: ReadOptions): Promise<void> {
  const pending = reading.get(host.key);
  if (pending) return pending;
  const run = readHost(host, options).finally(() => reading.delete(host.key));
  reading.set(host.key, run);
  return run;
}

async function readHost(host: EnvironmentHost, { automatic, interactive, quiet }: ReadOptions): Promise<void> {
  const store = useEnvironmentsStore.getState();
  const existing = store.entries[host.key];
  // An explicit request keeps the host listed even if it was found automatically.
  const keepAutomatic = automatic && (existing?.automatic ?? true);
  store.update(host, quiet && existing ? { automatic: keepAutomatic } : { status: 'loading', message: undefined, automatic: keepAutomatic });
  for (let attempt = 0; attempt < 2; attempt++) {
    let source: EnvironmentSource | undefined;
    try {
      source = await environmentSource(host, interactive);
    } catch (error) {
      store.update(host, { status: 'offline', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!source) {
      store.update(host, { status: 'offline', message: 'Not connected.' });
      return;
    }
    try {
      const response = await fetchEnvironments(source, automatic);
      if (response.status === 'unsupported') {
        store.update(host, { status: 'unsupported', message: response.message });
        return;
      }
      store.update(host, {
        status: 'ready',
        environments: response.environments,
        problems: response.problems,
        sampledAt: response.sampledAt,
      });
      return;
    } catch (error) {
      // The transport closed under us: try once more over another one.
      if (error instanceof ApiError && error.status === 404 && source.kind === 'ssh') {
        dropDial(host, source.connId);
        continue;
      }
      store.update(host, { status: 'error', message: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  store.update(host, { status: 'offline', message: 'The connection closed.' });
}

/** Read a host again over whatever transport it has, dialing if the panel can ask. */
export function refreshHost(entry: HostEnvironmentsEntry): Promise<void> {
  return discoverHost(entry, { automatic: false, interactive: true });
}

/** Whether a host is read without being asked: its own choice, else the global setting. */
export function discoveryEnabledFor(host: EnvironmentHost): boolean {
  return host.discover ?? usePrefsStore.getState().discoverEnvironments;
}

/**
 * Read every host that can be read without connecting again, quietly. Hosts
 * that run no commands, and hosts found automatically whose discovery is now
 * off, are left alone.
 */
export function refreshConnectedHosts(): void {
  const { entries, order } = useEnvironmentsStore.getState();
  for (const key of order) {
    const entry = entries[key];
    if (!entry || entry.status === 'unsupported' || entry.status === 'loading' || !hostConnected(entry)) continue;
    if (entry.automatic && !discoveryEnabledFor(entry)) continue;
    void discoverHost(entry, { automatic: entry.automatic, interactive: false, quiet: true });
  }
}

// ---------------------------------------------------------------------------
// What a host runs, summarized for badges and the launcher
// ---------------------------------------------------------------------------

export type EnvironmentBadgeKind = 'docker' | 'podman' | 'containerlab' | 'kubernetes' | 'proxmox' | 'libvirt';

export interface EnvironmentBadge {
  kind: EnvironmentBadgeKind;
  count: number;
  label: string;
}

export function isRunning(state: string): boolean {
  const normalized = state.toLowerCase();
  return normalized === 'running' || normalized === 'up' || normalized.startsWith('up ');
}

/** Containers of a runtime that are not a lab's nodes; those are listed under their lab. */
export function plainContainers(containers: readonly ContainerInfo[]): ContainerInfo[] {
  return containers.filter((container) => !container.containerlab);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One badge per kind of thing the host runs, counting what is up. */
export function environmentBadges(environments: readonly HostEnvironment[]): EnvironmentBadge[] {
  const badges: EnvironmentBadge[] = [];
  for (const environment of environments) {
    switch (environment.kind) {
      case 'containers': {
        const running = plainContainers(environment.containers).filter((c) => isRunning(c.state)).length;
        if (running > 0) {
          badges.push({
            kind: environment.runtime,
            count: running,
            label: `${environment.runtime === 'docker' ? 'Docker' : 'Podman'}: ${plural(running, 'running container')}`,
          });
        }
        break;
      }
      case 'containerlab':
        badges.push({
          kind: 'containerlab',
          count: environment.labs.length,
          label: `Containerlab: ${plural(environment.labs.length, 'lab')}`,
        });
        break;
      case 'kubernetes':
        badges.push({
          kind: 'kubernetes',
          count: environment.contexts.length,
          label: `Kubernetes: ${plural(environment.contexts.length, 'context')}`,
        });
        break;
      // A hypervisor counts its running guests, and shows even when all are
      // stopped: they are what the host is for.
      case 'proxmox': {
        if (environment.guests.length === 0) break;
        const running = environment.guests.filter((guest) => guest.status === 'running').length;
        badges.push({ kind: 'proxmox', count: running, label: `Proxmox: ${plural(running, 'running guest')}` });
        break;
      }
      case 'libvirt': {
        if (environment.domains.length === 0) break;
        const running = environment.domains.filter((domain) => domain.state === 'running').length;
        badges.push({ kind: 'libvirt', count: running, label: `libvirt: ${plural(running, 'running VM')}` });
        break;
      }
    }
  }
  return badges;
}

/** Hosts a launcher search may open things on, with what they run. */
export function readyEntries(): HostEnvironmentsEntry[] {
  const { entries, order } = useEnvironmentsStore.getState();
  return order
    .map((key) => entries[key])
    .filter((entry): entry is HostEnvironmentsEntry => !!entry && entry.environments.length > 0);
}

/** Open the panel on one host, reading it (and connecting, asking as needed) if nothing is known yet. */
export function showHostEnvironments(host: EnvironmentHost): void {
  const store = useEnvironmentsStore.getState();
  const entry = store.entries[host.key];
  store.update(host, entry ? { automatic: false } : { status: 'offline', automatic: false });
  useUiStore.getState().setEnvironmentsPanel({ hostKey: host.key });
}

/** The workload a pod belongs to: a ReplicaSet's pods belong to its Deployment. */
export function podWorkload(pod: KubernetesPod): { kind: string; name: string } | undefined {
  if (!pod.owner) return undefined;
  if (pod.owner.kind === 'ReplicaSet') {
    const deployment = /^(.+)-[a-z0-9]{5,10}$/.exec(pod.owner.name)?.[1];
    if (deployment) return { kind: 'Deployment', name: deployment };
  }
  return pod.owner;
}
