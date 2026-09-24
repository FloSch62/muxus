import { describe, expect, it } from 'vitest';
import type { KeywordHighlightRule } from '@muxus/shared';
import {
  findKeywordMatches,
  keywordHighlightRulesProblem,
  keywordPatternError,
  resolveKeywordHighlights,
} from '../../../client/src/terminal/keyword-highlighting.js';

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
