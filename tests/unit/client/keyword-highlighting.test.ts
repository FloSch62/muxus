import { describe, expect, it, vi } from 'vitest';
import type { KeywordHighlightRule } from '@muxus/shared';
import { resolveKeywordHighlights } from '../../../client/src/terminal/keyword-highlighting.js';
import {
  findKeywordMatches,
  groupKeywordMatches,
  isSlowKeywordPattern,
  keywordHighlightRulesProblem,
  keywordPatternError,
  markSlowKeywordPattern,
  matchKeywordLines,
  slowKeywordPatternCount,
  subscribeSlowKeywordPatterns,
} from '../../../client/src/terminal/keyword-matching.js';

const rule = (
  id: string,
  keyword: string,
  patch: Partial<KeywordHighlightRule> = {},
): KeywordHighlightRule => ({
  id,
  keyword,
  foreground: '#ffffff',
  caseSensitive: false,
  wholeWord: false,
  ...patch,
});

describe('findKeywordMatches', () => {
  it('finds every literal occurrence case-insensitively', () => {
    const matches = findKeywordMatches('error: ERROR and error', [rule('error', 'ERROR')]);
    expect(matches.map(({ start, end }) => [start, end])).toEqual([
      [0, 5],
      [7, 12],
      [17, 22],
    ]);
  });

  it('supports case-sensitive and whole-word rules', () => {
    const text = 'WARN warning preWARN WARN_ WARN';
    expect(
      findKeywordMatches(text, [
        rule('warn', 'WARN', { caseSensitive: true, wholeWord: true }),
      ]).map(({ start }) => start),
    ).toEqual([0, 27]);
  });

  it('matches regex rules, honoring case and whole-word options', () => {
    const text = 'Port 1/1/1 Up, port 1/1/12 up, 21/1/1x';
    const port = rule('port', String.raw`\d+/\d+/\d+`, { regex: true, wholeWord: true });
    expect(
      findKeywordMatches(text, [port]).map(({ start, end }) => text.slice(start, end)),
    ).toEqual(['1/1/1', '1/1/12']);
    const up = rule('up', String.raw`\bup\b`, { regex: true });
    expect(
      findKeywordMatches(text, [{ ...up, caseSensitive: true }]).map(({ start }) => start),
    ).toEqual([27]);
    expect(findKeywordMatches(text, [up])).toHaveLength(2);
  });

  it('treats a regex keyword literally unless the rule opts in', () => {
    expect(findKeywordMatches('a.c abc', [rule('dot', 'a.c')]).map(({ start }) => start)).toEqual([
      0,
    ]);
    expect(
      findKeywordMatches('a.c abc', [rule('dot', 'a.c', { regex: true })]).map(({ start }) => start),
    ).toEqual([0, 4]);
  });

  it('skips empty regex matches without looping and ignores invalid patterns', () => {
    expect(findKeywordMatches('abc', [rule('empty', 'x*', { regex: true })])).toEqual([]);
    expect(findKeywordMatches('abc', [rule('anchor', '^', { regex: true })])).toEqual([]);
    expect(findKeywordMatches('(abc', [rule('broken', '(abc', { regex: true })])).toEqual([]);
  });

  it('stops at the decoration limit', () => {
    expect(findKeywordMatches('a a a a', [rule('a', 'a', { regex: true })], 2)).toHaveLength(2);
  });

  it('keeps rule order so later host decorations can override globals', () => {
    const matches = findKeywordMatches('down', [
      rule('global', 'down'),
      rule('host', 'down'),
    ]);
    expect(matches.map((match) => match.rule.id)).toEqual(['global', 'host']);
  });
});

