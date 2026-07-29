import type { HostBlockOptions } from '@muxus/shared';
import type {
  PortableConnections,
  PortableHostMetadata,
  PortableSshHost,
} from './data-transfer.js';

const MOBAXTERM_SSH_SESSION_TYPE = 109;
const BOOKMARK_SECTION_RE = /^Bookmarks(?:_\d+)?$/i;
const SESSION_TYPE_RE = /^#(\d+)#/;
const INVALID_ALIAS_CHARS_RE = /[\s#*?!]+/g;

export const MAX_MOBAXTERM_IMPORT_BYTES = 10 * 1024 * 1024;

export interface MobaXtermSession {
  /** Stable inside one parsed file and used by review selection controls. */
  id: string;
  name: string;
  alias: string;
  host: string;
  port: number;
  username?: string;
  folder?: string;
  authMode: 'key' | 'password';
}

export interface MobaXtermParseResult {
  sessions: MobaXtermSession[];
  /** Recognizable bookmark entries that were unsupported or incomplete. */
  ignoredCount: number;
}

/**
 * Parse SSH bookmarks from MobaXterm.ini or an .mxtsessions export.
 *
 * Session values use `#TYPE#flags%host%port%username%auth%...`; SSH is type
 * 109. This intentionally reads bookmark structure only—no P/C secret stores.
 */
export function parseMobaXtermSessions(text: string): MobaXtermParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_MOBAXTERM_IMPORT_BYTES) {
    throw new Error('That MobaXterm file is larger than 10 MB.');
  }

  const sessions: MobaXtermSession[] = [];
  const aliases = new Set<string>();
  let inBookmarks = false;
  let currentFolder: string | undefined;
  let ignoredCount = 0;

  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;

    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inBookmarks = BOOKMARK_SECTION_RE.test(section[1]?.trim() ?? '');
      currentFolder = undefined;
      continue;
    }
    if (!inBookmarks) continue;

    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (name.toLowerCase() === 'subrep') {
      currentFolder = normalizeFolder(value);
      continue;
    }

    const typeMatch = SESSION_TYPE_RE.exec(value);
    if (!typeMatch) continue;
    const type = Number.parseInt(typeMatch[1] ?? '', 10);
    if (type !== MOBAXTERM_SSH_SESSION_TYPE) {
      ignoredCount++;
      continue;
    }

    const fields = value.slice(typeMatch[0].length).split('%');
    const host = fields[1]?.trim();
    if (!name || !host) {
      ignoredCount++;
      continue;
    }
    const parsedPort = Number.parseInt(fields[2]?.trim() ?? '', 10);
    const port = parsedPort >= 1 && parsedPort <= 65_535 ? parsedPort : 22;
    const username = fields[3]?.trim() || undefined;
    const authMode = fields[4]?.trim() === '3' ? 'key' : 'password';
    const alias = uniqueAlias(name, host, aliases);
    aliases.add(alias);
    sessions.push({
      id: `${lineIndex}:${alias}`,
      name,
      alias,
      host,
      port,
      username,
      folder: currentFolder,
      authMode,
    });
  }

  if (sessions.length === 0) {
    throw new Error('No SSH sessions were found in this MobaXterm file.');
  }
  return { sessions, ignoredCount };
}

/** Convert reviewed MobaXterm rows into the existing portable restore pipeline. */
export function mobaXtermConnections(
  sessions: readonly MobaXtermSession[],
): PortableConnections {
  const sshHosts = sessions.map((session): PortableSshHost => {
    const options: HostBlockOptions = {
      hostname: session.host,
      ...(session.username ? { user: session.username } : {}),
      ...(session.port === 22 ? {} : { port: session.port }),
      ...(session.authMode === 'password' ? { passwordOnly: true } : {}),
    };
    const metadata: PortableHostMetadata = {
      displayName: session.name,
      ...(session.folder ? { group: session.folder } : {}),
    };
    return {
      alias: session.alias,
      aliases: [session.alias],
      description: 'Imported from MobaXterm.',
      options,
      metadata,
    };
  });
  return { sshHosts, savedHosts: [], hostOrder: [] };
}

function normalizeFolder(value: string): string | undefined {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => stripControlCharacters(part).trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('/') : undefined;
}

function stripControlCharacters(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint !== 0x7f) cleaned += character;
  }
  return cleaned;
}

function uniqueAlias(name: string, host: string, used: ReadonlySet<string>): string {
  const cleanedName = cleanAlias(name);
  const base = cleanedName || cleanAlias(host) || 'mobaxterm-host';
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function cleanAlias(value: string): string {
  return value
    .trim()
    .replace(INVALID_ALIAS_CHARS_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 240);
}
