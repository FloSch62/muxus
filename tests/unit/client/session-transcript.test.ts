import { describe, expect, it } from 'vitest';
import { sessionTranscript, type SessionLogEvent } from '@muxus/shared';
import { findTranscriptMatchesInChunks } from '../../../client/src/session-history-matches.js';

const first = '2026-09-24T10:00:00.000Z';
const second = '2026-09-24T10:00:05.000Z';
const event = (text: string, extra: Partial<SessionLogEvent> = {}): SessionLogEvent => ({
  sequence: 1, recordedAt: first, elapsedMs: 0, direction: 'output', text, ...extra,
});

describe('timestamped transcripts', () => {
  it('uses per-line times, preserves blank lines and does not add a trailing prefix', () => {
    const events = [event('one\n\ntwo\n', { lineTimestamps: [
      { offset: 0, recordedAt: first }, { offset: 4, recordedAt: first },
      { offset: 5, recordedAt: second },
    ] })];
    expect(sessionTranscript(events, true).text).toBe(`[${first}] one\n[${first}] \n[${second}] two\n`);
    expect(sessionTranscript(events).text).toBe('one\n\ntwo\n');
  });

  it('uses legacy event times and prefixes a partial line only once', () => {
    expect(sessionTranscript([event('par'), event('tial\nnext', { recordedAt: second })], true).text)
      .toBe(`[${first}] partial\n[${second}] next`);
  });

  it('keeps search offsets correct and excludes timestamp text from search', () => {
    const model = sessionTranscript([event('deploy\ncomplete\n', { direction: 'system' })], true, true);
    const matches = findTranscriptMatchesInChunks(model.chunks, 'complete', 10);
    expect(matches.map((match) => model.text.slice(match.start, match.end))).toEqual(['complete']);
    expect(findTranscriptMatchesInChunks(model.chunks, '2026', 10)).toEqual([]);
    const phrase = findTranscriptMatchesInChunks(model.chunks, 'deploy-complete', 10);
    expect(phrase).toHaveLength(1);
    expect(model.text.slice(phrase[0]!.start, phrase[0]!.end)).toBe(`deploy\n[${first}] complete`);
  });
});
