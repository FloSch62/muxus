/** Longest wait after each pasted line, in milliseconds. */
export const MAX_PASTE_LINE_DELAY_MS = 10_000;
/** Longest wait after each pasted character, in milliseconds. */
export const MAX_PASTE_CHAR_DELAY_MS = 1_000;
/** Largest paste the backend paces, in UTF-16 code units. */
export const MAX_PACED_PASTE_LENGTH = 1_000_000;

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/** How slowly a paste is typed into a session. Zero for both sends it at once. */
export interface PastePacing {
  /** Wait after each line, in milliseconds. */
  lineDelayMs: number;
  /** Wait after each character, in milliseconds. */
  charDelayMs: number;
}

export function isPacedPaste(pacing: PastePacing): boolean {
  return pacing.lineDelayMs > 0 || pacing.charDelayMs > 0;
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
