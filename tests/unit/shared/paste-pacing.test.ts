import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASTE_ERROR_PATTERN,
  DEFAULT_PASTE_PROMPT_PATTERN,
  isPacedPaste,
  pastedLineCount,
  pastePacingDurationMs,
  pastePacingFor,
  pastePacingSteps,
  pastePatternProblem,
  preparePasteText,
  resolvePastePromptWait,
  terminalPasteData,
  validPasteDelay,
  validPastePromptTimeout,
  withEnterKey,
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

  it('keeps the bytes of CR, the default Enter key, exactly as before', () => {
    const text = 'conf t\nhostname r1\r\nend\r';
    expect(terminalPasteData(text, false, 'cr')).toBe(terminalPasteData(text, false));
    expect(terminalPasteData(text, false)).toBe('conf t\rhostname r1\rend\r');
    expect(withEnterKey('a\rb', 'cr')).toBe('a\rb');
  });

  it("sends every line break of an unbracketed paste as the host's Enter key", () => {
    expect(terminalPasteData('a\nb\r\nc\rd', false, 'crlf')).toBe('a\r\nb\r\nc\r\nd');
    expect(terminalPasteData('a\nb\r\nc\rd', false, 'lf')).toBe('a\nb\nc\nd');
  });

  it('keeps CR inside a bracketed paste, which the program reads as text, not keys', () => {
    expect(terminalPasteData('ls\nexit\n', true, 'crlf')).toBe('\x1b[200~ls\rexit\r\x1b[201~');
    expect(terminalPasteData('ls\nexit\n', true, 'lf')).toBe('\x1b[200~ls\rexit\r\x1b[201~');
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

  it('paces only when a delay is set or the prompt is awaited, and only accepts whole milliseconds in range', () => {
    expect(isPacedPaste({ lineDelayMs: 0, charDelayMs: 0 })).toBe(false);
    expect(isPacedPaste({ lineDelayMs: 0, charDelayMs: 1 })).toBe(true);
    expect(
      isPacedPaste({ lineDelayMs: 0, charDelayMs: 0, prompt: resolvePastePromptWait({}) }),
    ).toBe(true);
    expect(validPasteDelay(0, 10)).toBe(true);
    expect(validPasteDelay(10, 10)).toBe(true);
    expect(validPasteDelay(11, 10)).toBe(false);
    expect(validPasteDelay(1.5, 10)).toBe(false);
    expect(validPasteDelay('5', 10)).toBe(false);
  });
});

describe('waiting for the prompt', () => {
  it('fills in the defaults where a host sets nothing', () => {
    expect(resolvePastePromptWait({})).toEqual({
      promptPattern: '[>#$]\\s*$',
      timeoutMs: 5000,
      errorPattern: '^%\\s*(Invalid|Incomplete|Ambiguous)',
    });
    expect(resolvePastePromptWait({ promptPattern: '[>#\\]]\\s*$', timeoutMs: 20_000 })).toEqual({
      promptPattern: '[>#\\]]\\s*$',
      timeoutMs: 20_000,
      errorPattern: DEFAULT_PASTE_ERROR_PATTERN,
    });
  });

  it('matches the usual prompts and rejections with the defaults', () => {
    const prompt = new RegExp(DEFAULT_PASTE_PROMPT_PATTERN);
    for (const line of ['R1(config)#', 'R1>', 'admin@mx1> ', 'user@host:~$ ']) {
      expect(prompt.test(line)).toBe(true);
    }
    expect(prompt.test('Building configuration...')).toBe(false);
    const error = new RegExp(DEFAULT_PASTE_ERROR_PATTERN);
    for (const line of [
      "% Invalid input detected at '^' marker.",
      '% Incomplete command.',
      '%Ambiguous command: "sh"',
    ]) {
      expect(error.test(line)).toBe(true);
    }
    expect(error.test('interface % Invalid')).toBe(false);
  });

  it('leaves a bracketed paste the delays alone', () => {
    const pacing = { lineDelayMs: 100, charDelayMs: 0, prompt: resolvePastePromptWait({}) };
    expect(pastePacingFor(pacing, false)).toBe(pacing);
    expect(pastePacingFor(pacing, true)).toEqual({ lineDelayMs: 100, charDelayMs: 0 });
    expect(isPacedPaste(pastePacingFor({ ...pacing, lineDelayMs: 0 }, true))).toBe(false);
  });

  it('refuses a pattern that does not compile, is too long or matches empty text', () => {
    expect(pastePatternProblem(DEFAULT_PASTE_PROMPT_PATTERN)).toBeUndefined();
    expect(pastePatternProblem('([')).toMatch(/Invalid regular expression/);
    expect(pastePatternProblem('x'.repeat(501))).toBe('Use at most 500 characters.');
    expect(pastePatternProblem('')).toBe(
      'This pattern matches empty text, so it would match any output.',
    );
    expect(pastePatternProblem('#?\\s*$')).toBeDefined();
  });

  it('bounds the timeout to whole milliseconds from 100 ms to a minute', () => {
    expect(validPastePromptTimeout(100)).toBe(true);
    expect(validPastePromptTimeout(60_000)).toBe(true);
    expect(validPastePromptTimeout(99)).toBe(false);
    expect(validPastePromptTimeout(60_001)).toBe(false);
    expect(validPastePromptTimeout(1500.5)).toBe(false);
    expect(validPastePromptTimeout('5000')).toBe(false);
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

  it('takes prompt waiting as an optional part of a paste', () => {
    const paste = { op: 'paste', text: 'x\n', bracketed: false, lineDelayMs: 0, charDelayMs: 0 };
    const prompt = resolvePastePromptWait({});
    // A paste from a client that knows nothing of it still parses, without it.
    expect(terminalClientMessageSchema.parse(paste)).toEqual(paste);
    expect(terminalClientMessageSchema.parse({ ...paste, prompt })).toEqual({ ...paste, prompt });
    for (const bad of [
      { ...prompt, timeoutMs: 0 },
      { ...prompt, timeoutMs: 60_001 },
      { ...prompt, promptPattern: '' },
      { ...prompt, errorPattern: 'x'.repeat(501) },
      { promptPattern: prompt.promptPattern },
    ]) {
      expect(terminalClientMessageSchema.safeParse({ ...paste, prompt: bad }).success).toBe(false);
    }
  });

  it("accepts the host's Enter key by name only", () => {
    const paste = { op: 'paste', text: 'x', bracketed: false, lineDelayMs: 100, charDelayMs: 0 };
    expect(terminalClientMessageSchema.safeParse({ ...paste, enterKey: 'crlf' }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ ...paste, enterKey: 'lf' }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ ...paste, enterKey: '\n' }).success).toBe(false);
  });
});
