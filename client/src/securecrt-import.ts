import type { PortableConnections } from './data-transfer.js';
import {
  cleanImportName,
  importedConnections,
  normalizeImportFolder,
  stableImportId,
  stripControlCharacters,
  type ImportedSerialSession,
  type ImportedSession,
  type ImportedSessionParseResult,
  type ImportedSshSession,
  uniqueImportAlias,
} from './session-import.js';

export const MAX_SECURECRT_IMPORT_BYTES = 20 * 1024 * 1024;

export type SecureCrtSession = ImportedSshSession | ImportedSerialSession;
export interface SecureCrtParseResult
  extends ImportedSessionParseResult<SecureCrtSession> {}

/** Parse SSH and serial sessions from a SecureCRT Tools -> Export Settings XML file. */
export function parseSecureCrtSessions(text: string): SecureCrtParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_SECURECRT_IMPORT_BYTES) {
    throw new Error('That SecureCRT file is larger than 20 MB.');
  }
  // The exported configuration can contain encrypted secrets and embedded
  // files. DTDs/entities are never part of the format and are rejected before
  // an untrusted document reaches the platform XML parser.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) {
    throw new Error('SecureCRT XML with declarations or entities is not supported.');
  }

  let document: Document;
  try {
    document = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    throw new Error('That SecureCRT XML file is malformed.');
  }
  const root = document.documentElement;
  if (
    !root ||
    root.tagName !== 'VanDyke' ||
    root.getElementsByTagName('parsererror').length > 0
  ) {
    throw new Error('That is not a valid SecureCRT XML export.');
  }
  const sessionsRoot = directElements(root, 'key').find(
    (element) => element.getAttribute('name') === 'Sessions',
  );
  if (!sessionsRoot) {
    throw new Error('No SecureCRT Sessions section was found in this XML file.');
  }

  const sessions: SecureCrtSession[] = [];
  const aliases = new Set<string>();
  const profileIds = new Set<string>();
  const sessionIds = new Set<string>();
  const skippedSessions: ImportedSessionParseResult['skippedSessions'] = [];

  const visit = (key: Element, folders: readonly string[], sourcePath: readonly string[]) => {
    const rawName = key.getAttribute('name') ?? '';
    const name = cleanImportName(rawName);
    const nextSourcePath = [...sourcePath, rawName];
    const isSession = directValue(key, 'dword', ['Is Session']) === '1';
    if (!isSession) {
      const nextFolders = name ? [...folders, name] : folders;
      for (const child of directElements(key, 'key')) {
        visit(child, nextFolders, nextSourcePath);
      }
      return;
    }

    const protocol = directValue(key, 'string', ['Protocol Name']);
    const normalizedProtocol = protocol.toLowerCase();
    const folder = normalizeImportFolder(folders.join('/'));
    const sourceKey = nextSourcePath.join('\0');
    const skip = (reason: string, fallback?: string) => {
      skippedSessions.push({
        id: `securecrt-skipped-${skippedSessions.length}`,
        name: name || fallback || 'Unnamed session',
        folder,
        reason,
      });
    };
    if (!name) {
      const fallback = cleanOptionValue(
        directValue(key, 'string', ['Hostname', 'Mac Com Port', 'Com Port', 'Port']),
      );
      skip('Session has no name', fallback);
      return;
    }
    if (normalizedProtocol === 'ssh2') {
      const host = cleanOptionValue(directValue(key, 'string', ['Hostname']));
      if (!host) {
        skip('SSH session has no hostname');
        return;
      }
      const username = cleanOptionValue(directValue(key, 'string', ['Username'])) || undefined;
      const rawPort = Number.parseInt(directValue(key, 'dword', ['[SSH2] Port']), 10);
      const port = rawPort >= 1 && rawPort <= 65_535 ? rawPort : 22;
      const authentications = new Set(
        directValue(key, 'string', ['SSH2 Authentications V2'])
          .toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      );
      const hasPassword =
        authentications.has('password') || authentications.has('keyboard-interactive');
      const authMode = !authentications.has('publickey') && hasPassword ? 'password' : 'key';
      const alias = uniqueImportAlias(name, host, aliases, 'securecrt-host');
      aliases.add(alias);
      const id = uniqueStableId(stableImportId('securecrt-session', sourceKey), sessionIds);
      sessionIds.add(id);
      sessions.push({
        id,
        kind: 'ssh',
        name,
        alias,
        host,
        port,
        username,
        folder,
        authMode,
      });
      return;
    }
    if (normalizedProtocol === 'serial') {
      const path = cleanSerialPath(
        directValue(key, 'string', ['Mac Com Port', 'Com Port', 'Port']),
      );
      if (!path) {
        skip('Serial session has no port');
        return;
      }
      const rawBaudRate = Number.parseInt(
        directValue(key, 'dword', ['Mac Baud Rate', 'Baud Rate']),
        10,
      );
      const baudRate =
        rawBaudRate >= 1 && rawBaudRate <= 12_000_000 ? rawBaudRate : 115_200;
      const dataBits = serialDataBits(
        directValue(key, 'dword', ['Mac Data Bits', 'Data Bits']),
      );
      const stopBits = serialStopBits(
        directValue(key, 'dword', ['Mac Stop Bits', 'Stop Bits']),
      );
      const parity = serialParity(
        directValue(key, 'dword', ['Mac Parity', 'Parity']),
      );
      const hardwareFlow =
        enabled(key, ['Mac CTS Flow', 'CTS Flow']) ||
        enabled(key, ['Mac DSR Flow', 'DSR Flow']) ||
        directValue(key, 'dword', ['Mac DTR Flow Control', 'DTR Flow Control']) === '2' ||
        directValue(key, 'dword', ['Mac RTS Flow Control', 'RTS Flow Control']) === '2';
      const softwareFlow = enabled(key, ['Mac XON Flow', 'XON Flow']);
      const profileId = uniqueStableId(
        stableImportId('securecrt-serial', sourceKey),
        profileIds,
      );
      profileIds.add(profileId);
      sessions.push({
        id: profileId,
        kind: 'serial',
        name,
        profileId,
        path,
        baudRate,
        dataBits,
        stopBits,
        parity,
        flowControl: hardwareFlow ? 'hardware' : softwareFlow ? 'software' : 'none',
        folder,
      });
      return;
    }
    skip(
      protocol
        ? `Protocol “${protocol}” is not supported`
        : 'Session does not specify a supported protocol',
    );
  };

  for (const key of directElements(sessionsRoot, 'key')) visit(key, [], []);
  if (sessions.length === 0) {
    throw new Error('No supported SSH or serial sessions were found in this SecureCRT file.');
  }
  return {
    sessions,
    ignoredCount: skippedSessions.length,
    skippedSessions,
  };
}

