import {
  MAX_SHARED_SESSION_HOSTS,
  savedHostHop,
  savedHostHopId,
  type SavedHostSessionProfile,
  type SharedSessionApplyResult,
  type SharedSessionFetchResponse,
  type SharedSessionHost,
  type SharedSessionSource,
} from '@muxus/shared';
import { apiFetch } from './api/http.js';
import { BACKUP_FORMAT } from './data-transfer.js';
import { parseMobaXtermSessions } from './mobaxterm-import.js';
import { SHARED_SESSIONS_FORMAT, SHARED_SESSIONS_VERSION } from './shared-sessions-format.js';
import {
  cleanImportName,
  importedConnections,
  normalizeImportFolder,
  stableImportId,
} from './session-import.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const MAX_FOLDER_LENGTH = 300;
const SAVED_KINDS = ['ssh', 'telnet', 'serial', 'rdp', 'vnc', 'gnmi', 'netconf', 'web'] as const;
/** Where the SSH gateways of a MobaXterm list go, inside the link's folder. */
const JUMP_HOST_FOLDER = 'Jump hosts';

export type SharedSessionsFormat = 'mobaxterm' | 'muxus';

export interface SharedSessionsList {
  format: SharedSessionsFormat;
  hosts: SharedSessionHost[];
  /** Entries left out: protocols Muxus does not import, or incomplete ones. */
  skipped: number;
}

/** A host as the list names it, before it gets its place in Muxus. */
interface ListedHost {
  /** Identity inside the list; other entries refer to it as a jump host. */
  key: string;
  name: string;
  profile: Record<string, unknown> & { kind: SavedHostSessionProfile['kind'] };
  folder?: string;
  color?: string;
  icon?: string;
}

/**
 * Turn the text behind a shared sessions link into the hosts it lists.
 *
 * Three formats are read: MobaXterm's session file (`.mxtsessions`, as its
 * shared sessions use), the session list Muxus writes when a folder is
 * shared, and a Muxus backup, of which only the hosts are used.
 *
 * Host IDs are derived from the link and the entry, never taken from the
 * list: the same entry keeps its host across checks, and a list cannot
 * address a host it did not bring.
 */
export function parseSharedSessions(
  content: string,
  source: Pick<SharedSessionSource, 'id' | 'folder'>,
): SharedSessionsList {
  const text = content.replace(/^﻿/, '').trim();
  if (!text) throw new Error('The link returned nothing.');
  if (/^<(?:!doctype|html|\?xml)/i.test(text)) {
    throw new Error('The link returned a web page instead of a session list. It may need a sign-in.');
  }
  const listed = text.startsWith('{') ? jsonHosts(text) : mobaXtermHosts(text);
  if (listed.hosts.length === 0) throw new Error('The shared sessions list has no hosts.');
  if (listed.hosts.length > MAX_SHARED_SESSION_HOSTS) {
    throw new Error(`The shared sessions list has more than ${MAX_SHARED_SESSION_HOSTS} hosts.`);
  }

  const ids = new Map<string, string>();
  for (const host of listed.hosts) {
    ids.set(host.key, stableImportId('shared', `${source.id}\0${host.key}`));
  }
  return {
    format: listed.format,
    skipped: listed.skipped,
    hosts: listed.hosts.map((host) => {
      const group = [source.folder, host.folder].filter(Boolean).join('/').slice(0, MAX_FOLDER_LENGTH);
      return {
        id: ids.get(host.key)!,
        name: host.name,
        profile: placedProfile(host.profile, ids, listed.aliases),
        ...(group ? { group } : {}),
        ...(host.color ? { color: host.color } : {}),
        ...(host.icon ? { icon: host.icon } : {}),
      };
    }),
  };
}

/**
 * Read a link and make its hosts match. Resolves to nothing when the link is
 * not due (another window just read it). A list that cannot be understood is
 * recorded with the link, and the hosts it had stay.
 */
