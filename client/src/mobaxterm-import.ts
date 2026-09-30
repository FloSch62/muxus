import type { PortableConnections } from './data-transfer.js';
import {
  cleanImportName,
  importedConnections,
  normalizeImportFolder,
  stableImportId,
  type ImportedDesktopSession,
  type ImportedJumpHost,
  type SkippedImportedSession,
  type ImportedSessionParseResult,
  type ImportedSshStorage,
  type ImportedSshSession,
  uniqueImportAlias,
} from './session-import.js';

const BOOKMARK_SECTION_RE = /^Bookmarks(?:_\d+)?$/i;
const SESSION_HEADER_RE = /^#\d+#(\d+)(?=%)/;
/** Separates the hops of a multi-hop SSH gateway inside each gateway field. */
const HOP_SEPARATOR = '__PIPE__';
/** Characters MobaXterm spells out because they delimit its own format. */
const ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['__PTVIRG__', ';'],
  ['__PIPE__', '|'],
  ['__EQUAL__', '='],
  ['__DIEZE__', '#'],
];
const UNSUPPORTED_REASON = 'Only SSH, RDP and VNC sessions can be imported';
export const MAX_MOBAXTERM_IMPORT_BYTES = 10 * 1024 * 1024;

/** Field positions of the SSH gateway (jump host) settings of one protocol. */
interface GatewayFields {
  host: number;
  port: number;
  username: number;
  identityFile: number;
}

interface ProtocolLayout {
  kind: 'ssh' | 'rdp' | 'vnc';
  label: string;
  defaultPort: number;
  username?: number;
  identityFile?: number;
  /** "Execute command", and whether a shell stays open once it ends. */
  command?: { value: number; keepShell: number };
  gateway: GatewayFields;
}

/**
 * Session fields per MobaXterm protocol. Index 1 is always the host and
 * index 2 the port; every protocol can go through an SSH gateway.
 */
const PROTOCOLS: ReadonlyMap<number, ProtocolLayout> = new Map([
  [
    0,
    {
      kind: 'ssh',
      label: 'SSH',
      defaultPort: 22,
      username: 3,
      identityFile: 14,
      command: { value: 7, keepShell: 11 },
      gateway: { host: 8, port: 9, username: 10, identityFile: 15 },
    },
  ],
  [
    4,
    {
      kind: 'rdp',
      label: 'RDP',
      defaultPort: 3389,
      username: 3,
      gateway: { host: 13, port: 14, username: 15, identityFile: 18 },
    },
  ],
  [
    5,
    {
      kind: 'vnc',
      label: 'VNC',
      defaultPort: 5900,
      gateway: { host: 5, port: 6, username: 7, identityFile: 8 },
    },
  ],
]);

/**
 * MobaXterm stores paths relative to placeholders so a portable copy keeps
 * working. `_CurrentDrive_` is the drive MobaXterm runs from — C: for an
 * installed copy.
 */
const PATH_PLACEHOLDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^_ProfileDir_(?=\\|$)/i, '~'],
  [/^_MyDocuments_(?=\\|$)/i, '~/Documents'],
  [/^_CurrentDrive_:/i, 'C:'],
];

export type MobaXtermSession = ImportedSshSession | ImportedDesktopSession;

export interface MobaXtermParseResult
  extends ImportedSessionParseResult<MobaXtermSession> {}

/**
 * Parse SSH, RDP and VNC bookmarks from MobaXterm.ini or an .mxtsessions export.
 *
 * Session values use `#icon#protocol%host%port%...#terminal settings#...`;
 * SSH is protocol 0, RDP 4 and VNC 5. Private keys and SSH gateways are kept
 * as paths and hops, and an SSH session's command as its startup command. This intentionally reads bookmark structure only—no P/C
 * secret stores.
 */
