import type { HostKeywordHighlightConfig, KeywordHighlightRule } from '@muxus/shared';
import type { IBufferLine, IDecoration, IDisposable, Terminal } from '@xterm/xterm';

export interface KeywordMatch {
  start: number;
  end: number;
  rule: KeywordHighlightRule;
}

const MAX_DECORATIONS = 500;

// Tested once per candidate match boundary while highlighting a frame.
const WORD_CHARACTER = /[A-Za-z0-9_]/;

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && WORD_CHARACTER.test(value);
}

function isWholeWord(text: string, start: number, end: number): boolean {
  return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end]);
}

// Rules are replaced, never mutated, when edited, so each object compiles once
// instead of once per visible line per frame.
const compiledPatterns = new WeakMap<KeywordHighlightRule, RegExp | null>();

function rulePattern(rule: KeywordHighlightRule): RegExp | null {
  let pattern = compiledPatterns.get(rule);
  if (pattern === undefined) {
    try {
      pattern = new RegExp(rule.keyword, rule.caseSensitive ? 'g' : 'gi');
    } catch {
      pattern = null;
    }
    compiledPatterns.set(rule, pattern);
  }
  return pattern;
}

/** The syntax error for a regex rule, so editors can flag it; literals never fail. */
export function keywordPatternError(
  rule: Pick<KeywordHighlightRule, 'keyword' | 'regex'>,
): string | undefined {
  if (!rule.regex || !rule.keyword) return undefined;
  try {
    new RegExp(rule.keyword);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid regular expression.';
  }
}

/** The first reason a host's rules cannot be saved, or null when all are usable. */
export function keywordHighlightRulesProblem(
  rules: readonly KeywordHighlightRule[],
): string | null {
  for (const rule of rules) {
    if (!rule.keyword.trim()) return 'Every highlighting rule needs a keyword.';
    const error = keywordPatternError(rule);
    if (error) return `Highlighting: ${error}`;
  }
  return null;
}

function findPatternMatches(
  text: string,
  rule: KeywordHighlightRule,
  matches: KeywordMatch[],
  limit: number,
): void {
  // An invalid pattern stays inert while its editor shows the syntax error.
  const pattern = rulePattern(rule);
  if (!pattern) return;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (matches.length < limit && (match = pattern.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (end === start) {
      // Step past an empty match (`^`, `\b`, `x*`) instead of looping on it.
      pattern.lastIndex++;
      continue;
    }
    if (!rule.wholeWord || isWholeWord(text, start, end)) {
      matches.push({ start, end, rule });
    }
  }
}

/** Find keyword and pattern matches in rule order, including overlapping rules. */
export function findKeywordMatches(
  text: string,
  rules: readonly KeywordHighlightRule[],
  limit = MAX_DECORATIONS,
): KeywordMatch[] {
  const matches: KeywordMatch[] = [];
  let foldedText: string | undefined;
  for (const rule of rules) {
    if (!rule.keyword || matches.length >= limit) continue;
    if (rule.regex) {
      findPatternMatches(text, rule, matches, limit);
      continue;
    }
    const needle = rule.caseSensitive ? rule.keyword : rule.keyword.toLocaleLowerCase();
    if (!needle) continue;
    const haystack = rule.caseSensitive
      ? text
      : (foldedText ??= text.toLocaleLowerCase());
    let from = 0;
    while (from <= haystack.length - needle.length && matches.length < limit) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      const end = start + needle.length;
      if (!rule.wholeWord || isWholeWord(text, start, end)) {
        matches.push({ start, end, rule });
      }
      from = start + Math.max(1, needle.length);
    }
  }
  return matches;
}

/** Resolve the effective rules for a local/ad-hoc terminal or one saved host. */
export function resolveKeywordHighlights(
  globalRules: readonly KeywordHighlightRule[],
  hostConfig?: HostKeywordHighlightConfig,
  profileRules: readonly KeywordHighlightRule[] = [],
): KeywordHighlightRule[] {
  if (!hostConfig) return [...globalRules];
  return hostConfig.inheritGlobal
    ? [...globalRules, ...profileRules, ...hostConfig.rules]
    : [...profileRules, ...hostConfig.rules];
}

