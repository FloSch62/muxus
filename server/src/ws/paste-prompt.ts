import type { PastePromptWait } from '@muxus/shared';
import {
  execWithTimeout,
  LOGIN_OUTPUT_WINDOW,
  LOGIN_PATTERN_TIME_LIMIT_MS,
  PatternTimeoutError,
  TerminalTextStream,
} from '../login-sequence/output-matcher.js';

/** How much of one line's answer is read for an error; later output is only searched for the prompt. */
const ANSWER_ERROR_LIMIT = 64 * 1024;
/** Longest line, sent or received, a stopped paste quotes. */
const REPORTED_LINE_MAX = 200;

export type PromptWatchResult =
  | { kind: 'prompt' }
  /** An output line matched the error pattern. */
  | { kind: 'error'; line: string }
  /** A pattern could not be run to the end, such as one past its time limit; it must not run again. */
  | { kind: 'failed'; message: string };

/**
 * Reads the output that answers the line a paced paste just sent, the way a
 * login sequence reads output: escape sequences stripped, line endings
 * reduced to `\n`, chunks joined. Every complete line is checked once
 * against the error pattern, a line at a time (`^` and `$` mark its ends).
 * The prompt is looked for on the unfinished last line, and only once the
 * device has started a new line, so the echo of the sent line never passes
 * for the prompt. Each regex run covers at most the login sequence's window,
 * and the runs of one check are abandoned past its time limit.
 */
export class PastePromptWatch {
  private readonly stream = new TerminalTextStream();
  private readonly prompt: RegExp;
  private readonly error: RegExp;
  /** Complete lines not checked for an error yet. */
  private unchecked = '';
  /** Characters of complete lines taken in since the line was sent. */
  private taken = 0;
  /** The unfinished last line, where a prompt waits. */
  private current = '';
  private newLine = false;

  /** Throws a SyntaxError for an invalid pattern. */
  constructor(
    wait: Pick<PastePromptWait, 'promptPattern' | 'errorPattern'>,
    private readonly timeLimitMs = LOGIN_PATTERN_TIME_LIMIT_MS,
  ) {
    this.prompt = new RegExp(wait.promptPattern);
    this.error = new RegExp(wait.errorPattern, 'm');
  }

  /** Output from here on answers the line about to be sent; anything earlier is forgotten. */
  reset(): void {
    this.unchecked = '';
    this.taken = 0;
    this.current = '';
    this.newLine = false;
  }

  append(data: Uint8Array): void {
    const text = this.stream.write(data);
    if (!text) return;
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) {
      this.current = tail(this.current + text);
      return;
    }
    this.newLine = true;
    if (this.taken < ANSWER_ERROR_LIMIT) {
      // Cut to the limit before it is kept, so one large chunk cannot carry past it.
      const lines = (this.current + text.slice(0, lastBreak + 1)).slice(
        0,
        ANSWER_ERROR_LIMIT - this.taken,
      );
      this.unchecked += lines;
      this.taken += lines.length;
    }
    this.current = tail(text.slice(lastBreak + 1));
  }

  /**
   * An error line in the answer so far, or the prompt when `prompt` is set;
   * undefined while there is neither. Every regex run of one check shares
   * the time limit, so a check holds up the backend no longer than one login
   * sequence match.
   */
  check(prompt = true): PromptWatchResult | undefined {
    const deadline = performance.now() + this.timeLimitMs;
    const timeLeft = () => Math.max(1, Math.ceil(deadline - performance.now()));
    let pattern = 'error';
    try {
      while (this.unchecked) {
        const piece = leadingLines(this.unchecked);
        this.unchecked = this.unchecked.slice(piece.length);
        const match = execWithTimeout(this.error, piece, timeLeft());
        if (match) return { kind: 'error', line: matchedLine(piece, match) };
      }
      if (!prompt || !this.newLine) return undefined;
      pattern = 'prompt';
      return execWithTimeout(this.prompt, this.current, timeLeft()) ? { kind: 'prompt' } : undefined;
    } catch (err) {
      return {
        kind: 'failed',
        message:
          err instanceof PatternTimeoutError
            ? `the ${pattern} pattern took too long to match`
            : `the ${pattern} pattern could not be matched: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

function tail(text: string): string {
  return text.length > LOGIN_OUTPUT_WINDOW ? text.slice(-LOGIN_OUTPUT_WINDOW) : text;
}

/** The whole lines that fit one regex run, or a window's worth of a longer line. */
function leadingLines(text: string): string {
  if (text.length <= LOGIN_OUTPUT_WINDOW) return text;
  const lastBreak = text.lastIndexOf('\n', LOGIN_OUTPUT_WINDOW - 1);
  return text.slice(0, lastBreak >= 0 ? lastBreak + 1 : LOGIN_OUTPUT_WINDOW);
}

/** The output line a match is on, trimmed and shortened for a notice. */
function matchedLine(text: string, match: RegExpExecArray): string {
  let index = match.index;
  // A match may start on the line break before the line it is about.
  while (text[index] === '\n' && index < match.index + match[0].length - 1) index += 1;
  const start = index > 0 ? text.lastIndexOf('\n', index - 1) + 1 : 0;
  const end = text.indexOf('\n', index);
  return shortened(text.slice(start, end < 0 ? text.length : end).trim());
}

/** A pasted line as a stop notice quotes it: as the device shows it, trimmed and shortened. */
export function pastedLineText(data: string): string {
  return shortened(new TerminalTextStream().write(Buffer.from(data, 'utf8')).trim());
}

function shortened(line: string): string {
  return line.length > REPORTED_LINE_MAX ? `${line.slice(0, REPORTED_LINE_MAX - 1)}…` : line;
}