export function parseMobaXtermSessions(text: string): MobaXtermParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_MOBAXTERM_IMPORT_BYTES) {
    throw new Error('That MobaXterm file is larger than 10 MB.');
  }

  const sessions: MobaXtermSession[] = [];
  const aliases = new Set<string>();
  const desktopIds = new Set<string>();
  const jumpHost = jumpHostRegistry(aliases);
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

    const headerMatch = SESSION_HEADER_RE.exec(value);
    if (!headerMatch) continue;
    const layout = PROTOCOLS.get(Number.parseInt(headerMatch[1] ?? '', 10));
    if (!layout) {
      skip(lineIndex, name, undefined, UNSUPPORTED_REASON);
      continue;
    }

    // Only the connection block: terminal and display settings follow the next '#'.
    const fields = (value.slice(headerMatch[0].length).split('#', 1)[0] ?? '').split('%');
    const host = fields[1]?.trim();
    if (!name) {
      skip(lineIndex, name, host, `${layout.label} session has no name`);
      continue;
    }
    if (!host) {
      skip(lineIndex, name, undefined, `${layout.label} session has no hostname`);
      continue;
    }
    const port = parsePort(fields[2], layout.defaultPort);
    const username =
      layout.username === undefined ? undefined : fields[layout.username]?.trim() || undefined;
    const gateway = parseGateway(fields, layout.gateway, jumpHost);

    if (layout.kind === 'ssh') {
      const identityFile =
        layout.identityFile === undefined ? undefined : mobaXtermPath(fields[layout.identityFile]);
      const remoteCommand = layout.command && startupCommand(fields, layout.command);
      const alias = uniqueImportAlias(name, host, aliases, 'mobaxterm-host');
      aliases.add(alias);
      sessions.push({
        id: stableImportId('mobaxterm-session', `${currentFolder ?? ''}\0${alias}`),
        kind: 'ssh',
        name,
        alias,
        host,
        port,
        username,
        folder: currentFolder,
        authMode: (identityFile || fields[4]?.trim() === '3') ? 'key' : 'password',
        ...(identityFile ? { identityFile } : {}),
        ...(remoteCommand ? { remoteCommand } : {}),
        ...(gateway ? { jumpHost: gateway } : {}),
      });
      continue;
    }

    const key = `${currentFolder ?? ''}\0${name}`;
    let idKey = key;
    for (let suffix = 2; desktopIds.has(idKey); suffix++) idKey = `${key}\0${suffix}`;
    desktopIds.add(idKey);
    sessions.push({
      id: stableImportId(`mobaxterm-${layout.kind}`, idKey),
      kind: layout.kind,
      name,
      host,
      port,
      username,
      folder: currentFolder,
      ...(gateway ? { jumpHost: gateway } : {}),
    });
  }

  if (sessions.length === 0) {
    throw new Error('No SSH, RDP or VNC sessions were found in this MobaXterm file.');
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
  sshStorage: ImportedSshStorage = 'openssh',
): PortableConnections {
  return importedConnections(sessions, 'MobaXterm', sshStorage);
}

/** Resolve a MobaXterm key path to one Muxus and OpenSSH can read. */
export function mobaXtermPath(value: string | undefined): string | undefined {
  const path = value?.trim();
  if (!path) return undefined;
  const expanded = PATH_PLACEHOLDERS.reduce(
    (current, [placeholder, replacement]) => current.replace(placeholder, replacement),
    path,
  );
  return expanded.replace(/\\/g, '/');
}

/**
 * The session's "Execute command", run as the session's startup command.
 * MobaXterm ends the session with the command unless "Do not exit after
 * command ends" is set; then the login shell takes over afterwards.
 */
function startupCommand(
  fields: readonly string[],
  layout: NonNullable<ProtocolLayout['command']>,
): string | undefined {
  const command = ESCAPES.reduce(
    (current, [token, character]) => current.replaceAll(token, character),
    fields[layout.value] ?? '',
  )
    .trim()
    .replace(/[\s;]+$/, '');
  if (!command) return undefined;
  return fields[layout.keepShell]?.trim() === '-1' ? `${command}; exec "$SHELL" -l` : command;
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value?.trim() ?? '', 10);
  return port >= 1 && port <= 65_535 ? port : fallback;
}

/** The last hop of a session's SSH gateway chain; earlier hops hang off `via`. */
function parseGateway(
  fields: readonly string[],
  layout: GatewayFields,
  jumpHost: (hop: Omit<ImportedJumpHost, 'id' | 'alias' | 'name'>) => ImportedJumpHost,
): ImportedJumpHost | undefined {
  const column = (index: number) => (fields[index] ?? '').split(HOP_SEPARATOR);
  const ports = column(layout.port);
  const usernames = column(layout.username);
  const identityFiles = column(layout.identityFile);
  let last: ImportedJumpHost | undefined;
  for (const [index, rawHost] of column(layout.host).entries()) {
    const host = rawHost.trim();
    if (!host) continue;
    const username = usernames[index]?.trim();
    const identityFile = mobaXtermPath(identityFiles[index]);
    last = jumpHost({
      host,
      port: parsePort(ports[index], 22),
      ...(username ? { username } : {}),
      ...(identityFile ? { identityFile } : {}),
      ...(last ? { via: last } : {}),
    });
  }
  return last;
}

/**
 * One shared entry per distinct hop (including the hops before it), with a
 * readable name and an ssh_config alias that cannot collide with sessions.
 */
function jumpHostRegistry(aliases: Set<string>) {
  const hops = new Map<string, ImportedJumpHost>();
  const names = new Set<string>();
  return (hop: Omit<ImportedJumpHost, 'id' | 'alias' | 'name'>): ImportedJumpHost => {
    const id = stableImportId(
      'mobaxterm-jump',
      [hop.via?.id ?? '', hop.host, hop.port, hop.username ?? '', hop.identityFile ?? ''].join('\0'),
    );
    const existing = hops.get(id);
    if (existing) return existing;

    const address = `${hop.username ? `${hop.username}@` : ''}${hop.host}${hop.port === 22 ? '' : `:${hop.port}`}`;
    const baseName = hop.via ? `${address} via ${hop.via.name}` : address;
    let name = baseName;
    for (let suffix = 2; names.has(name); suffix++) name = `${baseName} (${suffix})`;
    names.add(name);
    // '@' and ':' would make ProxyJump read the alias as user@host:port.
    const alias = uniqueImportAlias(`jump-${address.replace(/[@:[\]]+/g, '-')}`, hop.host, aliases, 'jump-host');
    aliases.add(alias);

    const jump: ImportedJumpHost = { ...hop, id, alias, name };
    hops.set(id, jump);
    return jump;
  };
}
