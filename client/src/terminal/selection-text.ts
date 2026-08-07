import type { Terminal } from '@xterm/xterm';

type SelectionTerminal = Pick<
  Terminal,
  'buffer' | 'getSelection' | 'getSelectionPosition'
>;

interface SelectionLine {
  correct: string;
  cached: string;
  isWrapped: boolean;
}

/** Build xterm's normal (non-column) selection for one line-ending style. */
function joinSelectionLines(
  lines: readonly SelectionLine[],
  lineEnding: '\n' | '\r\n',
  cached: boolean,
): string {
  const logicalLines: string[] = [];
  for (const line of lines) {
    const text = (cached ? line.cached : line.correct).replaceAll('\u00a0', ' ');
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += text;
    } else {
      logicalLines.push(text);
    }
  }
  return logicalLines.join(lineEnding);
}

/**
 * Return the selected terminal text without dropping explicit trailing spaces.
 *
 * xterm 6.1's line-string cache uses `trimEnd()` when an untrimmed cached line
 * is requested with trimming enabled. That removes real spaces as well as
 * empty cells. Selection then joins wrapped rows, changing `word 2` to
 * `word2`. Rebuild only selections that exactly match that cache-bug shape;
 * column selections and unrelated xterm behavior remain untouched.
 */
export function terminalSelectionText(term: SelectionTerminal): string {
  const selection = term.getSelection();
  const range = term.getSelectionPosition();
  if (!range || range.start.y === range.end.y) return selection;

  const lines: SelectionLine[] = [];
  const buffer = term.buffer.active;
  for (let row = range.start.y; row <= range.end.y; row += 1) {
    const line = buffer.getLine(row);
    if (!line) return selection;

    const startColumn = row === range.start.y ? range.start.x : 0;
    const endColumn = row === range.end.y ? range.end.x : undefined;
    // Supplying the physical line length makes this a non-canonical request,
    // bypassing xterm's cross-mode cache while retaining getTrimmedLength().
    const correct = line.translateToString(
      true,
      startColumn,
      endColumn ?? line.length,
    );
    const vulnerableCacheRequest = startColumn === 0 && endColumn === undefined;
    lines.push({
      correct,
      cached: vulnerableCacheRequest ? correct.trimEnd() : correct,
      isWrapped: row !== range.start.y && line.isWrapped,
    });
  }

  for (const lineEnding of ['\n', '\r\n'] as const) {
    const cached = joinSelectionLines(lines, lineEnding, true);
    const correct = joinSelectionLines(lines, lineEnding, false);
    if (cached !== correct && selection === cached) return correct;
  }
  return selection;
}