export function secureCrtConnections(
  sessions: readonly SecureCrtSession[],
): PortableConnections {
  return importedConnections(sessions as readonly ImportedSession[], 'SecureCRT');
}

function directElements(parent: Element, tagName: string): Element[] {
  const result: Element[] = [];
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 1 && (node as Element).tagName === tagName) {
      result.push(node as Element);
    }
  }
  return result;
}

function directValue(parent: Element, tagName: string, names: readonly string[]): string {
  for (const child of directElements(parent, tagName)) {
    if (names.includes(child.getAttribute('name') ?? '')) return child.textContent?.trim() ?? '';
  }
  return '';
}

function enabled(parent: Element, names: readonly string[]): boolean {
  return directValue(parent, 'dword', names) === '1';
}

function cleanOptionValue(value: string): string {
  const cleaned = stripControlCharacters(value).trim();
  return cleaned && !cleaned.includes('"') && cleaned.length <= 4096 ? cleaned : '';
}

function cleanSerialPath(value: string): string {
  const cleaned = stripControlCharacters(value).trim();
  return cleaned.length <= 4096 ? cleaned : '';
}

function serialDataBits(value: string): ImportedSerialSession['dataBits'] {
  const parsed = Number.parseInt(value, 10);
  return parsed === 5 || parsed === 6 || parsed === 7 || parsed === 8 ? parsed : 8;
}

function serialStopBits(value: string): ImportedSerialSession['stopBits'] {
  if (value === '1') return 1.5;
  if (value === '2') return 2;
  return 1;
}

function serialParity(value: string): ImportedSerialSession['parity'] {
  const parity = ['none', 'odd', 'even', 'mark', 'space'][Number.parseInt(value, 10)];
  return parity === 'odd' || parity === 'even' || parity === 'mark' || parity === 'space'
    ? parity
    : 'none';
}

function uniqueStableId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}