describe('resolveKeywordHighlights', () => {
  const global = [rule('global', 'ERROR')];
  const profile = [rule('profile', 'WARNING')];
  const host = [rule('host', 'FAILED')];

  it('uses globals for terminals without host configuration', () => {
    expect(resolveKeywordHighlights(global)).toEqual(global);
  });

  it('adds inherited host rules after global rules', () => {
    expect(
      resolveKeywordHighlights(global, { inheritGlobal: true, rules: host }),
    ).toEqual([...global, ...host]);
  });

  it('can replace global rules for one host', () => {
    expect(
      resolveKeywordHighlights(global, { inheritGlobal: false, rules: host }),
    ).toEqual(host);
  });

  it('applies an assigned profile between global and host-specific rules', () => {
    expect(
      resolveKeywordHighlights(
        global,
        { inheritGlobal: true, profileId: 'nokia-sros', rules: host },
        profile,
      ),
    ).toEqual([...global, ...profile, ...host]);
  });

  it('keeps an assigned profile when global rules are disabled', () => {
    expect(
      resolveKeywordHighlights(
        global,
        { inheritGlobal: false, profileId: 'nokia-sros', rules: host },
        profile,
      ),
    ).toEqual([...profile, ...host]);
  });
});

describe('matchKeywordLines', () => {
  const literal = rule('down', 'down');
  const regex = rule('port', String.raw`\d+/\d+`, { regex: true });

  it('matches rule by rule and announces each regex rule before it runs', () => {
    const started: number[] = [];
    const flat = matchKeywordLines([literal, regex], ['1/1 down', 'down 2/2'], (index) =>
      started.push(index),
    );
    expect(started).toEqual([1]);
    expect(flat).toEqual([0, 0, 4, 8, 1, 0, 0, 4, 0, 1, 0, 3, 1, 1, 5, 8]);
  });

  it('regroups by line in rule order, keeping the first matches in line order', () => {
    const rules = [literal, regex];
    const flat = matchKeywordLines(rules, ['1/1 down', 'down 2/2']);
    const lines = groupKeywordMatches(flat, rules, 2);
    expect(lines.map((matches) => matches.map((match) => match.rule.id))).toEqual([
      ['down', 'port'],
      ['down', 'port'],
    ]);
    // Same order and content as matching each line directly.
    expect(lines[0]).toEqual(findKeywordMatches('1/1 down', rules));
    expect(
      groupKeywordMatches(flat, rules, 2, 3).map((matches) => matches.length),
    ).toEqual([2, 1]);
  });

  it('caps each rule so a busy pattern cannot flood the result', () => {
    const flat = matchKeywordLines([rule('a', 'a')], ['a a a', 'a a'], undefined, 4);
    expect(flat.length / 4).toBe(4);
  });
});

describe('slow keyword patterns', () => {
  it('pauses a regex pattern, reports it, and notifies subscribers once', () => {
    const slow = rule('slow', '(a+)+$', { regex: true });
    const listener = vi.fn();
    const unsubscribe = subscribeSlowKeywordPatterns(listener);
    const before = slowKeywordPatternCount();

    markSlowKeywordPattern(slow);
    markSlowKeywordPattern(slow);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(slowKeywordPatternCount()).toBe(before + 1);
    expect(isSlowKeywordPattern(slow)).toBe(true);
    // The same text as a literal keyword cannot backtrack, so it is not paused.
    expect(isSlowKeywordPattern({ ...slow, regex: false })).toBe(false);
    expect(keywordPatternError(slow)).toMatch(/took too long/);
    expect(keywordHighlightRulesProblem([slow])).toMatch(/^Highlighting: This pattern took too long/);
    unsubscribe();
  });
});

describe('keyword rule validation', () => {
  it('reports regex syntax errors only for regex rules', () => {
    expect(keywordPatternError({ keyword: '(up', regex: true })).toMatch(/Invalid regular expression/);
    expect(keywordPatternError({ keyword: '(up' })).toBeUndefined();
    expect(keywordPatternError({ keyword: '(up|down)', regex: true })).toBeUndefined();
  });

  it('names the first rule that cannot be saved', () => {
    expect(keywordHighlightRulesProblem([rule('ok', 'up'), rule('empty', ' ')])).toBe(
      'Every highlighting rule needs a keyword.',
    );
    expect(keywordHighlightRulesProblem([rule('broken', '[a-', { regex: true })])).toMatch(
      /^Highlighting: Invalid regular expression/,
    );
    expect(keywordHighlightRulesProblem([rule('ok', '[a-z]+', { regex: true })])).toBeNull();
  });
});
