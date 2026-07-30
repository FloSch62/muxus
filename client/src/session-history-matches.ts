export interface TranscriptMatch {
  start: number;
  end: number;
}

export interface TranscriptChunk {
  text: string;
  offset: number;
}

interface TranscriptToken extends TranscriptMatch {
  normalized: string;
}

interface QueryPhrase {
  tokens: string[];
  prefixLastToken: boolean;
}

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const SIGNAL_PATTERN = /[\p{L}\p{N}]/u;
const DIACRITIC_PATTERN = /\p{M}/gu;

/**
 * Locate the token phrases that make a transcript chunk satisfy the worker's
 * FTS query. Whitespace-separated query parts are independent AND phrases,
 * and the last useful part is a prefix unless it is a single character.
 */
export function findTranscriptMatches(
  text: string,
  query: string,
  limit: number,
): TranscriptMatch[] {
  return findTranscriptMatchesInChunks([{ text, offset: 0 }], query, limit);
}

/**
 * Match each transcript chunk independently, as FTS does. This prevents terms
 * split across adjacent preview events from being presented as one FTS hit.
 */
export function findTranscriptMatchesInChunks(
  chunks: TranscriptChunk[],
  query: string,
  limit: number,
): TranscriptMatch[] {
  if (limit < 1) return [];
  const phrases = queryPhrases(query);
  if (!phrases.length) return [];
  const matches: TranscriptMatch[] = [];

  for (const chunk of chunks) {
    const chunkMatches = findChunkMatches(chunk.text, phrases, limit - matches.length);
    matches.push(...chunkMatches.map((match) => ({
      start: chunk.offset + match.start,
      end: chunk.offset + match.end,
    })));
    if (matches.length >= limit) break;
  }
  return matches;
}

function findChunkMatches(
  text: string,
  phrases: QueryPhrase[],
  limit: number,
): TranscriptMatch[] {
  const transcriptTokens = tokenize(text);
  const matches: TranscriptMatch[] = [];

  for (const phrase of phrases) {
    let phraseFound = false;
    for (let index = 0; index <= transcriptTokens.length - phrase.tokens.length; index++) {
      if (!phraseMatches(transcriptTokens, index, phrase)) continue;
      phraseFound = true;
      matches.push({
        start: transcriptTokens[index]!.start,
        end: transcriptTokens[index + phrase.tokens.length - 1]!.end,
      });
    }
    if (!phraseFound) return [];
  }

  matches.sort((left, right) => left.start - right.start || left.end - right.end);
  const distinct: TranscriptMatch[] = [];
  for (const match of matches) {
    const previous = distinct.at(-1);
    if (previous && match.start < previous.end) {
      previous.end = Math.max(previous.end, match.end);
      continue;
    }
    if (distinct.length >= limit) break;
    distinct.push({ ...match });
  }
  return distinct;
}

function queryPhrases(query: string): QueryPhrase[] {
  const parts = query
    .trim()
    .split(/\s+/)
    .filter((part) => SIGNAL_PATTERN.test(part));

  return parts.flatMap((part, index) => {
    const tokens = tokenize(part).map((token) => token.normalized);
    return tokens.length
      ? [{
          tokens,
          prefixLastToken: index === parts.length - 1 && part.length > 1,
        }]
      : [];
  });
}

function phraseMatches(
  transcriptTokens: TranscriptToken[],
  start: number,
  phrase: QueryPhrase,
): boolean {
  return phrase.tokens.every((token, index) => {
    const value = transcriptTokens[start + index]!.normalized;
    return phrase.prefixLastToken && index === phrase.tokens.length - 1
      ? value.startsWith(token)
      : value === token;
  });
}

function tokenize(value: string): TranscriptToken[] {
  return Array.from(value.matchAll(TOKEN_PATTERN), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    normalized: match[0]
      .normalize('NFD')
      .replace(DIACRITIC_PATTERN, '')
      .toLowerCase(),
  }));
}
