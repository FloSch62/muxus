import type { SessionLogEvent } from './api-types.js';

export interface SessionTranscriptChunk {
  text: string;
  offset: number;
  prefixes: { offset: number; length: number }[];
}

/** Render timestamps without changing recorded text or searchable content. */
export function sessionTranscript(
  events: SessionLogEvent[],
  timestamps = false,
  markers = false,
): { text: string; chunks: SessionTranscriptChunk[] } {
  let text = '';
  let lineStart = true;
  const chunks: SessionTranscriptChunk[] = [];
  for (const event of events) {
    const marker = markers
      ? event.direction === 'input' ? '› ' : event.direction === 'system' ? '• ' : ''
      : '';
    const chunk: SessionTranscriptChunk = { text: event.text, offset: text.length, prefixes: [] };
    let stampIndex = 0;
    let recordedAt = event.recordedAt;
    for (let start = 0; start < event.text.length;) {
      while (event.lineTimestamps?.[stampIndex] && event.lineTimestamps[stampIndex]!.offset <= start) {
        recordedAt = event.lineTimestamps[stampIndex++]!.recordedAt;
      }
      const prefix = (timestamps && lineStart ? `[${recordedAt}] ` : '') + (start === 0 ? marker : '');
      if (prefix) chunk.prefixes.push({ offset: start, length: prefix.length });
      const newline = event.text.indexOf('\n', start);
      const end = newline === -1 ? event.text.length : newline + 1;
      text += prefix + event.text.slice(start, end);
      lineStart = newline !== -1;
      start = end;
    }
    chunks.push(chunk);
  }
  return { text, chunks };
}
