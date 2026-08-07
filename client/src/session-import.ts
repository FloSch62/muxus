import type { HostBlockOptions, SerialProfile } from '@muxus/shared';
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

export interface ImportedSshSession extends ImportedSessionBase {
  kind: 'ssh';
  alias: string;
  host: string;
  port: number;
  username?: string;
  authMode: 'key' | 'password';
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

export type ImportedSession = ImportedSshSession | ImportedSerialSession;
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

/** Convert reviewed third-party rows into the existing portable restore pipeline. */
export function importedConnections(
  sessions: readonly ImportedSession[],
  sourceName: string,
  sshStorage: ImportedSshStorage = 'openssh',
): PortableConnections {
  const sshHosts: PortableSshHost[] = [];
  const savedHosts: PortableSavedHost[] = [];

  for (const session of sessions) {
    const metadata: PortableHostMetadata = {
      ...(session.kind === 'ssh' ? { displayName: session.name } : {}),
      ...(session.folder ? { group: session.folder } : {}),
    };
    if (session.kind === 'ssh') {
      if (sshStorage === 'muxus') {
        savedHosts.push({
          id: stableImportId(
            `${sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-ssh`,
            session.id,
          ),
          name: session.name,
          profile: {
            kind: 'ssh',
            target: session.host,
            useConfig: false,
            ...(session.username ? { user: session.username } : {}),
            ...(session.port === 22 ? {} : { port: session.port }),
            ...(session.authMode === 'password' ? { passwordOnly: true } : {}),
          },
          metadata: session.folder ? { group: session.folder } : {},
        });
        continue;
      }
      const options: HostBlockOptions = {
        hostname: session.host,
        ...(session.username ? { user: session.username } : {}),
        ...(session.port === 22 ? {} : { port: session.port }),
        ...(session.authMode === 'password' ? { passwordOnly: true } : {}),
      };
      sshHosts.push({
        alias: session.alias,
        aliases: [session.alias],
        description: `Imported from ${sourceName}.`,
        options,
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
