/** Longest wait after each pasted line, in milliseconds. */
export const MAX_PASTE_LINE_DELAY_MS = 10_000;
/** Longest wait after each pasted character, in milliseconds. */
export const MAX_PASTE_CHAR_DELAY_MS = 1_000;
/** Largest paste the backend paces, in UTF-16 code units. */
export const MAX_PACED_PASTE_LENGTH = 1_000_000;

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/** The prompt a paste waits for after each line, unless the host sets its own. */
export const DEFAULT_PASTE_PROMPT_PATTERN = '[>#$]\\s*$';
/** An output line that stops a paste, unless the host sets its own: an IOS-style rejection. */
export const DEFAULT_PASTE_ERROR_PATTERN = '^%\\s*(Invalid|Incomplete|Ambiguous)';
/** Longest wait for the prompt after each line, unless the host sets its own. */
export const DEFAULT_PASTE_PROMPT_TIMEOUT_MS = 5_000;
export const MIN_PASTE_PROMPT_TIMEOUT_MS = 100;
export const MAX_PASTE_PROMPT_TIMEOUT_MS = 60_000;
/** Longest prompt or error pattern, in characters. */
export const MAX_PASTE_PATTERN_LENGTH = 500;

/**
 * Pacing a paste by the device's answers: after each line, wait for the
 * prompt instead of the line delay, and stop at the first rejected line.
 */
export interface PastePromptWait {
  /** Regex the line the device is on matches once it is ready for the next line. */
  promptPattern: string;
  /** Longest wait for the prompt after a line, in milliseconds; then the line delay applies. */
  timeoutMs: number;
  /** Regex an output line matches when the device rejected the line sent. */
  errorPattern: string;
}

/** How slowly a paste is typed into a session. Zero for both sends it at once. */
export interface PastePacing {
  /** Wait after each line, in milliseconds. */
  lineDelayMs: number;
  /** Wait after each character, in milliseconds. */
  charDelayMs: number;
  /** Wait for the prompt after each line; absent paces by the delays alone. */
  prompt?: PastePromptWait;
}

export function isPacedPaste(pacing: PastePacing): boolean {
  return pacing.lineDelayMs > 0 || pacing.charDelayMs > 0 || pacing.prompt !== undefined;
}

/**
 * The pacing a paste goes out with. A bracketed paste reaches the program
 * whole, with no prompt after each line, so it keeps the delays alone.
 */
export function pastePacingFor(pacing: PastePacing, bracketed: boolean): PastePacing {
  if (!bracketed || !pacing.prompt) return pacing;
  const { prompt: _prompt, ...delays } = pacing;
  return delays;
}

/** A host's prompt waiting, with the defaults where it sets nothing. */
export function resolvePastePromptWait(setting: Partial<PastePromptWait>): PastePromptWait {
  return {
    promptPattern: setting.promptPattern || DEFAULT_PASTE_PROMPT_PATTERN,
    timeoutMs: setting.timeoutMs ?? DEFAULT_PASTE_PROMPT_TIMEOUT_MS,
    errorPattern: setting.errorPattern || DEFAULT_PASTE_ERROR_PATTERN,
  };
}

/** Why a prompt or error pattern cannot be used, or undefined when it can. */
export function pastePatternProblem(pattern: string): string | undefined {
  if (pattern.length > MAX_PASTE_PATTERN_LENGTH) {
    return `Use at most ${MAX_PASTE_PATTERN_LENGTH} characters.`;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid regular expression.';
  }
  // Such a pattern matches any output at all, so it could never tell anything apart.
  if (regex.test('')) return 'This pattern matches empty text, so it would match any output.';
  return undefined;
}

/** A whole number of milliseconds the prompt wait may take. */
export function validPastePromptTimeout(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PASTE_PROMPT_TIMEOUT_MS &&
    value <= MAX_PASTE_PROMPT_TIMEOUT_MS
  );
}

/** A delay a host or the settings may store: a whole number of milliseconds in range. */
export function validPasteDelay(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * Text the way a terminal sends a paste, as xterm.js prepares it: every line
 * break (LF or CRLF) becomes CR, the Enter key. Inside bracketed paste, ESC
 * shows as ␛ so the text cannot close the bracket early.
 */
export function preparePasteText(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, '\r');
  return bracketed ? normalized.replaceAll('\x1b', '\u241b') : normalized;
}

/** Everything an unpaced paste sends, markers included: what xterm.js's own paste sends. */
export function terminalPasteData(text: string, bracketed: boolean): string {
  const prepared = preparePasteText(text, bracketed);
  return bracketed ? `${BRACKETED_PASTE_START}${prepared}${BRACKETED_PASTE_END}` : prepared;
}

/** Lines in prepared paste text: every CR ends one, and trailing text is one more. */
export function pastedLineCount(prepared: string): number {
  let lines = 0;
  for (let index = 0; index < prepared.length; index += 1) {
    if (prepared.charCodeAt(index) === 13) lines += 1;
  }
  return prepared.length > 0 && !prepared.endsWith('\r') ? lines + 1 : lines;
}

export interface PasteStep {
  data: string;
  /** The step ends with a line break. */
  lineEnd: boolean;
  /** Wait before the next step; zero after the last one. */
  delayMs: number;
}

/**
 * The writes of a paced paste of prepared text: a line at a time, or a
 * character (code point) at a time when there is a character delay. Every
 * character but the last is followed by the character delay, and every line
 * break but a final one by the line delay as well.
 */
export function* pastePacingSteps(prepared: string, pacing: PastePacing): Generator<PasteStep> {
  const perCharacter = pacing.charDelayMs > 0;
  let start = 0;
  while (start < prepared.length) {
    let next: number;
    if (perCharacter) {
      next = start + ((prepared.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
    } else {
      const lineBreak = prepared.indexOf('\r', start);
      next = lineBreak === -1 ? prepared.length : lineBreak + 1;
    }
    const lineEnd = prepared.charCodeAt(next - 1) === 13;
    yield {
      data: prepared.slice(start, next),
      lineEnd,
      delayMs:
        next >= prepared.length
          ? 0
          : (perCharacter ? pacing.charDelayMs : 0) + (lineEnd ? pacing.lineDelayMs : 0),
    };
    start = next;
  }
}

/** How long the pauses of a paced paste add up to, in milliseconds. */
export function pastePacingDurationMs(prepared: string, pacing: PastePacing): number {
  if (!prepared) return 0;
  let characters = 0;
  let lineBreaks = 0;
  for (const character of prepared) {
    characters += 1;
    if (character === '\r') lineBreaks += 1;
  }
  if (prepared.endsWith('\r')) lineBreaks -= 1;
  return (characters - 1) * pacing.charDelayMs + lineBreaks * pacing.lineDelayMs;
}
