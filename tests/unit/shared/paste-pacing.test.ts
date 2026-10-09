import { describe, expect, it } from 'vitest';
import {
  isPacedPaste,
  pastedLineCount,
  pastePacingDurationMs,
  pastePacingSteps,
  preparePasteText,
  terminalPasteData,
  validPasteDelay,
} from '@muxus/shared';
import { terminalClientMessageSchema } from '@muxus/shared/ws-protocol';

const steps = (text: string, lineDelayMs: number, charDelayMs: number) => [
  ...pastePacingSteps(text, { lineDelayMs, charDelayMs }),
];

describe('paste text preparation', () => {
  it('turns every LF and CRLF into the CR a terminal sends for Enter', () => {
    expect(preparePasteText('a\nb\r\nc\rd\n', false)).toBe('a\rb\rc\rd\r');
  });

  it('defangs ESC only inside bracketed paste, where it could close the bracket', () => {
    expect(preparePasteText('x\x1b[201~y', false)).toBe('x\x1b[201~y');
    expect(preparePasteText('x\x1b[201~y', true)).toBe('x\u241b[201~y');
  });

  it('sends an unpaced paste exactly as xterm.js would', () => {
    expect(terminalPasteData('ls\nexit\n', false)).toBe('ls\rexit\r');
    expect(terminalPasteData('ls\nexit\n', true)).toBe('\x1b[200~ls\rexit\r\x1b[201~');
  });

  it('counts the lines a paste types in', () => {
    expect(pastedLineCount('')).toBe(0);
    expect(pastedLineCount('show version')).toBe(1);
    expect(pastedLineCount('a\rb\r')).toBe(2);
    expect(pastedLineCount('a\rb\rc')).toBe(3);
    expect(pastedLineCount('\r\r')).toBe(2);
  });
});

describe('paced paste steps', () => {
  it('writes a line at a time and waits after every line but the last', () => {
    expect(steps('conf t\rhostname r1\rend\r', 200, 0)).toEqual([
      { data: 'conf t\r', lineEnd: true, delayMs: 200 },
      { data: 'hostname r1\r', lineEnd: true, delayMs: 200 },
      { data: 'end\r', lineEnd: true, delayMs: 0 },
    ]);
    expect(steps('a\rtrailing', 50, 0)).toEqual([
      { data: 'a\r', lineEnd: true, delayMs: 50 },
      { data: 'trailing', lineEnd: false, delayMs: 0 },
    ]);
  });

  it('writes a character at a time with a character delay, adding the line delay at breaks', () => {
    expect(steps('ab\rc', 100, 5)).toEqual([
      { data: 'a', lineEnd: false, delayMs: 5 },
      { data: 'b', lineEnd: false, delayMs: 5 },
      { data: '\r', lineEnd: true, delayMs: 105 },
      { data: 'c', lineEnd: false, delayMs: 0 },
    ]);
  });

  it('never splits a character outside the basic plane', () => {
    expect(steps('é🙂x', 0, 1).map((step) => step.data)).toEqual(['é', '🙂', 'x']);
  });

  it('adds the pauses up to the time the paste takes', () => {
    const pacing = { lineDelayMs: 100, charDelayMs: 5 };
    const text = 'ab\rc\r';
    const total = steps(text, pacing.lineDelayMs, pacing.charDelayMs).reduce(
      (sum, step) => sum + step.delayMs,
      0,
    );
    expect(pastePacingDurationMs(text, pacing)).toBe(total);
    expect(pastePacingDurationMs(text, pacing)).toBe(4 * 5 + 100);
    expect(pastePacingDurationMs('one\rtwo\rthree', { lineDelayMs: 250, charDelayMs: 0 })).toBe(500);
    expect(pastePacingDurationMs('', pacing)).toBe(0);
  });

  it('paces only when a delay is set, and only accepts whole milliseconds in range', () => {
    expect(isPacedPaste({ lineDelayMs: 0, charDelayMs: 0 })).toBe(false);
    expect(isPacedPaste({ lineDelayMs: 0, charDelayMs: 1 })).toBe(true);
    expect(validPasteDelay(0, 10)).toBe(true);
    expect(validPasteDelay(10, 10)).toBe(true);
    expect(validPasteDelay(11, 10)).toBe(false);
    expect(validPasteDelay(1.5, 10)).toBe(false);
    expect(validPasteDelay('5', 10)).toBe(false);
  });
});

describe('paced paste protocol', () => {
  it('accepts a paste with delays in range and a cancel', () => {
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'paste',
        text: 'show run\n',
        bracketed: true,
        lineDelayMs: 250,
        charDelayMs: 0,
      }).success,
    ).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ op: 'paste-cancel' }).success).toBe(true);
  });

  it('rejects delays out of range and empty pastes', () => {
    const paste = { op: 'paste', text: 'x', bracketed: false, lineDelayMs: 0, charDelayMs: 0 };
    expect(terminalClientMessageSchema.safeParse({ ...paste, lineDelayMs: 10_001 }).success).toBe(
      false,
    );
    expect(terminalClientMessageSchema.safeParse({ ...paste, charDelayMs: -1 }).success).toBe(false);
    expect(terminalClientMessageSchema.safeParse({ ...paste, text: '' }).success).toBe(false);
  });
});
