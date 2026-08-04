import { describe, expect, it } from 'vitest';
import type { KeywordHighlightRule } from '@muxus/shared';
import {
  findKeywordMatches,
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
