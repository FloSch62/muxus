import type { HostDraft } from './draft.js';

/** More copies than this in one save is almost certainly a typo. */
export const MAX_RANGE_HOSTS = 250;

/** A numeric range written into a host name, e.g. `web[2-10]` or `db[01-12]`. */
export interface NameRange {
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  /** Zero-padded width when the start was written with a leading zero. */
  width: number;
}

const RANGE_RE = /\[(\d+)\s*(?:-|\.\.|:)\s*(\d+)\]/;
const RANGE_RE_ALL = new RegExp(RANGE_RE.source, 'g');
/** Something that looks like a range was meant: a bracket around a digit. */
const RANGE_ATTEMPT_RE = /\[\s*\d|\d\s*\]/;

export function parseNameRange(text: string): NameRange | undefined {
  const match = RANGE_RE.exec(text);
  if (!match) return undefined;
  const [whole, from, to] = match as unknown as [string, string, string];
  return {
    prefix: text.slice(0, match.index),
    suffix: text.slice(match.index + whole.length),
    start: Number(from),
    end: Number(to),
    width: from.length > 1 && from.startsWith('0') ? from.length : 0,
  };
}

/** Values in the range; only meaningful once it is known to count up. */
function rangeSize(range: NameRange): number {
  return range.end - range.start + 1;
}

/** Above 2^53 `n++` can stop changing `n`, and digits collapse together. */
function exact(range: NameRange): boolean {
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end);
}

export function expandNameRange(range: NameRange): string[] {
  const names: string[] = [];
  for (let n = range.start; n <= range.end; n++) {
    names.push(`${range.prefix}${String(n).padStart(range.width, '0')}${range.suffix}`);
  }
  return names;
}

/** The suggestion shown in the duplicate dialog: `app1` → `app[2-10]`, `db01` → `db[02-10]`. */
export function rangeExample(sourceName: string | undefined): string {
  const match = /^(.*?)(\d+)$/.exec(sourceName ?? '');
  if (!match) return `${sourceName || 'web'}[1-10]`;
  const [, base, digits] = match as unknown as [string, string, string];
  const number = Number(digits);
  if (!Number.isSafeInteger(number + 9)) return `${base}[1-10]`;
  const width = digits.startsWith('0') ? digits.length : 0;
  const pad = (n: number) => String(n).padStart(width, '0');
  return `${base}[${pad(number + 1)}-${pad(number + 9)}]`;
}

export interface DraftRange {
  /** One complete draft per host to create, in order. */
  drafts: HostDraft[];
  problem: string | null;
}

/**
 * Expand a draft whose name holds a `[from-to]` range into one draft per host.
 *
 * The HostName follows along: its own range expands in step with the name's;
 * otherwise, where it contains the duplicated host's name as a whole word
 * (`app1` in `app1.corp.local`), that part becomes each new name. Anything
 * else — an IP address, say — is copied as it is. A display name needs a
 * range of its own, so the hosts can be told apart.
 *
 * Returns undefined when nothing asks for a range, so a plain save happens.
 */
export function expandDraftRange(
  draft: HostDraft,
  sourceName: string | undefined,
  existingNames: ReadonlySet<string> = new Set(),
): DraftRange | undefined {
  const fail = (problem: string): DraftRange => ({ drafts: [], problem });
  const text = draft.aliasText.trim();
  const hostname = draft.hostname.trim();
  const range = parseNameRange(text);

  if (!range) {
    // Brackets that do not parse would otherwise be saved literally.
    if (RANGE_ATTEMPT_RE.test(text)) return fail('Write the range as name[from-to], e.g. web[2-10].');
    if (parseNameRange(hostname)) return fail('A HostName range needs a range in the name too, e.g. web[2-10].');
    return undefined;
  }

  if (countRanges(text) > 1) return fail('Use one [from-to] range in the name.');
  if (RANGE_ATTEMPT_RE.test(text.replace(RANGE_RE, ''))) {
    return fail('Write the range as name[from-to], e.g. web[2-10].');
  }
  if (draft.storage === 'openssh' && /\s/.test(text)) {
    return fail('A range needs a single alias — remove the extra aliases.');
  }
  if (!exact(range)) return fail('The range numbers are too large.');
  if (range.end < range.start) return fail('The range must count up, e.g. [2-10].');
  const count = rangeSize(range);
  if (count > MAX_RANGE_HOSTS) return fail(`A range can create at most ${MAX_RANGE_HOSTS} hosts.`);

  const names = expandNameRange(range);
  const hostnames = rangeValues('HostName', hostname, names.length);
  if (typeof hostnames === 'string') return fail(hostnames);
  const displayNames = rangeValues('display name', draft.displayName.trim(), names.length);
  if (typeof displayNames === 'string') return fail(displayNames);
  if (!displayNames && draft.displayName.trim()) {
    return fail('Give the display name a range too, e.g. Web [1-5], or leave it empty.');
  }

  const taken = names.find((name) => existingNames.has(name.toLowerCase()));
  if (taken) return fail(`"${taken}" already exists — pick a range without it.`);

  const followed = hostnames ?? followSourceName(hostname, sourceName, names);
  return {
    drafts: names.map((name, i) => ({
      ...draft,
      aliasText: name,
      hostname: followed[i] ?? '',
      displayName: displayNames?.[i] ?? '',
    })),
    problem: null,
  };
}

function countRanges(text: string): number {
  return (text.match(RANGE_RE_ALL) ?? []).length;
}

/**
 * A field's own range, expanded in step with the name: the values, a problem,
 * or undefined when the field has no range. The size is compared before
 * anything is built, so a huge range costs nothing.
 */
function rangeValues(label: string, text: string, count: number): string[] | string | undefined {
  const own = parseNameRange(text);
  if (!own) return undefined;
  if (countRanges(text) > 1) return `Use one [from-to] range in the ${label}.`;
  if (!exact(own)) return `The ${label} range numbers are too large.`;
  const size = own.end >= own.start ? rangeSize(own) : 0;
  if (size !== count) return `The ${label} range has ${size} values but the name range has ${count}.`;
  return expandNameRange(own);
}

function followSourceName(hostname: string, sourceName: string | undefined, names: string[]): string[] {
  if (sourceName) {
    const word = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(sourceName)}(?![A-Za-z0-9])`, 'i');
    if (word.test(hostname)) return names.map((name) => hostname.replace(word, name));
  }
  return names.map(() => hostname);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One line for the name field: what the save will create. */
export function describeDraftRange(drafts: HostDraft[]): string {
  const first = drafts[0];
  const last = drafts[drafts.length - 1];
  if (!first || !last) return '';
  const names = drafts.length === 1 ? first.aliasText : `${first.aliasText} … ${last.aliasText}`;
  let target = '';
  if (first.hostname) {
    target =
      first.hostname === last.hostname
        ? ` — all connect to ${first.hostname}`
        : ` — HostName ${first.hostname} … ${last.hostname}`;
  }
  return `Creates ${drafts.length} host${drafts.length === 1 ? '' : 's'}: ${names}${target}`;
}
