import type { PortableConnections } from './data-transfer.js';
import {
  cleanImportName,
  importedConnections,
  normalizeImportFolder,
  stableImportId,
  stripControlCharacters,
  type ImportedCommandBar,
  type ImportedCommandButton,
  type ImportedSerialSession,
  type ImportedSession,
  type ImportedSessionParseResult,
  type ImportedSshStorage,
  type ImportedSshSession,
  type ImportedTelnetSession,
  type SkippedImportedCommand,
  uniqueImportAlias,
} from './session-import.js';

export const MAX_SECURECRT_IMPORT_BYTES = 20 * 1024 * 1024;

export type SecureCrtSession = ImportedSshSession | ImportedSerialSession | ImportedTelnetSession;
export interface SecureCrtParseResult
  extends ImportedSessionParseResult<SecureCrtSession> {}

/**
 * Parse SSH, Telnet and serial sessions, and the button bars, from a SecureCRT
 * Tools -> Export Settings XML file.
 */
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
  const commandBars = parseSecureCrtButtonBars(root);
  if (!sessionsRoot && commandBars.length === 0) {
    throw new Error('No SecureCRT Sessions or Button Bars section was found in this XML file.');
  }

  const sessions: SecureCrtSession[] = [];
  /** Session id -> the button bar SecureCRT shows for it. */
  const sessionBars = new Map<string, string>();
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
    if (folders.length === 0 && isSessionTemplate(rawName, protocol)) return;

    const buttonBar = secureCrtBarName(directValue(key, 'string', ['User Button Bar Name']));
    const add = (session: SecureCrtSession) => {
      sessions.push(session);
      if (buttonBar) sessionBars.set(session.id, buttonBar);
    };
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
      add({
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
    if (normalizedProtocol === 'telnet') {
      const host = cleanOptionValue(directValue(key, 'string', ['Hostname']));
      if (!host) {
        skip('Telnet session has no hostname');
        return;
      }
      const rawPort = Number.parseInt(directValue(key, 'dword', ['Port']), 10);
      const id = uniqueStableId(stableImportId('securecrt-telnet', sourceKey), sessionIds);
      sessionIds.add(id);
      add({
        id,
        kind: 'telnet',
        name,
        host,
        port: rawPort >= 1 && rawPort <= 65_535 ? rawPort : 23,
        folder,
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
      add({
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

  if (sessionsRoot) {
    for (const key of directElements(sessionsRoot, 'key')) visit(key, [], []);
  }
  if (sessions.length === 0 && commandBars.length === 0) {
    throw new Error(
      'No supported SSH, Telnet or serial sessions were found in this SecureCRT file.',
    );
  }
  // A session can name a bar that was deleted since; only link bars this file
  // carries. Default is the bar sessions show until another one is picked, so
  // it says nothing about the host and leaves the bar choice to the user.
  const barIds = new Map(
    commandBars.filter((bar) => !bar.isDefault).map((bar) => [bar.name, bar.id]),
  );
  for (const session of sessions) {
    const barId = barIds.get(sessionBars.get(session.id) ?? '');
    if (barId) session.commandButtonGroup = barId;
  }
  return {
    sessions,
    ignoredCount: skippedSessions.length,
    skippedSessions,
    ...(commandBars.length > 0 ? { commandBars } : {}),
  };
}

export function secureCrtConnections(
  sessions: readonly SecureCrtSession[],
  sshStorage: ImportedSshStorage = 'openssh',
): PortableConnections {
  return importedConnections(
    sessions as readonly ImportedSession[],
    'SecureCRT',
    sshStorage,
  );
}

const MAX_GROUP_NAME_LENGTH = 80;
const MAX_COMMAND_LENGTH = 100_000;
const OCTAL_DIGITS_RE = /^[0-7]{3}$/;
const DIGITS_RE = /^\d+$/;
/** Send String escapes that expand to values of the SecureCRT client machine. */
const CLIENT_VALUE_ESCAPES: Readonly<Record<string, string>> = {
  a: 'IPv6 address',
  c: 'computer name',
  i: 'IPv4 address',
  l: 'login name',
  m: 'MAC address',
  u: 'session username',
};

/**
 * SecureCRT's templates for new sessions: `Default` and `Default_<protocol>`,
 * such as Default_Serial. A session of the user's named Default_gw is not one.
 */
function isSessionTemplate(name: string, protocol: string): boolean {
  if (name === 'Default') return true;
  const suffix = /^Default_(.+)$/.exec(name)?.[1];
  return suffix !== undefined && comparableName(suffix) === comparableName(protocol);
}

function comparableName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A bar name as both the bar and the sessions naming it are read. */
function secureCrtBarName(value: string): string {
  return cleanImportName(value).slice(0, MAX_GROUP_NAME_LENGTH).trim();
}

/**
 * Button bars from the export's `ButtonBarV<n>` key: one `<array name="Bar">`
 * per bar and one `<string>ACTION,argument,label,…</string>` per button.
 */
export function parseSecureCrtButtonBars(root: Element): ImportedCommandBar[] {
  const section = directElements(root, 'key')
    .map((element) => ({
      element,
      version: /^ButtonBarV(\d+)$/.exec(element.getAttribute('name') ?? '')?.[1],
    }))
    .filter((entry) => entry.version !== undefined)
    .sort((left, right) => Number(right.version) - Number(left.version))[0]?.element;
  if (!section) return [];

  const bars: ImportedCommandBar[] = [];
  const ids = new Set<string>();
  for (const array of directElements(section, 'array')) {
    const name = secureCrtBarName(array.getAttribute('name') ?? '');
    if (!name) continue;
    const id = uniqueStableId(stableImportId('securecrt-bar', name), ids);
    ids.add(id);
    const bar: ImportedCommandBar = {
      id,
      name,
      ...(name === 'Default' ? { isDefault: true } : {}),
      buttons: [],
      skipped: [],
    };
    for (const element of directElements(array, 'string')) {
      const parsed = parseSecureCrtButton(element.textContent ?? '');
      if ('reason' in parsed) bar.skipped.push(parsed);
      else bar.buttons.push(parsed);
    }
    bars.push(bar);
  }
  return bars;
}

/**
 * One button: `ACTION,argument,label,,,<n>,<n>,` with an optional description
 * (SecureCRT 9.4+) before the trailing comma. Commas inside the argument are
 * not escaped, so the label is located from the right.
 */
export function parseSecureCrtButton(
  line: string,
): ImportedCommandButton | SkippedImportedCommand {
  const fields = line.split(',');
  if (fields.at(-1) === '') fields.pop();
  const action = fields[0]?.trim() ?? '';
  const numbersAt = [fields.length - 2, fields.length - 3].find(
    (index) =>
      index >= 5 && DIGITS_RE.test(fields[index] ?? '') && DIGITS_RE.test(fields[index + 1] ?? ''),
  );
  if (numbersAt === undefined) {
    return { label: action || 'Unnamed button', reason: 'Unrecognized button format' };
  }
  const labelAt = numbersAt - 3;
  const label = cleanImportName(fields[labelAt] ?? '');
  if (action !== 'SEND') {
    return {
      label: label || action,
      reason: action.startsWith('MENU_')
        ? `Menu function ${action} has no Muxus equivalent`
        : `“${action}” buttons are not supported`,
    };
  }
  const converted = secureCrtSendString(fields.slice(1, labelAt).join(','));
  if (labelAt > 2) {
    converted.warnings.push('The command contains commas; check that the label was read correctly');
  }
  if (!converted.command && !converted.sendEnter) {
    return { label: label || 'Unnamed button', reason: 'Button sends nothing' };
  }
  if (converted.command.length > MAX_COMMAND_LENGTH) {
    return { label: label || 'Unnamed button', reason: 'Command is longer than 100,000 characters' };
  }
  return { label, ...converted };
}

/**
 * Turn a SecureCRT Send String into the literal text a Muxus button types.
 * CR, LF and CRLF all become one line break (sent as Enter); a final one
 * becomes "press Enter". Pauses, clipboard and client values cannot be
 * reproduced and are dropped with a warning.
 */
export function secureCrtSendString(text: string): {
  command: string;
  sendEnter: boolean;
  warnings: string[];
} {
  const warnings = new Set<string>();
  let output = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character !== '\\') {
      output += character;
      continue;
    }
    const escape = text[++index];
    if (escape === undefined) break;
    if (escape === 'r') output += '\r';
    else if (escape === 'n') output += '\n';
    else if (escape === 't') output += '\t';
    else if (escape === 'b') output += '\b';
    else if (escape === 'e') output += '\u001b';
    else if (escape === '\\') output += '\\';
    else if (escape === 'p') warnings.add('One-second pauses (\\p) were removed');
    else if (escape === 'v') warnings.add('Clipboard paste (\\v) was removed');
    else if (CLIENT_VALUE_ESCAPES[escape]) {
      warnings.add(`The ${CLIENT_VALUE_ESCAPES[escape]} placeholder (\\${escape}) was removed`);
    } else if (OCTAL_DIGITS_RE.test(text.slice(index, index + 3))) {
      output += String.fromCharCode(Number.parseInt(text.slice(index, index + 3), 8));
      index += 2;
    } else {
      // SecureCRT drops a backslash followed by anything it does not know.
      warnings.add(`Unknown escape \\${escape} was removed`);
    }
  }
  const command = output.replace(/\r\n|\r/g, '\n');
  const sendEnter = command.endsWith('\n');
  return {
    command: sendEnter ? command.slice(0, -1) : command,
    sendEnter,
    warnings: [...warnings],
  };
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
