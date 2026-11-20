import {
  savedHostHop,
  savedHostHopId,
  type FolderSettingsRecord,
} from '@muxus/shared';
import { savedProfileFolderDefaults } from './folder-defaults.js';
import { folderLabel, folderSegments, isDescendantPath, isSamePath } from './host-tree.js';
import { managedHostDisplayName, type ManagedHost } from './managed-hosts.js';
import {
  SHARED_SESSIONS_FORMAT,
  SHARED_SESSIONS_VERSION,
  type SharedSessionsDocument,
  type SharedSessionsDocumentHost,
} from './shared-sessions-format.js';

/** Where the jump hosts a list needs from outside its folder are put. */
export const SHARED_JUMP_HOST_FOLDER = 'Jump hosts';

export interface ShareFolderOptions {
  /** Keep the user each host logs in as; without it everyone is asked for theirs. */
  includeUsers: boolean;
  /** Keep where keys and certificates are on this computer. */
  includeKeyPaths: boolean;
}

export interface SharedFolder {
  document: SharedSessionsDocument;
  /** Hosts in the folder and its subfolders. */
  hostCount: number;
  /** Hosts from outside the folder that those are reached through, included with them. */
  jumpHostCount: number;
}

/** Settings a list never carries: they run on, or weaken a check of, whoever follows it. */
const NEVER_SHARED = ['profileId', 'proxyCommand', 'forwardAgent', 'strictHostKeyChecking', 'environment'];
const USER_FIELDS = ['user', 'username'];
const KEY_PATH_FIELDS = [
  'identityFiles',
  'certificateFiles',
  'identitiesOnly',
  'identityAgent',
  'caFile',
  'certFile',
  'keyFile',
];

/**
 * A folder of the sidebar as a session list for others: its hosts and those
 * of its subfolders, with the folders they sit in. A host from elsewhere
 * that one of them jumps through comes along, or the list would not connect.
 * ssh_config hosts are written with the settings they resolve to, since a
 * follower has no such config.
 */
export function shareFolder(
  folder: string,
  hosts: readonly ManagedHost[],
  folderSettings: readonly FolderSettingsRecord[],
  options: ShareFolderOptions,
  now = new Date(),
): SharedFolder {
  const byAlias = new Map<string, ManagedHost>();
  const byProfileId = new Map<string, ManagedHost>();
  for (const host of hosts) {
    if (host.kind === 'profile') byProfileId.set(host.entry.id, host);
    else for (const alias of host.entry.aliases) if (!byAlias.has(alias)) byAlias.set(alias, host);
  }

  const listed = new Map<string, SharedSessionsDocumentHost>();
  const pending: Array<{ host: ManagedHost; jumpHost: boolean }> = hosts
    .filter((host) => isInFolder(hostGroup(host), folder))
    .map((host) => ({ host, jumpHost: false }));
  const hostCount = pending.length;
  let jumpHostCount = 0;

  /** The list's id for a host another one goes through, queueing it when it is not listed yet. */
  const through = (host: ManagedHost | undefined): string | undefined => {
    if (!host) return undefined;
    const id = hostId(host);
    if (!listed.has(id) && !pending.some((entry) => hostId(entry.host) === id)) {
      pending.push({ host, jumpHost: true });
      jumpHostCount++;
    }
    return id;
  };
  const hop = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const profileId = savedHostHopId(value);
    const id = through(profileId === undefined ? byAlias.get(value) : byProfileId.get(profileId));
    return id === undefined ? value : savedHostHop(id);
  };
  const gateway = (value: unknown): unknown => {
    if (!isRecord(value) || typeof value.target !== 'string') return value;
    const host =
      typeof value.profileId === 'string' ? byProfileId.get(value.profileId) : byAlias.get(value.target);
    const id = through(host);
    if (id === undefined || !host) return value;
    return { target: hostAddress(host), profileId: id };
  };

  for (let index = 0; index < pending.length; index++) {
    const { host, jumpHost } = pending[index]!;
    const group = hostGroup(host);
    const profile = sharedProfile(host, folderSettings);
    if (Array.isArray(profile.proxyJump)) profile.proxyJump = profile.proxyJump.map(hop);
    if (Array.isArray(profile.proxyJumpFallbacks)) {
      profile.proxyJumpFallbacks = profile.proxyJumpFallbacks.map((route) =>
        Array.isArray(route) ? route.map(hop) : route,
      );
    }
    if (profile.sshGateway !== undefined) profile.sshGateway = gateway(profile.sshGateway);
    if (Array.isArray(profile.sshGatewayFallbacks)) {
      profile.sshGatewayFallbacks = profile.sshGatewayFallbacks.map(gateway);
    }
    for (const field of NEVER_SHARED) delete profile[field];
    if (!options.includeUsers) for (const field of USER_FIELDS) delete profile[field];
    if (!options.includeKeyPaths) for (const field of KEY_PATH_FIELDS) delete profile[field];

    const inside = jumpHost
      ? SHARED_JUMP_HOST_FOLDER
      : folderSegments(group).slice(folderSegments(folder).length).join('/');
    const { color, icon } = host.entry.metadata ?? {};
    listed.set(hostId(host), {
      id: hostId(host),
      name: managedHostDisplayName(host),
      ...(inside ? { folder: inside } : {}),
      ...(color ? { color } : {}),
      ...(icon ? { icon } : {}),
      profile,
    });
  }

  return {
    hostCount,
    jumpHostCount,
    document: {
      format: SHARED_SESSIONS_FORMAT,
      version: SHARED_SESSIONS_VERSION,
      name: folderLabel(folder),
      createdAt: now.toISOString(),
      hosts: [...listed.values()],
    },
  };
}