interface CellSegment {
  textStart: number;
  textEnd: number;
  cellStart: number;
  cellEnd: number;
}

function lineTextAndCells(
  line: IBufferLine,
  maxColumns: number,
): { text: string; segments: CellSegment[] } {
  let text = '';
  const segments: CellSegment[] = [];
  for (let column = 0; column < Math.min(line.length, maxColumns); column++) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    const textStart = text.length;
    text += chars;
    segments.push({
      textStart,
      textEnd: text.length,
      cellStart: column,
      cellEnd: column + Math.max(1, cell.getWidth()),
    });
  }
  return { text: text.trimEnd(), segments };
}

function cellsForMatch(
  segments: readonly CellSegment[],
  start: number,
  end: number,
): { x: number; width: number } | undefined {
  const first = segments.find((segment) => start < segment.textEnd);
  let last: CellSegment | undefined;
  for (const segment of segments) {
    if (segment.textStart >= end) break;
    last = segment;
  }
  if (!first || !last) return undefined;
  return { x: first.cellStart, width: last.cellEnd - first.cellStart };
}

export interface KeywordHighlighter extends IDisposable {
  setRules(rules: readonly KeywordHighlightRule[]): void;
}

/**
 * Highlight the visible viewport with tracked xterm decorations. Scanning is
 * frame-batched by onWriteParsed and repeated on scroll, so scrollback remains
 * correct without doing O(scrollback) work for every chunk of PTY output.
 */
export function attachKeywordHighlighter(
  terminal: Terminal,
  initialRules: readonly KeywordHighlightRule[],
): KeywordHighlighter {
  let rules = [...initialRules];
  let decorations: IDecoration[] = [];
  let disposed = false;
  let scheduled = false;

  const clear = () => {
    for (const decoration of decorations) {
      decoration.dispose();
      decoration.marker.dispose();
    }
    decorations = [];
  };

  const render = () => {
    scheduled = false;
    if (disposed) return;
    clear();
    if (rules.length === 0) return;

    const buffer = terminal.buffer.active;
    // xterm cannot anchor decorations in the alternate buffer used by full-screen apps.
    if (buffer.type === 'alternate') return;
    const viewportStart = buffer.viewportY;
    const viewportEnd = Math.min(buffer.length, viewportStart + terminal.rows);
    let remaining = MAX_DECORATIONS;
    for (let lineIndex = viewportStart; lineIndex < viewportEnd && remaining > 0; lineIndex++) {
      const line = buffer.getLine(lineIndex);
      if (!line) continue;
      const { text, segments } = lineTextAndCells(line, terminal.cols);
      for (const match of findKeywordMatches(text, rules, remaining)) {
        const range = cellsForMatch(segments, match.start, match.end);
        if (!range) continue;
        const marker = terminal.registerMarker(
          lineIndex - (buffer.baseY + buffer.cursorY),
        );
        if (!marker) continue;
        const decoration = terminal.registerDecoration({
          marker,
          x: range.x,
          width: range.width,
          foregroundColor: match.rule.foreground,
          backgroundColor: match.rule.background,
          layer: 'bottom',
        });
        if (decoration) decorations.push(decoration);
        else marker.dispose();
        remaining--;
      }
    }
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    requestAnimationFrame(render);
  };

  const writeListener = terminal.onWriteParsed(schedule);
  const scrollListener = terminal.onScroll(schedule);
  const bufferListener = terminal.buffer.onBufferChange(schedule);
  schedule();

  return {
    setRules(nextRules) {
      rules = [...nextRules];
      schedule();
    },
    dispose() {
      disposed = true;
      writeListener.dispose();
      scrollListener.dispose();
      bufferListener.dispose();
      clear();
    },
  };
}
