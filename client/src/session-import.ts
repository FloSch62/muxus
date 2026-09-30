import {
  savedHostHop,
  type HostBlockOptions,
  type SerialProfile,
  type SshGateway,
} from '@muxus/shared';
import type {
  PortableConnections,
  PortableHostMetadata,
  PortableSavedHost,
  PortableSshHost,
} from './data-transfer.js';

const INVALID_ALIAS_CHARS_RE = /[\s#*?!]+/g;
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

interface ImportedSessionBase {
  /** Stable inside one parsed file and used by review selection controls. */
  id: string;
  name: string;
  folder?: string;
}

/**
 * SSH host a session is reached through. Sessions sharing the same hop (and
 * the same hops before it) share one object, so it is imported once.
 */
export interface ImportedJumpHost {
  /** Stable inside one parsed file; identifies the hop and every hop before it. */
  id: string;
  /** ssh_config alias used when jump hosts are written to OpenSSH config. */
  alias: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  identityFile?: string;
  /** Hop dialed before this one, if the chain has several. */
  via?: ImportedJumpHost;
}

export interface ImportedSshSession extends ImportedSessionBase {
  kind: 'ssh';
  alias: string;
  host: string;
  port: number;
  username?: string;
  authMode: 'key' | 'password';
  identityFile?: string;
  /** Command run in a terminal instead of the login shell. */
  remoteCommand?: string;
  /** Last jump host before the target. */
  jumpHost?: ImportedJumpHost;
}

export interface ImportedDesktopSession extends ImportedSessionBase {
  kind: 'rdp' | 'vnc';
  host: string;
  port: number;
  username?: string;
  /** SSH host the desktop is tunnelled through. */
  jumpHost?: ImportedJumpHost;
}

export interface ImportedSerialSession extends ImportedSessionBase {
  kind: 'serial';
  /** Deterministic across imports so keep/replace can identify this profile. */
  profileId: string;
  path: string;
  baudRate: number;
  dataBits: SerialProfile['dataBits'];
  stopBits: SerialProfile['stopBits'];
  parity: SerialProfile['parity'];
  flowControl: SerialProfile['flowControl'];
}

export type ImportedSession =
  | ImportedSshSession
  | ImportedSerialSession
  | ImportedDesktopSession;
export type ImportedSshStorage = 'openssh' | 'muxus';

export interface SkippedImportedSession {
  /** Stable inside one parsed file and used as the React list key. */
  id: string;
  /** Session name, or the hostname/path when the source omitted a name. */
  name: string;
  folder?: string;
  reason: string;
}

export interface ImportedSessionParseResult<T extends ImportedSession = ImportedSession> {
  sessions: T[];
  /** Recognizable session entries that were unsupported or incomplete. */
  ignoredCount: number;
  /** Every ignored session together with the reason it cannot be imported. */
  skippedSessions: SkippedImportedSession[];
}

/**
 * Convert reviewed third-party rows into the existing portable restore pipeline.
 *
 * Jump hosts the sessions go through are appended after the sessions, once
 * each, in a "<source> jump hosts" folder: as saved Muxus SSH hosts the
 * sessions name as hops, or as Host blocks when SSH hosts go to ssh_config.
 */
export function importedConnections(
  sessions: readonly ImportedSession[],
  sourceName: string,
  sshStorage: ImportedSshStorage = 'openssh',
): PortableConnections {
  const sshHosts: PortableSshHost[] = [];
  const savedHosts: PortableSavedHost[] = [];
  const jumpHosts = new Map<string, ImportedJumpHost>();
  const idPrefix = sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const jumpProfileId = (jump: ImportedJumpHost) => stableImportId(`${idPrefix}-jump`, jump.id);
  const includeJumpHost = (jump: ImportedJumpHost): void => {
    for (let hop: ImportedJumpHost | undefined = jump; hop && !jumpHosts.has(hop.id); hop = hop.via) {
      jumpHosts.set(hop.id, hop);
    }
  };
  const jumpHop = (jump: ImportedJumpHost): string => {
    includeJumpHost(jump);
    return sshStorage === 'muxus' ? savedHostHop(jumpProfileId(jump)) : jump.alias;
  };
  const gateway = (jump: ImportedJumpHost): SshGateway => {
    includeJumpHost(jump);
    return sshStorage === 'muxus'
      ? { target: jump.host, profileId: jumpProfileId(jump) }
      : { target: jump.alias };
  };

  for (const session of sessions) {
    const metadata: PortableHostMetadata = {
      ...(session.kind === 'ssh' ? { displayName: session.name } : {}),
      ...(session.folder ? { group: session.folder } : {}),
    };
    if (session.kind === 'ssh') {
      const route = {
        ...(session.username ? { user: session.username } : {}),
        ...(session.port === 22 ? {} : { port: session.port }),
        ...(session.identityFile ? { identityFiles: [session.identityFile] } : {}),
        ...(session.jumpHost ? { proxyJump: [jumpHop(session.jumpHost)] } : {}),
        ...(session.authMode === 'password' ? { passwordOnly: true } : {}),
        // Interactive commands such as `sudo su -` need a terminal, as in the source app.
        ...(session.remoteCommand
          ? { remoteCommand: session.remoteCommand, requestTty: 'yes' as const }
          : {}),
      };
      if (sshStorage === 'muxus') {
        savedHosts.push({
          id: stableImportId(`${idPrefix}-ssh`, session.id),
          name: session.name,
          profile: { kind: 'ssh', target: session.host, useConfig: false, ...route },
          metadata: session.folder ? { group: session.folder } : {},
        });
        continue;
      }
      sshHosts.push({
        alias: session.alias,
        aliases: [session.alias],
        description: `Imported from ${sourceName}.`,
        options: { hostname: session.host, ...route },
        metadata,
      });
      continue;
    }

    if (session.kind !== 'serial') {
      savedHosts.push({
        id: stableImportId(`${idPrefix}-${session.kind}`, session.id),
        name: session.name,
        profile: {
          kind: session.kind,
          host: session.host,
          port: session.port,
          ...(session.username ? { username: session.username } : {}),
          ...(session.jumpHost ? { sshGateway: gateway(session.jumpHost) } : {}),
        },
        metadata,
      });
      continue;
    }

    savedHosts.push({
      id: session.profileId,
      name: session.name,
      profile: {
        kind: 'serial',
        path: session.path,
        baudRate: session.baudRate,
        dataBits: session.dataBits,
        stopBits: session.stopBits,
        parity: session.parity,
        flowControl: session.flowControl,
      },
      metadata,
    });
  }

  const jumpGroup = `${sourceName} jump hosts`;
  for (const jump of jumpHosts.values()) {
    const route = {
      ...(jump.username ? { user: jump.username } : {}),
      ...(jump.port === 22 ? {} : { port: jump.port }),
      ...(jump.identityFile ? { identityFiles: [jump.identityFile] } : { passwordOnly: true }),
    };
    if (sshStorage === 'muxus') {
      savedHosts.push({
        id: jumpProfileId(jump),
        name: jump.name,
        profile: {
          kind: 'ssh',
          target: jump.host,
          useConfig: false,
          ...route,
          ...(jump.via ? { proxyJump: [jumpHop(jump.via)] } : {}),
        },
        metadata: { group: jumpGroup },
      });
      continue;
    }
    const options: HostBlockOptions = {
      hostname: jump.host,
      ...route,
      ...(jump.via ? { proxyJump: [jumpHop(jump.via)] } : {}),
    };
    sshHosts.push({
      alias: jump.alias,
      aliases: [jump.alias],
      description: `Jump host imported from ${sourceName}.`,
      options,
      metadata: { displayName: jump.name, group: jumpGroup },
    });
  }

  return { sshHosts, savedHosts, hostOrder: [] };
}

export function normalizeImportFolder(value: string): string | undefined {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => stripControlCharacters(part).trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join('/').slice(0, 300).replace(/\/$/, '') || undefined;
}

export function stripControlCharacters(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint !== 0x7f) cleaned += character;
  }
  return cleaned;
}

export function cleanImportName(value: string): string {
  return stripControlCharacters(value).trim().slice(0, 200).trim();
}

export function uniqueImportAlias(
  name: string,
  host: string,
  used: ReadonlySet<string>,
  fallback = 'imported-host',
): string {
  const cleanedName = cleanImportAlias(name);
  const base = cleanedName || cleanImportAlias(host) || fallback;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export function stableImportId(prefix: string, value: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = (hash * FNV_PRIME_64) & UINT64_MASK;
  }
  return `${prefix}-${hash.toString(36)}`;
}

function cleanImportAlias(value: string): string {
  return stripControlCharacters(value)
    .trim()
    .replace(INVALID_ALIAS_CHARS_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 240);
}