export async function syncSharedSessions(
  source: Pick<SharedSessionSource, 'id' | 'folder'>,
  options: { force?: boolean } = {},
): Promise<SharedSessionApplyResult | undefined> {
  const base = `/api/shared-sessions/${encodeURIComponent(source.id)}`;
  const fetched = await apiFetch<SharedSessionFetchResponse>(
    `${base}/fetch${options.force ? '?force=true' : ''}`,
    { method: 'POST' },
  );
  if (fetched.status === 'not-due') return undefined;
  const apply = (body: unknown) =>
    apiFetch<SharedSessionApplyResult>(`${base}/apply`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  let hosts: SharedSessionHost[];
  try {
    hosts = parseSharedSessions(fetched.content, source).hosts;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The shared sessions could not be read.';
    await apply({ error: message });
    throw new Error(message, { cause: error });
  }
  return apply({ hosts });
}

interface Listed {
  format: SharedSessionsFormat;
  hosts: ListedHost[];
  skipped: number;
  /** ssh_config aliases of the list and the key of the host each became. */
  aliases: ReadonlyMap<string, { key: string; target: string }>;
}

function mobaXtermHosts(text: string): Listed {
  if (!/^\s*\[Bookmarks(?:_\d+)?\]\s*$/im.test(text)) {
    throw new Error('The link returned neither a MobaXterm session file nor a Muxus session list.');
  }
  const parsed = parseMobaXtermSessions(text);
  // Muxus-owned hosts: a list never writes into the user's ssh_config.
  const { savedHosts } = importedConnections(parsed.sessions, 'MobaXterm', 'muxus');
  const jumpFolder = 'MobaXterm jump hosts';
  return {
    format: 'mobaxterm',
    skipped: parsed.ignoredCount,
    aliases: new Map(),
    hosts: savedHosts.map((host) => ({
      key: host.id,
      name: host.name,
      profile: host.profile as ListedHost['profile'],
      folder: host.metadata.group === jumpFolder ? JUMP_HOST_FOLDER : host.metadata.group ?? undefined,
    })),
  };
}

function jsonHosts(text: string): Listed {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('The link returned JSON that cannot be read.');
  }
  if (isRecord(document) && document.format === SHARED_SESSIONS_FORMAT) return sessionListHosts(document);
  if (isRecord(document) && document.format === BACKUP_FORMAT && isRecord(document.data)) {
    return backupHosts(document.data);
  }
  throw new Error('The link returned JSON that is neither a Muxus session list nor a Muxus backup.');
}

/** Entries of a list keep apart even when two share an id, or have none. */
function listedHostCollector() {
  const hosts: ListedHost[] = [];
  const keys = new Set<string>();
  const add = (host: ListedHost): string => {
    let key = host.key;
    for (let suffix = 2; keys.has(key); suffix++) key = `${host.key}\0${suffix}`;
    keys.add(key);
    hosts.push({ ...host, key });
    return key;
  };
  return { hosts, add };
}

/** The list a shared folder is written as: its hosts, each with the folder it sits in. */
function sessionListHosts(document: Record<string, unknown>): Listed {
  if (typeof document.version === 'number' && document.version > SHARED_SESSIONS_VERSION) {
    throw new Error('This session list was written by a newer Muxus. Update Muxus to follow it.');
  }
  const { hosts, add } = listedHostCollector();
  let skipped = 0;
  for (const entry of arrayOf(document.hosts)) {
    const name = isRecord(entry) && typeof entry.name === 'string' ? cleanImportName(entry.name) : '';
    const profile = isRecord(entry) ? entry.profile : undefined;
    if (!isRecord(entry) || !name || !isRecord(profile) || !isSavedKind(profile.kind)) {
      skipped++;
      continue;
    }
    const look = listedLook({ group: entry.folder, color: entry.color, icon: entry.icon });
    add({
      key:
        typeof entry.id === 'string' && entry.id
          ? entry.id
          : `${profile.kind}\0${look.folder ?? ''}\0${name}`,
      name,
      profile: { ...profile, kind: profile.kind },
      ...look,
    });
  }
  return { format: 'muxus', hosts, skipped, aliases: new Map() };
}

