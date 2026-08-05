import type { IDisposable, ILink, Terminal } from '@xterm/xterm';

const MAX_LOGICAL_LINE_LENGTH = 4_096;
const SHELL_TOKEN_BOUNDARY = /\s/;
const WRAPPER_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
const TRAILING_PUNCTUATION = new Set([',', ';', '!', '?']);
const UNSAFE_PATH_CHARACTERS = new Set(['*', '?', '[', ']', '{', '}', '<', '>', '|']);
// OCI image names overlap heavily with relative paths. Requiring a tag or
// digest keeps ordinary paths clickable while excluding the form users most
// commonly see in containerlab and Compose files.
const CONTAINER_IMAGE_REFERENCE =
  /^(?:(?:localhost|[a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::\d+)?\/)?(?:[a-z\d._-]+\/)+[a-z\d._-]+(?::[a-z\d_][a-z\d._-]{0,127}|@sha256:[a-f\d]{32,})$/i;
const CONVENTIONAL_FILENAMES = new Set([
  'brewfile',
  'cmakelists.txt',
  'compose.yaml',
  'compose.yml',
  'containerfile',
  'dockerfile',
  'gemfile',
  'justfile',
  'license',
  'makefile',
  'procfile',
  'rakefile',
  'readme',
  'vagrantfile',
]);

export interface TerminalFileLinkCandidate {
  /** Decoded path passed to the remote-path resolver. */
  path: string;
  /** UTF-16 offsets into the logical terminal line. */
  start: number;
  end: number;
}

function escapedAt(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}

function decodeShellEscapes(value: string): string {
  return value.replace(/\\(.)/gs, '$1');
}

function containsUnsafePathCharacter(value: string): boolean {
  for (const character of value) {
    if (UNSAFE_PATH_CHARACTERS.has(character)) return true;
  }
  return false;
}

function safePathValue(value: string): boolean {
  if (
    !value ||
    value.length > 4_096 ||
    value === '.' ||
    value === '..' ||
    value === '/' ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n') ||
    containsUnsafePathCharacter(value) ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(value)
  ) {
    return false;
  }
  return true;
}

function looksLikeContainerImageReference(value: string): boolean {
  if (CONTAINER_IMAGE_REFERENCE.test(value)) return true;

  // A registry-qualified image is still an image when the implicit `latest`
  // tag is omitted. Restrict this form to an unmistakable registry host so a
  // normal `directory/file` path remains clickable.
  const slash = value.indexOf('/');
  if (slash <= 0) return false;
  const registry = value.slice(0, slash).toLocaleLowerCase();
  const registryParts = registry.match(/^([a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::\d+)?$/i);
  if (
    !registryParts?.[1] ||
    (registryParts[1] !== 'localhost' &&
      !registryParts[1].includes('.') &&
      !/:\d+$/.test(registry))
  ) {
    return false;
  }
  return /^(?:[a-z\d._-]+\/)*[a-z\d._-]+$/i.test(value.slice(slash + 1));
}

function looksLikePath(value: string): boolean {
  if (
    !safePathValue(value) ||
    looksLikeContainerImageReference(value) ||
    /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/i.test(value)
  ) {
    return false;
  }
  if (/^(?:\/|\.\.?\/|~\/)/.test(value) || value.includes('/')) return true;
  const lower = value.toLocaleLowerCase();
  if (CONVENTIONAL_FILENAMES.has(lower)) return true;
  if (value.startsWith('.') && value.length > 1) return true;
  return /\.[a-z\d][a-z\d+_-]{0,15}$/i.test(value);
}

function candidateFromRange(
  line: string,
  initialStart: number,
  initialEnd: number,
): TerminalFileLinkCandidate | undefined {
  let start = initialStart;
  let end = initialEnd;
  const closingWrappers: string[] = [];
  while (start < end && WRAPPER_PAIRS[line[start]!]) {
    closingWrappers.push(WRAPPER_PAIRS[line[start]!]!);
    start++;
  }
  while (end > start && TRAILING_PUNCTUATION.has(line[end - 1]!)) end--;
  while (closingWrappers.length > 0 && line[end - 1] === closingWrappers.pop()) end--;
  if (start >= end) return undefined;

  let displayed = line.slice(start, end);
  if (looksLikeContainerImageReference(decodeShellEscapes(displayed))) return undefined;
  const compilerLocation = displayed.match(/^(.+?):\d+(?::\d+)?(?::.*)?$/);
  if (compilerLocation?.[1]) {
    end = start + compilerLocation[1].length;
    displayed = compilerLocation[1];
  } else {
    const parenthesizedLocation = displayed.match(/^(.+?)\(\d+(?:,\d+)?\)$/);
    if (parenthesizedLocation?.[1]) {
      end = start + parenthesizedLocation[1].length;
      displayed = parenthesizedLocation[1];
    } else if (displayed.endsWith(':')) {
      end--;
      displayed = displayed.slice(0, -1);
    }
  }

  const path = decodeShellEscapes(displayed);
  return looksLikePath(path) ? { path, start, end } : undefined;
}

/**
 * Recognize the date/time fields in GNU/BSD `ls -l` output and treat what
 * follows as authoritative. This keeps extensionless files clickable without
 * mistaking values such as the `3.8K` size column for filenames; finding the
 * date also tolerates SELinux contexts and device major/minor columns.
 */
function longListingFileCandidate(line: string): TerminalFileLinkCandidate[] | undefined {
  const fields = Array.from(line.matchAll(/\S+/g));
  const mode = fields[0]?.[0];
  if (!mode || !/^[bcdlps-][rwxStTs-]{9}[.@+]?$/u.test(mode)) return undefined;
  if (!mode.startsWith('-')) return [];

  let filenameField = -1;
  for (let index = 2; index < fields.length - 1; index++) {
    const value = fields[index]![0];
    const previous = fields[index - 1]![0];
    const monthDayTime = /^\d{1,2}$/u.test(previous) && /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d{4})$/u.test(value);
    const isoTime = /^\d{4}-\d{2}-\d{2}$/u.test(previous) && /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(value);
    if (!monthDayTime && !isoTime) continue;
    filenameField = index + 1;
    if (/^[+-]\d{4}$/u.test(fields[filenameField]?.[0] ?? '')) filenameField++;
    break;
  }
  if (filenameField < 0 || filenameField >= fields.length) return [];

  let start = fields[filenameField]!.index!;
  let end = line.length;
  while (end > start && /\s/u.test(line[end - 1]!)) end--;
  const quote = line[start];
  if ((quote === "'" || quote === '"') && line[end - 1] === quote) {
    start++;
    end--;
  }
  if (start >= end) return [];

  const path = decodeShellEscapes(line.slice(start, end));
  return safePathValue(path) ? [{ path, start, end }] : [];
}

/** Find path-shaped tokens without turning ordinary terminal prose into links. */
export function terminalFileLinkCandidates(line: string): TerminalFileLinkCandidate[] {
  const longListing = longListingFileCandidate(line);
  if (longListing) return longListing;

  const candidates: TerminalFileLinkCandidate[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    while (cursor < line.length && SHELL_TOKEN_BOUNDARY.test(line[cursor]!)) cursor++;
    if (cursor >= line.length) break;

    const tokenStart = cursor;
    const quote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : undefined;
    if (quote) {
      cursor++;
      const contentStart = cursor;
      while (cursor < line.length && (line[cursor] !== quote || escapedAt(line, cursor))) cursor++;
      const candidate = candidateFromRange(line, contentStart, cursor);
      if (candidate) candidates.push(candidate);
      while (cursor < line.length && !SHELL_TOKEN_BOUNDARY.test(line[cursor]!)) cursor++;
      continue;
    }

    while (cursor < line.length) {
      if (SHELL_TOKEN_BOUNDARY.test(line[cursor]!) && !escapedAt(line, cursor)) break;
      cursor++;
    }
    const candidate = candidateFromRange(line, tokenStart, cursor);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function normalizeAbsolutePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** Resolve a path exactly as a POSIX shell would before handing it to SFTP. */
export function resolveRemoteFilePath(
  candidate: string,
  cwd?: string,
  home?: string,
): string | undefined {
  if (
    !candidate ||
    candidate.includes('\0') ||
    candidate.includes('\r') ||
    candidate.includes('\n')
  ) {
    return undefined;
  }
  if (candidate === '~' || candidate.startsWith('~/')) {
    if (!home?.startsWith('/')) return undefined;
    return normalizeAbsolutePath(`${home}/${candidate.slice(2)}`);
  }
  if (candidate.startsWith('~')) return undefined;
  if (candidate.startsWith('/')) return normalizeAbsolutePath(candidate);
  if (!cwd?.startsWith('/')) return undefined;
  return normalizeAbsolutePath(`${cwd}/${candidate}`);
}

function logicalLineAt(term: Terminal, bufferLineNumber: number): { text: string; startLine: number } | undefined {
  const buffer = term.buffer.active;
  let startLine = bufferLineNumber - 1;
  let line = buffer.getLine(startLine);
  if (!line) return undefined;

  let scanned = 0;
  while (line.isWrapped && scanned < MAX_LOGICAL_LINE_LENGTH) {
    const previous = buffer.getLine(startLine - 1);
    if (!previous) break;
    scanned += previous.translateToString(true).length;
    startLine--;
    line = previous;
  }

  const parts: string[] = [];
  let lineIndex = startLine;
  do {
    const content = line.translateToString(true);
    parts.push(content);
    scanned += content.length;
    lineIndex++;
    line = buffer.getLine(lineIndex)!;
  } while (line?.isWrapped && scanned < MAX_LOGICAL_LINE_LENGTH);

  return { text: parts.join(''), startLine };
}

/** Map a UTF-16 string offset back to xterm's zero-based buffer coordinates. */
function bufferPosition(
  term: Terminal,
  initialLine: number,
  stringOffset: number,
): [number, number] | undefined {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  let lineIndex = initialLine;
  let column = 0;
  let remaining = stringOffset;
  while (remaining > 0) {
    const line = buffer.getLine(lineIndex);
    if (!line) return undefined;
    for (let index = column; index < line.length; index++) {
      line.getCell(index, cell);
      const chars = cell.getChars();
      if (cell.getWidth()) {
        remaining -= chars.length || 1;
        // A wide character split at the right edge is represented by a blank
        // cell followed by its width-two cell on the wrapped line.
        if (index === line.length - 1 && chars === '') {
          const next = buffer.getLine(lineIndex + 1);
          if (next?.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) remaining++;
          }
        }
      }
      if (remaining < 0) return [lineIndex, index];
    }
    lineIndex++;
    column = 0;
  }
  return [lineIndex, column];
}

interface MappedTerminalFileLink {
  candidate: TerminalFileLinkCandidate;
  range: ILink['range'];
  text: string;
}

function mappedFileLinks(term: Terminal, bufferLineNumber: number): MappedTerminalFileLink[] {
  const logicalLine = logicalLineAt(term, bufferLineNumber);
  if (!logicalLine) return [];

  const links: MappedTerminalFileLink[] = [];
  for (const candidate of terminalFileLinkCandidates(logicalLine.text)) {
    const start = bufferPosition(term, logicalLine.startLine, candidate.start);
    const end = bufferPosition(term, logicalLine.startLine, candidate.end);
    if (!start || !end) continue;
    links.push({
      candidate,
      range: {
        start: { x: start[1] + 1, y: start[0] + 1 },
        end: { x: end[1], y: end[0] + 1 },
      },
      text: logicalLine.text.slice(candidate.start, candidate.end),
    });
  }
  return links;
}

/** Register ordinary hover-and-click file links while leaving other terminal text untouched. */
export function attachTerminalFileLinks(
  term: Terminal,
  onOpen: (candidate: string) => void | Promise<void>,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const links = mappedFileLinks(term, bufferLineNumber).map(({ candidate, range, text }) => {
        const link: ILink = {
          range,
          text,
          // xterm applies these only while the link is hovered and removes
          // them on leave, matching a normal browser-link affordance.
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            void onOpen(candidate.path);
          },
        };
        return link;
      });
      callback(links.length > 0 ? links : undefined);
    },
  });
}
