/**
 * gNMI path strings, as gnmic and the gNMI path-strings convention write
 * them: `/interface[name=ethernet-1/1]/statistics/in-octets`, optionally
 * preceded by an origin (`openconfig:/interfaces`). Element names keep any
 * YANG module prefix (`srl_nokia-interfaces:interface`); a colon only marks
 * an origin when a slash follows it directly.
 *
 * Key values may contain `/`; `]` and `\` inside a value are escaped with a
 * backslash.
 */

export interface GnmiPathElem {
  name: string;
  /** Key leaf name → value, in the order they were written. */
  keys?: Record<string, string>;
}

export interface GnmiPath {
  origin?: string;
  elems: GnmiPathElem[];
}

export class GnmiPathError extends Error {
  constructor(
    message: string,
    /** Offset into the string where the problem was found. */
    readonly position: number,
  ) {
    super(message);
    this.name = 'GnmiPathError';
  }
}

const ORIGIN = /^([A-Za-z0-9_.-]+):\//;

export function parseGnmiPath(text: string): GnmiPath {
  let source = text.trim();
  let offset = text.length - text.trimStart().length;
  let origin: string | undefined;
  const originMatch = ORIGIN.exec(source);
  if (originMatch) {
    origin = originMatch[1];
    source = source.slice(originMatch[1]!.length + 1);
    offset += originMatch[1]!.length + 1;
  }
  const elems: GnmiPathElem[] = [];
  let i = 0;
  if (source[i] === '/') i++;
  while (i < source.length) {
    let name = '';
    while (i < source.length && source[i] !== '/' && source[i] !== '[') {
      if (source[i] === '\\' && i + 1 < source.length) {
        name += source[i + 1];
        i += 2;
        continue;
      }
      if (source[i] === ']') throw new GnmiPathError('Unexpected “]”.', offset + i);
      name += source[i];
      i++;
    }
    if (!name) {
      if (source[i] === '[') throw new GnmiPathError('A key needs an element before it.', offset + i);
      // Tolerate a trailing slash; anything else is an empty element.
      if (i === source.length - 1 && source[i] === '/') break;
      if (i >= source.length) break;
      throw new GnmiPathError('Empty path element.', offset + i);
    }
    let keys: Record<string, string> | undefined;
    while (source[i] === '[') {
      const start = i;
      i++;
      let key = '';
      while (i < source.length && source[i] !== '=' && source[i] !== ']') {
        key += source[i];
        i++;
      }
      if (source[i] !== '=') throw new GnmiPathError('A key needs “name=value”.', offset + start);
      i++;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const char = source[i]!;
        if (char === '\\' && i + 1 < source.length) {
          value += source[i + 1];
          i += 2;
          continue;
        }
        if (char === ']') {
          closed = true;
          i++;
          break;
        }
        value += char;
        i++;
      }
      if (!closed) throw new GnmiPathError('Missing “]”.', offset + start);
      key = key.trim();
      if (!key) throw new GnmiPathError('A key needs a name.', offset + start);
      keys ??= {};
      keys[key] = value;
    }
    elems.push(keys ? { name, keys } : { name });
    if (i < source.length) {
      if (source[i] !== '/') throw new GnmiPathError(`Unexpected “${source[i]}”.`, offset + i);
      i++;
    }
  }
  return origin ? { origin, elems } : { elems };
}

/** Parse, or undefined when the text is not a valid path. */
export function tryParseGnmiPath(text: string): GnmiPath | undefined {
  try {
    return parseGnmiPath(text);
  } catch {
    return undefined;
  }
}

function escapeKeyValue(value: string): string {
  return value.replace(/[\\\]]/g, (char) => `\\${char}`);
}

function escapeName(name: string): string {
  return name.replace(/[\\/[\]]/g, (char) => `\\${char}`);
}

export function formatGnmiElem(elem: GnmiPathElem): string {
  let text = escapeName(elem.name);
  for (const [key, value] of Object.entries(elem.keys ?? {})) {
    text += `[${key}=${escapeKeyValue(value)}]`;
  }
  return text;
}

export function formatGnmiPath(path: GnmiPath): string {
  const body = `/${path.elems.map(formatGnmiElem).join('/')}`;
  return path.origin ? `${path.origin}:${body}` : body;
}

/** Normalize how a path is written, keeping the text when it does not parse. */
export function normalizeGnmiPath(text: string): string {
  const parsed = tryParseGnmiPath(text);
  return parsed ? formatGnmiPath(parsed) : text.trim();
}

/** `prefix` + `path`, as a device resolves an update path against a notification prefix. */
export function joinGnmiPaths(prefix: GnmiPath | undefined, path: GnmiPath): GnmiPath {
  if (!prefix) return path;
  return {
    ...(prefix.origin || path.origin ? { origin: prefix.origin || path.origin } : {}),
    elems: [...prefix.elems, ...path.elems],
  };
}

/** `srl_nokia-interfaces:interface` → `interface`. */
export function stripModulePrefix(name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/**
 * The path without module prefixes, so the same node compares equal whether
 * a device qualified its first element or not.
 */
export function gnmiPathIdentity(path: GnmiPath): string {
  return formatGnmiPath({
    elems: path.elems.map((elem) => ({ ...elem, name: stripModulePrefix(elem.name) })),
  });
}

/** The schema node a data path addresses: the path with its keys dropped. */
export function gnmiSchemaPath(path: GnmiPath): string {
  return `/${path.elems.map((elem) => stripModulePrefix(elem.name)).join('/')}`;
}

/** Whether `path` lies at or below `ancestor` (keys in `ancestor` must match; absent keys match any). */
export function gnmiPathStartsWith(path: GnmiPath, ancestor: GnmiPath): boolean {
  if (ancestor.elems.length > path.elems.length) return false;
  return ancestor.elems.every((elem, index) => {
    const candidate = path.elems[index]!;
    if (stripModulePrefix(candidate.name) !== stripModulePrefix(elem.name)) return false;
    for (const [key, value] of Object.entries(elem.keys ?? {})) {
      if (value === '*') continue;
      if (candidate.keys?.[key] !== value) return false;
    }
    return true;
  });
}

/**
 * A device's "unknown element 'x'. Options are [a, b, c]" (SR Linux words
 * it this way) split into the rejected element and the alternatives.
 */
export function splitPathOptions(message: string): { bad?: string; options: string[] } {
  const bad = /unknown element '([^']+)'/i.exec(message)?.[1];
  const list = /options are \[([^\]]*)\]/i.exec(message)?.[1];
  const options = list
    ? list
        .split(',')
        .map((option) => option.trim())
        .filter(Boolean)
    : [];
  return { ...(bad ? { bad } : {}), options };
}
