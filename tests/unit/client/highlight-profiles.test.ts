import { describe, expect, it } from 'vitest';
import type { KeywordHighlightProfile } from '@muxus/shared';
import {
  HIGHLIGHT_PROFILE_FORMAT,
  HIGHLIGHT_PROFILE_VERSION,
  MAX_KEYWORD_HIGHLIGHT_PROFILES,
  createHighlightProfileDocument,
  isKeywordHighlightProfileArray,
  keywordHighlightRulesToJson,
  mergeHighlightProfiles,
  parseHighlightProfileDocument,
  parseKeywordHighlightRulesJson,
} from '../../../client/src/highlight-profiles.js';

const nokia: KeywordHighlightProfile = {
  id: 'nokia-sros',
  name: 'Nokia SR OS',
  rules: [
    {
      id: 'major-alarm',
      keyword: 'MAJOR',
      foreground: '#ffffff',
      background: '#b91c1c',
      caseSensitive: true,
      wholeWord: true,
    },
  ],
};

describe('highlighting profile files', () => {
  it('round-trips a bounded, versioned profile document', () => {
    const document = createHighlightProfileDocument([nokia]);

    expect(document).toMatchObject({
      format: HIGHLIGHT_PROFILE_FORMAT,
      profiles: [nokia],
    });
    expect(parseHighlightProfileDocument(JSON.stringify(document))).toEqual(document);
  });

  it('keeps literal-only files at version 1 so older releases can import them', () => {
    const document = createHighlightProfileDocument([nokia]);
    expect(document.version).toBe(1);
    expect(parseHighlightProfileDocument(JSON.stringify(document)).version).toBe(1);
  });

  it('writes version 2 when a rule is a regex and round-trips the flag', () => {
    const regexRule = { ...nokia.rules[0]!, id: 'port', keyword: String.raw`\d+/\d+/\d+`, regex: true };
    const profile = { ...nokia, rules: [...nokia.rules, regexRule] };
    const document = createHighlightProfileDocument([profile]);

    expect(document.version).toBe(HIGHLIGHT_PROFILE_VERSION);
    expect(HIGHLIGHT_PROFILE_VERSION).toBe(2);
    expect(parseHighlightProfileDocument(JSON.stringify(document)).profiles).toEqual([profile]);
  });

  it('rejects a version 1 file that claims regex rules', () => {
    const regexRule = { ...nokia.rules[0]!, keyword: String.raw`\bMAJOR\b`, regex: true };
    const document = createHighlightProfileDocument([{ ...nokia, rules: [regexRule] }]);
    expect(() =>
      parseHighlightProfileDocument(JSON.stringify({ ...document, version: 1 })),
    ).toThrow(/regex rules, which need highlighting profile version 2/);
  });

  it('drops a false regex flag rather than exporting it', () => {
    const profile = { ...nokia, rules: [{ ...nokia.rules[0]!, regex: false }] };
    expect(createHighlightProfileDocument([profile]).profiles[0]!.rules[0]).not.toHaveProperty(
      'regex',
    );
  });

  it('round-trips an optional rule name and rejects an empty one', () => {
    const named = { ...nokia, rules: [{ ...nokia.rules[0]!, name: 'Major alarms' }] };
    expect(parseHighlightProfileDocument(JSON.stringify(createHighlightProfileDocument([named]))).profiles)
      .toEqual([named]);
    expect(isKeywordHighlightProfileArray([{ ...nokia, rules: [{ ...nokia.rules[0], name: '' }] }]))
      .toBe(false);
  });

  it('rejects a non-boolean regex flag', () => {
    expect(
      isKeywordHighlightProfileArray([
        { ...nokia, rules: [{ ...nokia.rules[0], regex: 'yes' }] },
      ]),
    ).toBe(false);
  });

  it('rejects unrelated, future, and malformed documents', () => {
    expect(() => parseHighlightProfileDocument('{no json')).toThrow(/valid JSON/);
    expect(() =>
      parseHighlightProfileDocument(
        JSON.stringify({
          format: 'another-format',
          version: HIGHLIGHT_PROFILE_VERSION,
          createdAt: new Date().toISOString(),
          profiles: [nokia],
        }),
      ),
    ).toThrow(/not a Muxus highlighting profile/);
    expect(() =>
      parseHighlightProfileDocument(
        JSON.stringify({
          format: HIGHLIGHT_PROFILE_FORMAT,
          version: HIGHLIGHT_PROFILE_VERSION + 1,
          createdAt: new Date().toISOString(),
          profiles: [nokia],
        }),
      ),
    ).toThrow(/not supported/);
    expect(isKeywordHighlightProfileArray([{ ...nokia, rules: [{ ...nokia.rules[0], foreground: 'red' }] }]))
      .toBe(false);
  });

  it('updates matching stable IDs without dropping unrelated profiles', () => {
    const cisco = { ...nokia, id: 'cisco-ios', name: 'Cisco IOS' };
    const updated = { ...nokia, name: 'Nokia SR OS 24' };

    expect(mergeHighlightProfiles([nokia, cisco], [updated])).toEqual([
      updated,
      cisco,
    ]);
  });

  it('allows replacements at the profile limit but rejects a distinct profile beyond it', () => {
    const existing = Array.from(
      { length: MAX_KEYWORD_HIGHLIGHT_PROFILES },
      (_, index): KeywordHighlightProfile => ({
        ...nokia,
        id: `profile-${index}`,
        name: `Profile ${index}`,
      }),
    );
    const replacement = { ...existing[0]!, name: 'Updated profile' };

    expect(mergeHighlightProfiles(existing, [replacement])).toHaveLength(
      MAX_KEYWORD_HIGHLIGHT_PROFILES,
    );
    expect(() =>
      mergeHighlightProfiles(existing, [
        { ...nokia, id: 'one-too-many', name: 'One too many' },
      ]),
    ).toThrow(/limit of 100 highlighting profiles/);
  });

  it('rejects duplicate profile and rule IDs', () => {
    expect(isKeywordHighlightProfileArray([nokia, { ...nokia }])).toBe(false);
    expect(
      isKeywordHighlightProfileArray([
        { ...nokia, rules: [nokia.rules[0]!, { ...nokia.rules[0]! }] },
      ]),
    ).toBe(false);
  });
});

