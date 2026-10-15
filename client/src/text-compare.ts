/**
 * Text preparation and unified-diff export for the compare dialog. Monaco
 * draws the diff; the export is computed here so it needs no editor.
 */

export interface CompareOptions {
  /** Drop a timestamp at the start of each line, such as `[2026-10-14T09:15:00.123Z]` or `*Oct 14 09:15:00.123:`. */
  ignoreTimestamps: boolean;
  /** Collapse runs of spaces and tabs after the indentation and drop trailing ones. */
  ignoreWhitespace: boolean;
}

const TIME = String.raw`\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?`;
const STAMP = [
  String.raw`\d{4}[-/]\d{2}[-/]\d{2}[T ]${TIME}(?:Z|[+-]\d{2}:?\d{2})?`,
  String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} +(?:\d{4} +)?${TIME}`,
  TIME,
].join('|');
// A colon and a hex group after the time make it an address, such as `00:11:22:33:44:55` or `10:20:30::1`.
const ADDRESS_GROUP = String.raw`:[\dA-Fa-f]{1,4}\b|::`;
// Cisco marks an unsynchronized clock with `*` or `.` and ends the stamp with a colon.
const LEADING_TIMESTAMP = new RegExp(String.raw`^[*.]?(?:\[(?:${STAMP})\]|(?:${STAMP})(?!${ADDRESS_GROUP})):?[ \t]*`);

/** The text as both views and the export compare it: LF line endings, no trailing newline. */
export function prepareCompareText(text: string, options: CompareOptions): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => {
      const stamped = options.ignoreTimestamps ? line.replace(LEADING_TIMESTAMP, '') : line;
      return options.ignoreWhitespace ? stamped.replace(/(?<=\S)[ \t]+/g, ' ').trimEnd() : stamped;
    })
    .join('\n');
}

export interface UnifiedDiffOptions {
  originalLabel: string;
  modifiedLabel: string;
  /** Lines that differ only in runs of whitespace or at their ends are unchanged. */
  ignoreWhitespace?: boolean;
  /** Unchanged lines shown around each change. */
  context?: number;
}

type Op = '=' | '-' | '+';

/** Past this many changed lines the rest is one replacement, which keeps the trace small. */
const MAX_EDITS = 2_000;

/**
 * `diff -u` output for two texts, or '' when they match. A missing final
 * newline is not reported.
 */
export function unifiedDiff(original: string, modified: string, options: UnifiedDiffOptions): string {
  const before = splitLines(original);
  const after = splitLines(modified);
  const key = lineKey(options.ignoreWhitespace);
  const ops = editScript(before.map(key), after.map(key));
  const context = options.context ?? 3;
  const oldAt = [0];
  const newAt = [0];
  for (const op of ops) {
    oldAt.push(oldAt.at(-1)! + (op === '+' ? 0 : 1));
    newAt.push(newAt.at(-1)! + (op === '-' ? 0 : 1));
  }
  const lines: string[] = [];
  for (let index = 0; index < ops.length; index++) {
    if (ops[index] === '=') continue;
    const start = Math.max(0, index - context);
    let end = index + 1;
    for (let next = end; next < ops.length; next++) {
      if (ops[next] !== '=') end = next + 1;
      else if (next - end >= 2 * context) break;
    }
    const stop = Math.min(ops.length, end + context);
    lines.push(
      `@@ -${range(oldAt[start]!, oldAt[stop]! - oldAt[start]!)} +${range(newAt[start]!, newAt[stop]! - newAt[start]!)} @@`,
    );
    for (let line = start; line < stop; line++) {
      const op = ops[line]!;
      lines.push(op === '+' ? `+${after[newAt[line]!]}` : `${op === '-' ? '-' : ' '}${before[oldAt[line]!]}`);
    }
    index = stop - 1;
  }
  return lines.length
    ? `--- ${options.originalLabel}\n+++ ${options.modifiedLabel}\n${lines.join('\n')}\n`
    : '';
}

/** Whether {@link unifiedDiff} would find no differences, without building the diff. */
export function textsMatch(original: string, modified: string, ignoreWhitespace = false): boolean {
  if (original === modified) return true;
  const before = splitLines(original);
  const after = splitLines(modified);
  if (before.length !== after.length) return false;
  const key = lineKey(ignoreWhitespace);
  return before.every((line, index) => key(line) === key(after[index]!));
}

function lineKey(ignoreWhitespace = false): (line: string) => string {
  return ignoreWhitespace ? (line) => line.replace(/\s+/g, ' ').trim() : (line) => line;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function range(start: number, count: number): string {
  if (count === 1) return String(start + 1);
  return `${count === 0 ? start : start + 1},${count}`;
}

function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...Array<Op>(head).fill('='),
    ...myers(a.slice(head, endA), b.slice(head, endB)),
    ...Array<Op>(a.length - endA).fill('='),
  ];
}

/** Myers' O(ND) shortest edit script. Within a change it removes lines before adding them, as diff prints them. */
function myers(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  // trace[d] holds diagonals -d-1..d+1 as they were before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return [...Array<Op>(n).fill('-'), ...Array<Op>(m).fill('+')];
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d]!;
    const at = (k: number) => snapshot[k + d + 1]!;
    const k = x - y;
    const previous = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previous);
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      ops.push('=');
      x--;
      y--;
    }
    if (d > 0) ops.push(x === previousX ? '+' : '-');
    x = previousX;
    y = previousY;
  }
  return ops.reverse();
}
