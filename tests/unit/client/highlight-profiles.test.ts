import { describe, expect, it } from 'vitest';
import type { KeywordHighlightProfile } from '@muxus/shared';
import {
  HIGHLIGHT_PROFILE_FORMAT,
  HIGHLIGHT_PROFILE_VERSION,
  createHighlightProfileDocument,
  isKeywordHighlightProfileArray,
  mergeHighlightProfiles,
  parseHighlightProfileDocument,
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
      version: HIGHLIGHT_PROFILE_VERSION,
      profiles: [nokia],
    });
    expect(parseHighlightProfileDocument(JSON.stringify(document))).toEqual(document);
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

  it('rejects duplicate profile and rule IDs', () => {
    expect(isKeywordHighlightProfileArray([nokia, { ...nokia }])).toBe(false);
    expect(
      isKeywordHighlightProfileArray([
        { ...nokia, rules: [nokia.rules[0]!, { ...nokia.rules[0]! }] },
      ]),
    ).toBe(false);
  });
});