/** "Team lab" → `team-lab.muxus-sessions.json`. */
export function sharedSessionsFilename(folder: string): string {
  const slug = folderLabel(folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'shared'}.muxus-sessions.json`;
}

function isInFolder(group: string | undefined, folder: string): boolean {
  return !!group && (isSamePath(group, folder) || isDescendantPath(group, folder));
}

function hostGroup(host: ManagedHost): string | undefined {
  return host.entry.metadata?.group;
}

function hostId(host: ManagedHost): string {
  return host.kind === 'profile' ? host.entry.id : `ssh:${host.entry.alias}`;
}

/** What a gateway dials: the host's address, not a name only this computer knows. */
function hostAddress(host: ManagedHost): string {
  if (host.kind === 'ssh') return host.entry.resolved.hostname || host.entry.alias;
  const profile = host.entry.profile;
  return profile.kind === 'ssh' ? profile.target : host.entry.name;
}

/** A host's connection settings as they apply here, folder defaults included. */
function sharedProfile(
  host: ManagedHost,
  folderSettings: readonly FolderSettingsRecord[],
): SharedSessionsDocumentHost['profile'] {
  const inherited = savedProfileFolderDefaults(hostGroup(host), folderSettings).auth;
  if (host.kind === 'profile') {
    const profile: SharedSessionsDocumentHost['profile'] = { ...host.entry.profile };
    if (profile.kind === 'ssh') {
      for (const field of ['user', 'port', 'identityFiles', 'identitiesOnly', 'identityAgent'] as const) {
        profile[field] ??= inherited[field];
      }
    }
    return withoutEmpty(profile);
  }
  const { options, resolved } = host.entry;
  return withoutEmpty({
    kind: 'ssh',
    target: resolved.hostname || host.entry.alias,
    useConfig: false,
    user: resolved.user ?? inherited.user,
    port: resolved.port === 22 ? inherited.port : resolved.port,
    identityFiles: resolved.identityFiles.length ? resolved.identityFiles : inherited.identityFiles,
    certificateFiles: resolved.certificateFiles.length ? resolved.certificateFiles : undefined,
    identitiesOnly: resolved.identitiesOnly || inherited.identitiesOnly || undefined,
    identityAgent: resolved.identityAgent ?? inherited.identityAgent,
    forwardX11: resolved.forwardX11,
    proxyJump: resolved.proxyJump.length ? resolved.proxyJump : undefined,
    forwards: resolved.forwards.length ? resolved.forwards : undefined,
    passwordOnly: resolved.passwordOnly || undefined,
    remoteCommand: options.remoteCommand,
    requestTty: options.requestTty,
  });
}

function withoutEmpty<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
