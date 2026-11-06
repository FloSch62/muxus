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

export function expandNameRange(range: NameRange): string[] {
  const names: string[] = [];
  for (let n = range.start; n <= range.end; n++) {
    names.push(`${range.prefix}${String(n).padStart(range.width, '0')}${range.suffix}`);
  }
  return names;
}

/** The suggestion shown in the duplicate dialog: `app1` → `app[2-10]`. */
export function rangeExample(sourceName: string | undefined): string {
  const match = /^(.*?)(\d+)$/.exec(sourceName ?? '');
  if (!match) return `${sourceName || 'web'}[1-10]`;
  const [, base, digits] = match as unknown as [string, string, string];
  return `${base}[${Number(digits) + 1}-10]`;
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
 * else — an IP address, say — is copied as it is.
 *
 * Returns undefined when the name has no range, so a plain save happens.
 */
export function expandDraftRange(
  draft: HostDraft,
  sourceName: string | undefined,
  existingNames: ReadonlySet<string> = new Set(),
): DraftRange | undefined {
  const text = draft.aliasText.trim();
  const range = parseNameRange(text);
  if (!range) return undefined;
  const fail = (problem: string): DraftRange => ({ drafts: [], problem });

  if ((text.match(RANGE_RE_ALL) ?? []).length > 1) return fail('Use one [from-to] range in the name.');
  if (draft.storage === 'openssh' && /\s/.test(text)) {
    return fail('A range needs a single alias — remove the extra aliases.');
  }
  if (range.end < range.start) return fail('The range must count up, e.g. [2-10].');
  const count = range.end - range.start + 1;
  if (count > MAX_RANGE_HOSTS) return fail(`A range can create at most ${MAX_RANGE_HOSTS} hosts.`);

  const names = expandNameRange(range);
  const hostnames = rangeHostnames(draft.hostname.trim(), sourceName, names);
  if (typeof hostnames === 'string') return fail(hostnames);

  const taken = names.find((name) => existingNames.has(name.toLowerCase()));
  if (taken) return fail(`"${taken}" already exists — pick a range without it.`);

  return {
    drafts: names.map((name, i) => ({ ...draft, aliasText: name, hostname: hostnames[i] ?? '' })),
    problem: null,
  };
}

function rangeHostnames(
  hostname: string,
  sourceName: string | undefined,
  names: string[],
): string[] | string {
  const own = parseNameRange(hostname);
  if (own) {
    const expanded = own.end >= own.start ? expandNameRange(own) : [];
    if (expanded.length !== names.length) {
      return `The HostName range has ${expanded.length} values but the name range has ${names.length}.`;
    }
    return expanded;
  }
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