describe('rules edited as JSON', () => {
  const rules = [
    { ...nokia.rules[0]!, name: 'Major alarms' },
    {
      id: 'port',
      keyword: String.raw`\d+/\d+/\d+`,
      foreground: '#3b82f6',
      caseSensitive: false,
      wholeWord: true,
      regex: true,
    },
  ];

  it('hides IDs and round-trips every field', () => {
    const text = keywordHighlightRulesToJson(rules);
    expect(text).not.toContain('"id"');
    expect(JSON.parse(text)[1]).toEqual({
      keyword: String.raw`\d+/\d+/\d+`,
      regex: true,
      caseSensitive: false,
      wholeWord: true,
      foreground: '#3b82f6',
    });
    expect(parseKeywordHighlightRulesJson(text, rules)).toEqual(rules);
  });

  it('defaults flags, keeps positional IDs, and generates new ones', () => {
    const parsed = parseKeywordHighlightRulesJson(
      JSON.stringify([
        { keyword: 'down', foreground: '#dc2626' },
        { keyword: 'up', foreground: '#16a34a', name: '' },
        { keyword: 'idle', foreground: '#d97706', background: null },
      ]),
      rules,
    );
    expect(parsed.map((rule) => rule.id).slice(0, 2)).toEqual(['major-alarm', 'port']);
    expect(parsed[2]!.id).toMatch(/^highlight-/);
    expect(parsed[0]).toEqual({
      id: 'major-alarm',
      keyword: 'down',
      foreground: '#dc2626',
      caseSensitive: false,
      wholeWord: false,
    });
    expect(parsed[1]).not.toHaveProperty('name');
    expect(parsed[2]).not.toHaveProperty('background');
  });

  it('accepts rules pasted from a profile file, keeping their IDs', () => {
    const pasted = JSON.stringify([{ ...rules[1], id: 'major-alarm' }, { ...rules[0], id: 'other' }]);
    expect(parseKeywordHighlightRulesJson(pasted, rules).map((rule) => rule.id)).toEqual([
      'major-alarm',
      'other',
    ]);
  });

  it('does not reuse a positional ID that an explicit entry claims', () => {
    const parsed = parseKeywordHighlightRulesJson(
      JSON.stringify([
        { keyword: 'a', foreground: '#ffffff' },
        { id: 'major-alarm', keyword: 'b', foreground: '#ffffff' },
      ]),
      rules,
    );
    expect(parsed[1]!.id).toBe('major-alarm');
    expect(parsed[0]!.id).not.toBe('major-alarm');
  });

  it('names the first problem with its rule number', () => {
    const parse = (value: unknown) =>
      parseKeywordHighlightRulesJson(typeof value === 'string' ? value : JSON.stringify(value), []);
    expect(() => parse('[{')).toThrow(/not valid JSON/);
    expect(() => parse({ keyword: 'x' })).toThrow(/array of rules/);
    expect(() => parse([{ foreground: '#ffffff' }])).toThrow(/Rule 1 needs a "keyword"/);
    expect(() => parse([{ keyword: 'x', foreground: '#ffffff' }, { keyword: 'y', foreground: 'red' }]))
      .toThrow(/Rule 2: "foreground" must be a color/);
    expect(() => parse([{ keyword: 'x', foreground: '#ffffff', colour: '#000000' }])).toThrow(
      /unknown field "colour"/,
    );
    expect(() => parse([{ keyword: 'x', foreground: '#ffffff', regex: 'yes' }])).toThrow(
      /"regex" must be true or false/,
    );
    expect(() => parse([{ keyword: '(x', foreground: '#ffffff', regex: true }])).toThrow(
      /Rule 1: Invalid regular expression/,
    );
    expect(() =>
      parse([
        { id: 'a', keyword: 'x', foreground: '#ffffff' },
        { id: 'a', keyword: 'y', foreground: '#ffffff' },
      ]),
    ).toThrow(/Rule 2 needs a unique "id"/);
  });
});
