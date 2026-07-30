import { describe, expect, it } from 'vitest';
import {
  findTranscriptMatches,
  findTranscriptMatchesInChunks,
} from '../../../client/src/session-history-matches.js';

describe('session history transcript matches', () => {
  it('highlights nonadjacent query phrases independently', () => {
    expect(
      findTranscriptMatches('BGP neighbor established\n', 'BGP established', 100),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 13, end: 24 },
    ]);
  });

  it('uses exact tokens except for the final prefix phrase', () => {
    expect(
      findTranscriptMatches(
        'foo foobar established establishment\n',
        'foo establish',
        100,
      ),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 11, end: 22 },
      { start: 23, end: 36 },
    ]);
  });

  it('matches punctuation-separated token phrases and drops separators', () => {
    expect(
      findTranscriptMatches(
        'ssh admin@192.168.72 -> ready\n',
        '192.168.7 ->',
        100,
      ),
    ).toEqual([{ start: 10, end: 20 }]);
  });

  it('coalesces overlapping phrases and respects the render limit', () => {
    expect(findTranscriptMatches('foo foo\n', 'foo fo', 1)).toEqual([
      { start: 0, end: 3 },
    ]);
  });

  it('does not combine query phrases from separate transcript chunks', () => {
    expect(
      findTranscriptMatchesInChunks([
        { text: 'BGP neighbor\n', offset: 0 },
        { text: 'established\n', offset: 13 },
      ], 'BGP established', 100),
    ).toEqual([]);
  });
});
