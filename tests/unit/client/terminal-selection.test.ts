import type { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { terminalSelectionText } from '../../../client/src/terminal/selection-text.js';

interface StubLine {
  text: string;
  isWrapped: boolean;
}

function terminalSelection(
  lines: readonly StubLine[],
  selection: string,
  start = { x: 0, y: 0 },
  end = { x: lines.at(-1)?.text.length ?? 0, y: lines.length - 1 },
): Parameters<typeof terminalSelectionText>[0] {
  const bufferLines = lines.map((line) => ({
    isWrapped: line.isWrapped,
    length: line.text.length,
    translateToString: (
      trimRight = false,
      startColumn = 0,
      endColumn = line.text.length,
    ) => {
      const text = line.text.slice(startColumn, endColumn);
      if (!trimRight) return text;
      let trimmedLength = text.length;
      while (trimmedLength > 0 && text.charCodeAt(trimmedLength - 1) === 0) {
        trimmedLength -= 1;
      }
      return text.slice(0, trimmedLength);
    },
  }));
  return {
    getSelection: () => selection,
    getSelectionPosition: () => ({ start, end }),
    buffer: {
      active: {
        getLine: (row: number) => bufferLines[row],
      },
    },
  } as unknown as Pick<Terminal, 'buffer' | 'getSelection' | 'getSelectionPosition'>;
}

describe('terminal selection text', () => {
  it('restores the explicit wrapped space from issue 100', () => {
    const first =
      'cfm service create vs XXXXXXXXXX alarm-priority 2 remote-mep-aging on ' +
      'remote-mep-aging-time 300 ccm-interval ';
    const second = '100ms alarm-time 0';
    const term = terminalSelection(
      [
        { text: first, isWrapped: false },
        { text: second, isWrapped: true },
      ],
      `${first.trimEnd()}${second}`,
    );

    expect(terminalSelectionText(term)).toBe(`${first}${second}`);
  });

  it('restores trailing spaces before a hard line break', () => {
    const term = terminalSelection(
      [
        { text: 'abc ', isWrapped: false },
        { text: 'def', isWrapped: false },
      ],
      'abc\ndef',
    );

    expect(terminalSelectionText(term)).toBe('abc \ndef');
  });

  it('preserves Windows line endings while repairing the selection', () => {
    const term = terminalSelection(
      [
        { text: 'abc ', isWrapped: false },
        { text: 'def', isWrapped: false },
      ],
      'abc\r\ndef',
    );

    expect(terminalSelectionText(term)).toBe('abc \r\ndef');
  });

  it('does not reinterpret a column selection across wrapped rows', () => {
    const term = terminalSelection(
      [
        { text: 'abc ', isWrapped: false },
        { text: 'def', isWrapped: true },
      ],
      'abc \ndef',
    );

    expect(terminalSelectionText(term)).toBe('abc \ndef');
  });

  it('does not hide unrelated differences in xterm selection output', () => {
    const term = terminalSelection(
      [
        { text: 'abc ', isWrapped: false },
        { text: 'def', isWrapped: true },
      ],
      'abdef',
    );

    expect(terminalSelectionText(term)).toBe('abdef');
  });

  it('leaves a single-row selection untouched', () => {
    const term = terminalSelection([{ text: 'abc ', isWrapped: false }], 'abc');

    expect(terminalSelectionText(term)).toBe('abc');
  });
});
