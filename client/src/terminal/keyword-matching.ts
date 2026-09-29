import type { KeywordHighlightRule } from '@muxus/shared';

/** The rule fields that decide what a rule matches; all the matching worker receives. */
export type KeywordMatcher = Pick<
  KeywordHighlightRule,
  'keyword' | 'caseSensitive' | 'wholeWord' | 'regex'
>;

export interface KeywordMatch<R extends KeywordMatcher = KeywordHighlightRule> {
  start: number;
  end: number;
  rule: R;
}

export const MAX_KEYWORD_DECORATIONS = 500;

// Tested once per candidate match boundary while highlighting a frame.
const WORD_CHARACTER = /[A-Za-z0-9_]/;

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && WORD_CHARACTER.test(value);
}

function isWholeWord(text: string, start: number, end: number): boolean {
  return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end]);
}

// Keyed by source and flags rather than by rule object: the matching worker
// receives fresh copies of the rules with every request.
const MAX_COMPILED_PATTERNS = 256;
const compiledPatterns = new Map<string, RegExp | null>();

function rulePattern(rule: KeywordMatcher): RegExp | null {
  const flags = rule.caseSensitive ? 'g' : 'gi';
  const key = `${flags}/${rule.keyword}`;
  let pattern = compiledPatterns.get(key);
  if (pattern === undefined) {
    if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) compiledPatterns.clear();
    try {
      pattern = new RegExp(rule.keyword, flags);
    } catch {
      pattern = null;
    }
    compiledPatterns.set(key, pattern);
  }
  return pattern;
}

// Patterns the matching worker had to abandon because they ran too long. They
// stay paused for the session, so a pattern that hung once is not retried on
// every frame; editing it produces a new pattern that is tried again.
const slowPatterns = new Set<string>();
const slowPatternListeners = new Set<() => void>();

export function isSlowKeywordPattern(rule: Pick<KeywordMatcher, 'keyword' | 'regex'>): boolean {
  return !!rule.regex && slowPatterns.has(rule.keyword);
}

export function markSlowKeywordPattern(rule: Pick<KeywordMatcher, 'keyword'>): void {
  if (slowPatterns.has(rule.keyword)) return;
  slowPatterns.add(rule.keyword);
  for (const listener of slowPatternListeners) listener();
}

/** For `useSyncExternalStore`: the count changes whenever a pattern is paused. */
export function slowKeywordPatternCount(): number {
  return slowPatterns.size;
}

export function subscribeSlowKeywordPatterns(listener: () => void): () => void {
  slowPatternListeners.add(listener);
  return () => slowPatternListeners.delete(listener);
}

/** Why a regex rule cannot match, so editors can flag it; literals never fail. */
export function keywordPatternError(
  rule: Pick<KeywordMatcher, 'keyword' | 'regex'>,
): string | undefined {
  if (!rule.regex || !rule.keyword) return undefined;
  try {
    new RegExp(rule.keyword);
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid regular expression.';
  }
  return slowPatterns.has(rule.keyword)
    ? 'This pattern took too long to match and is paused. Simplify it to try again.'
    : undefined;
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

function findPatternMatches<R extends KeywordMatcher>(
  text: string,
  rule: R,
  matches: KeywordMatch<R>[],
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

/**
 * Find keyword and pattern matches in rule order, including overlapping rules.
 * A regex can backtrack for a very long time, so terminals run regex rules
 * through the matching worker rather than calling this on the UI thread.
 */
export function findKeywordMatches<R extends KeywordMatcher>(
  text: string,
  rules: readonly R[],
  limit = MAX_KEYWORD_DECORATIONS,
): KeywordMatch<R>[] {
  const matches: KeywordMatch<R>[] = [];
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

/**
 * Match every rule against every line, one rule at a time, so a watcher can
 * tell which regex was running if the work stalls. `onRegexRule` is called
 * before each regex rule starts. Returns flat [line, rule, start, end]
 * quadruples. Each rule keeps at most `limit` matches, which is all
 * `groupKeywordMatches` can use when it applies the same limit in line order.
 */
export function matchKeywordLines(
  rules: readonly KeywordMatcher[],
  lines: readonly string[],
  onRegexRule?: (ruleIndex: number) => void,
  limit = MAX_KEYWORD_DECORATIONS,
): number[] {
  const flat: number[] = [];
  rules.forEach((rule, ruleIndex) => {
    if (rule.regex) onRegexRule?.(ruleIndex);
    let remaining = limit;
    for (let line = 0; line < lines.length && remaining > 0; line++) {
      for (const match of findKeywordMatches(lines[line]!, [rule], remaining)) {
        flat.push(line, ruleIndex, match.start, match.end);
        remaining--;
      }
    }
  });
  return flat;
}

/**
 * Turn `matchKeywordLines` output back into per-line matches in rule order, as
 * `findKeywordMatches` orders them, keeping the first `limit` in line order.
 */
export function groupKeywordMatches<R extends KeywordMatcher>(
  flat: readonly number[],
  rules: readonly R[],
  lineCount: number,
  limit = MAX_KEYWORD_DECORATIONS,
): KeywordMatch<R>[][] {
  const lines = Array.from({ length: lineCount }, (): KeywordMatch<R>[] => []);
  for (let index = 0; index + 3 < flat.length; index += 4) {
    const rule = rules[flat[index + 1]!];
    const line = lines[flat[index]!];
    if (rule && line) line.push({ start: flat[index + 2]!, end: flat[index + 3]!, rule });
  }
  let remaining = limit;
  return lines.map((matches) => {
    const kept = matches.slice(0, Math.max(0, remaining));
    remaining -= kept.length;
    return kept;
  });
}
