import type { PortableConnections } from './data-transfer.js';
import {
  cleanImportName,
  importedConnections,
  normalizeImportFolder,
  type SkippedImportedSession,
  type ImportedSessionParseResult,
  type ImportedSshSession,
  uniqueImportAlias,
} from './session-import.js';

const MOBAXTERM_SSH_SESSION_TYPE = 109;
const BOOKMARK_SECTION_RE = /^Bookmarks(?:_\d+)?$/i;
const SESSION_TYPE_RE = /^#(\d+)#/;
const NON_SSH_REASON = 'Session type is not SSH (only SSH sessions can be imported)';
const MISSING_NAME_REASON = 'SSH session has no name';
const MISSING_HOST_REASON = 'SSH session has no hostname';
export const MAX_MOBAXTERM_IMPORT_BYTES = 10 * 1024 * 1024;

export interface MobaXtermSession extends ImportedSshSession {}

export interface MobaXtermParseResult
  extends ImportedSessionParseResult<MobaXtermSession> {}

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
  const skippedSessions: SkippedImportedSession[] = [];

  const skip = (lineIndex: number, name: string, fallback: string | undefined, reason: string) => {
    skippedSessions.push({
      id: `mobaxterm-skipped-${lineIndex}`,
      name: cleanImportName(name) || cleanImportName(fallback ?? '') || 'Unnamed session',
      folder: currentFolder,
      reason,
    });
  };

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
      currentFolder = normalizeImportFolder(value);
      continue;
    }

    const typeMatch = SESSION_TYPE_RE.exec(value);
    if (!typeMatch) continue;
    const type = Number.parseInt(typeMatch[1] ?? '', 10);
    if (type !== MOBAXTERM_SSH_SESSION_TYPE) {
      skip(lineIndex, name, undefined, NON_SSH_REASON);
      continue;
    }

    const fields = value.slice(typeMatch[0].length).split('%');
    const host = fields[1]?.trim();
    if (!name) {
      skip(lineIndex, name, host, MISSING_NAME_REASON);
      continue;
    }
    if (!host) {
      skip(lineIndex, name, undefined, MISSING_HOST_REASON);
      continue;
    }
    const parsedPort = Number.parseInt(fields[2]?.trim() ?? '', 10);
    const port = parsedPort >= 1 && parsedPort <= 65_535 ? parsedPort : 22;
    const username = fields[3]?.trim() || undefined;
    const authMode = fields[4]?.trim() === '3' ? 'key' : 'password';
    const alias = uniqueImportAlias(name, host, aliases, 'mobaxterm-host');
    aliases.add(alias);
    sessions.push({
      id: `${lineIndex}:${alias}`,
      kind: 'ssh',
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
  return {
    sessions,
    ignoredCount: skippedSessions.length,
    skippedSessions,
  };
}

/** Convert reviewed MobaXterm rows into the existing portable restore pipeline. */
export function mobaXtermConnections(
  sessions: readonly MobaXtermSession[],
): PortableConnections {
  return importedConnections(sessions, 'MobaXterm');
}
