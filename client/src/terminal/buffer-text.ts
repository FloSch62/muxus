import type { IBuffer } from '@xterm/xterm';

/**
 * Plain-text contents of scrollback + screen, trailing blank rows trimmed.
 * Rows the terminal soft-wrapped are joined back into one line.
 */
export function bufferText(buffer: Pick<IBuffer, 'length' | 'getLine'>): string {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    // The explicit end bypasses xterm's line cache, whose trim also drops real
    // spaces and would glue a word ending at the wrap onto the next row.
    const text = line?.translateToString(true, 0, line.length) ?? '';
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${lines.join('\n')}\n` : '';
}