/** A backup: only its hosts are used. */
function backupHosts(data: Record<string, unknown>): Listed {
  const { hosts, add } = listedHostCollector();
  const aliases = new Map<string, { key: string; target: string }>();
  let skipped = 0;

  for (const entry of arrayOf(data.savedHosts)) {
    const name = isRecord(entry) && typeof entry.name === 'string' ? cleanImportName(entry.name) : '';
    const profile = isRecord(entry) ? entry.profile : undefined;
    if (!isRecord(entry) || !name || !isRecord(profile) || !isSavedKind(profile.kind)) {
      skipped++;
      continue;
    }
    const look = listedLook(entry.metadata);
    add({
      key:
        typeof entry.id === 'string' && entry.id
          ? entry.id
          : `${profile.kind}\0${look.folder ?? ''}\0${name}`,
      name,
      profile: { ...profile, kind: profile.kind },
      ...look,
    });
  }

  // ssh_config hosts of a backup become Muxus-owned hosts with the same settings.
  for (const entry of arrayOf(data.sshHosts)) {
    const alias = isRecord(entry) && typeof entry.alias === 'string' ? entry.alias.trim() : '';
    if (!isRecord(entry) || !alias) {
      skipped++;
      continue;
    }
    const options = isRecord(entry.options) ? entry.options : {};
    const target = typeof options.hostname === 'string' && options.hostname.trim() ? options.hostname.trim() : alias;
    const metadata = isRecord(entry.metadata) ? entry.metadata : {};
    const key = add({
      key: `ssh\0${alias}`,
      name: (typeof metadata.displayName === 'string' && cleanImportName(metadata.displayName)) || cleanImportName(alias),
      profile: {
        kind: 'ssh',
        target,
        ...picked(options, SSH_OPTION_KEYS),
      },
      ...listedLook(metadata),
    });
    for (const name of [alias, ...arrayOf(entry.aliases).filter((value) => typeof value === 'string')]) {
      if (!aliases.has(name)) aliases.set(name, { key, target });
    }
  }
  return { format: 'muxus', hosts, skipped, aliases };
}

/** ssh_config options a Muxus-owned SSH host stores under the same name. */
const SSH_OPTION_KEYS = [
  'user',
  'port',
  'identityFiles',
  'certificateFiles',
  'identitiesOnly',
  'identityAgent',
  'forwardX11',
  'proxyJump',
  'forwards',
  'passwordOnly',
  'remoteCommand',
  'requestTty',
] as const;

/** Folder, color and icon are all a list decides about how a host looks. */
function listedLook(metadata: unknown): Pick<ListedHost, 'folder' | 'color' | 'icon'> {
  if (!isRecord(metadata)) return {};
  const folder = typeof metadata.group === 'string' ? normalizeImportFolder(metadata.group) : undefined;
  return {
    ...(folder ? { folder } : {}),
    ...(typeof metadata.color === 'string' && metadata.color ? { color: metadata.color } : {}),
    ...(typeof metadata.icon === 'string' && metadata.icon ? { icon: metadata.icon } : {}),
  };
}

/**
 * A listed profile with its references to other hosts of the list pointed
 * at the hosts they became. The server checks every field before it is
 * stored and drops what a list may not set.
 */
function placedProfile(
  listed: ListedHost['profile'],
  ids: ReadonlyMap<string, string>,
  aliases: Listed['aliases'],
): SavedHostSessionProfile {
  const { profileId: _profileId, ...profile } = listed;
  const hop = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const listedId = savedHostHopId(value);
    const key = listedId ?? aliases.get(value)?.key;
    const id = key === undefined ? undefined : ids.get(key);
    return id ? savedHostHop(id) : value;
  };
  const gateway = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const alias = typeof value.target === 'string' ? aliases.get(value.target) : undefined;
    const key = typeof value.profileId === 'string' ? value.profileId : alias?.key;
    const id = key === undefined ? undefined : ids.get(key);
    if (!id) return value;
    // A gateway named by alias is dialed at the address that alias stood for.
    const target = typeof value.profileId === 'string' ? value.target : alias?.target;
    return { ...value, target, profileId: id };
  };
  const placed: Record<string, unknown> = { ...profile };
  if (profile.kind === 'ssh') {
    placed.useConfig = false;
    if (Array.isArray(profile.proxyJump)) placed.proxyJump = profile.proxyJump.map(hop);
    if (Array.isArray(profile.proxyJumpFallbacks)) {
      placed.proxyJumpFallbacks = profile.proxyJumpFallbacks.map((route) =>
        Array.isArray(route) ? route.map(hop) : route,
      );
    }
  }
  if (profile.sshGateway !== undefined) placed.sshGateway = gateway(profile.sshGateway);
  if (Array.isArray(profile.sshGatewayFallbacks)) {
    placed.sshGatewayFallbacks = profile.sshGatewayFallbacks.map(gateway);
  }
  return placed as unknown as SavedHostSessionProfile;
}

function picked(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (record[key] === undefined || record[key] === null ? [] : [[key, record[key]]])),
  );
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSavedKind(value: unknown): value is SavedHostSessionProfile['kind'] {
  return (SAVED_KINDS as readonly unknown[]).includes(value);
}
