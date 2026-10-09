import vm from 'node:vm';

/** Output a wait step can match against: the newest characters, with ANSI removed. */
export const LOGIN_OUTPUT_WINDOW = 8192;
/** A pattern that backtracks longer than this is abandoned instead of stalling the backend. */
export const LOGIN_PATTERN_TIME_LIMIT_MS = 100;
/** Cursor-forward moves render as at most this many spaces. */
const MAX_CURSOR_FORWARD = 80;

/**
 * Terminal output as the text a person reads: UTF-8 decoded across chunk
 * boundaries, escape sequences (colours, cursor movement, titles) removed and
 * line endings reduced to `\n`. A sequence split between two chunks is still
 * recognised, because the parser state carries over.
 */
export class TerminalTextStream {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private state: 'text' | 'escape' | 'intermediate' | 'csi' | 'string' | 'string-escape' = 'text';
  private csi = '';

  write(data: Uint8Array): string {
    let text = '';
    for (const char of this.decoder.decode(data, { stream: true })) {
      const code = char.codePointAt(0)!;
      switch (this.state) {
        case 'text':
          if (code === 0x1b) this.state = 'escape';
          else if (char === '\n' || char === '\t' || (code >= 0x20 && code !== 0x7f)) text += char;
          // Carriage returns, bells, backspaces and other controls carry no text.
          break;
        case 'escape':
          if (char === '[') {
            this.csi = '';
            this.state = 'csi';
          } else if (char === ']' || char === 'P' || char === 'X' || char === '^' || char === '_') {
            this.state = 'string';
          } else if (code >= 0x20 && code <= 0x2f) {
            this.state = 'intermediate';
          } else {
            this.state = 'text';
          }
          break;
        case 'intermediate':
          if (code >= 0x30 && code <= 0x7e) this.state = 'text';
          break;
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) {
            // Some devices space words with cursor-forward instead of blanks.
            if (char === 'C') text += ' '.repeat(cursorForward(this.csi));
            this.state = 'text';
          } else if (this.csi.length < 64) {
            this.csi += char;
          }
          break;
        case 'string':
          if (code === 0x07) this.state = 'text';
          else if (code === 0x1b) this.state = 'string-escape';
          break;
        case 'string-escape':
          this.state = char === '\\' ? 'text' : 'string';
          break;
      }
    }
    return text;
  }
}

function cursorForward(params: string): number {
  const count = Number.parseInt(params, 10);
  return Number.isInteger(count) && count > 0 ? Math.min(count, MAX_CURSOR_FORWARD) : 1;
}

export interface OutputMatch {
  /** Offset just past the match in the current window. */
  end: number;
}

export class PatternTimeoutError extends Error {
  constructor() {
    super('The pattern took too long to match.');
    this.name = 'PatternTimeoutError';
  }
}

// One sandbox for every regex run: vm's timeout interrupts a backtracking
// regex, so a pathological pattern stops one wait step instead of the whole
// backend.
const regexSandbox = vm.createContext({});
const regexRun = new vm.Script('pattern.lastIndex = 0; match = pattern.exec(text);');

function execWithTimeout(pattern: RegExp, text: string, timeoutMs: number): RegExpExecArray | null {
  const scope = regexSandbox as { pattern?: RegExp; text?: string; match?: RegExpExecArray | null };
  scope.pattern = pattern;
  scope.text = text;
  scope.match = null;
  try {
    regexRun.runInContext(regexSandbox, { timeout: timeoutMs });
    return scope.match ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new PatternTimeoutError();
    }
    throw err;
  } finally {
    scope.pattern = undefined;
    scope.text = undefined;
    scope.match = null;
  }
}

/** Compile a wait step's pattern; throws a SyntaxError for an invalid regex. */
export function compileWaitPattern(pattern: string, regex: boolean): string | RegExp {
  return regex ? new RegExp(pattern) : pattern;
}

/**
 * The output a login sequence waits on. It keeps a bounded window of the
 * newest text, so text split across chunks still matches while a stream that
 * never matches cannot grow it — and a regex never runs over more than the
 * window. A match consumes the window up to its end, so the next wait step
 * only sees what came after it.
 */
export class LoginOutputBuffer {
  private readonly stream = new TerminalTextStream();
  private text = '';
  /** Where a literal search may resume: earlier text was already searched. */
  private searched = 0;

  constructor(
    private readonly window = LOGIN_OUTPUT_WINDOW,
    private readonly patternTimeLimitMs = LOGIN_PATTERN_TIME_LIMIT_MS,
  ) {}

  get content(): string {
    return this.text;
  }

  append(data: Uint8Array): void {
    const added = this.stream.write(data);
    if (!added) return;
    this.text += added;
    if (this.text.length > this.window) {
      const dropped = this.text.length - this.window;
      this.text = this.text.slice(dropped);
      this.searched = Math.max(0, this.searched - dropped);
    }
  }

  /** The first match in the window, or undefined. Regexes are bounded in time. */
  find(pattern: string | RegExp): OutputMatch | undefined {
    if (typeof pattern === 'string') {
      if (!pattern) return { end: 0 };
      // Resume a little before the searched end, so a match spanning two chunks is found.
      const from = Math.max(0, this.searched - pattern.length + 1);
      const index = this.text.indexOf(pattern, from);
      this.searched = this.text.length;
      return index < 0 ? undefined : { end: index + pattern.length };
    }
    const match = execWithTimeout(pattern, this.text, this.patternTimeLimitMs);
    return match ? { end: match.index + match[0].length } : undefined;
  }

  /** Drop everything up to `end`, the end of a match. */
  consume(end: number): void {
    this.text = this.text.slice(end);
    this.searched = 0;
  }
}
