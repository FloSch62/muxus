import {
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  type WriteStream,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sessionLogFileName,
  type SessionLineTimestamp,
  type SessionLogFileNameValues,
  type SessionLogFileSettings,
} from '@muxus/shared';
import { TerminalTextNormalizer } from './terminal-text-normalizer.js';

/** Where log files go when no folder is configured. */
export function defaultSessionLogDirectory(): string {
  return path.join(os.homedir(), 'Documents', 'Muxus', 'Logs');
}

export function sessionLogDirectory(settings: SessionLogFileSettings): string {
  return settings.directory ?? defaultSessionLogDirectory();
}

/** The file a log started now would be named, from the folder and name pattern. */
export function sessionLogFilePath(
  settings: SessionLogFileSettings,
  values: SessionLogFileNameValues,
): string {
  return path.join(
    sessionLogDirectory(settings),
    ...sessionLogFileName(settings.filenamePattern, values),
  );
}

/** `file` itself, or `file-1`, `file-2` … when it already exists. */
export function unusedSessionLogFilePath(file: string): string {
  let candidate = file;
  for (let attempt = 1; existsSync(candidate) && attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    candidate = numberedPath(file, attempt);
  }
  return candidate;
}

/**
 * A plain-text transcript written while the session runs. It is normalized
 * like the clean log in session history, but streamed to a file of the user's
 * choosing so it is complete the moment the session ends, and readable if
 * Muxus never gets to end it.
 */
export class SessionLogFile {
  private readonly inputNormalizer = new TerminalTextNormalizer(0);
  private readonly outputNormalizer = new TerminalTextNormalizer();
  private pending = '';
  private lineStart = true;
  private flushTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private failed = false;
  private failureListener: ((error: Error) => void) | undefined;

  private constructor(
    readonly path: string,
    private readonly stream: WriteStream,
    private readonly timestamps: boolean,
  ) {
    stream.on('error', (error) => this.fail(error));
  }

  /**
   * Open `file` for writing. A file the user picked is appended to; a
   * generated name never reuses an existing file and gets a number instead.
   */
  static open(
    file: string,
    options: { append: boolean; timestamps: boolean },
  ): SessionLogFile {
    if (!path.isAbsolute(file)) throw new Error('the log file path must be absolute');
    mkdirSync(path.dirname(file), { recursive: true });
    const opened = options.append ? { file, fd: openSync(file, 'a', 0o600) } : openNew(file);
    const log = new SessionLogFile(
      opened.file,
      createWriteStream(opened.file, { fd: opened.fd, encoding: 'utf8' }),
      options.timestamps,
    );
    // Keep an earlier log in the same file on its own lines.
    if (options.append && fstatSync(opened.fd).size > 0) log.pending = '\n';
    return log;
  }

  /** Called once if a write fails, even after close; the file is closed by then. */
  onFailure(listener: (error: Error) => void): void {
    this.failureListener = listener;
  }

  input(data: Buffer): void {
    if (this.closed) return;
    this.drainOutput();
    this.write(this.inputNormalizer.write(data), this.inputNormalizer.takeLineTimestamps());
  }

  output(data: Buffer): void {
    if (this.closed) return;
    this.drainInput();
    this.write(this.outputNormalizer.write(data), this.outputNormalizer.takeLineTimestamps());
  }

  /** A status line of Muxus' own, always on a line of its own. */
  system(message: string): void {
    if (this.closed) return;
    this.drainInput();
    this.drainOutput();
    if (!this.lineStart) this.write('\n');
    this.write(`${message}\n`);
  }

  /** Write the rows still on screen and the closing line, then close the file. */
  close(message: string): void {
    if (this.closed) return;
    this.write(this.inputNormalizer.finish(), this.inputNormalizer.takeLineTimestamps());
    this.write(this.outputNormalizer.finish(), this.outputNormalizer.takeLineTimestamps());
    this.system(message);
    this.closed = true;
    this.flush();
    if (!this.failed) this.stream.end();
  }

  private drainInput(): void {
    this.write(this.inputNormalizer.drain(), this.inputNormalizer.takeLineTimestamps());
  }

  private drainOutput(): void {
    this.write(this.outputNormalizer.drain(), this.outputNormalizer.takeLineTimestamps());
  }

  /** Same line prefixes as the timestamped clean log in session history. */
  private write(
    text: string,
    lineTimestamps: SessionLineTimestamp[] = [],
    recordedAt = new Date().toISOString(),
  ): void {
    if (!text) return;
    if (this.timestamps) {
      let stampIndex = 0;
      let stamp = recordedAt;
      for (let start = 0; start < text.length;) {
        while (lineTimestamps[stampIndex] && lineTimestamps[stampIndex]!.offset <= start) {
          stamp = lineTimestamps[stampIndex++]!.recordedAt;
        }
        const newline = text.indexOf('\n', start);
        const end = newline === -1 ? text.length : newline + 1;
        this.pending += (this.lineStart ? `[${stamp}] ` : '') + text.slice(start, end);
        this.lineStart = newline !== -1;
        start = end;
      }
    } else {
      this.pending += text;
    }
    this.lineStart = text.endsWith('\n');
    if (this.pending.length >= FLUSH_CHARS) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.pending || this.stream.destroyed) return;
    this.stream.write(this.pending);
    this.pending = '';
    // A stalled disk must not grow memory without bound.
    if (this.stream.writableLength > MAX_QUEUED_BYTES) {
      this.fail(new Error('the disk is not keeping up'));
    }
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.closed = true;
    this.pending = '';
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.stream.destroy();
    this.failureListener?.(error);
  }
}

const FLUSH_INTERVAL_MS = 250;
const FLUSH_CHARS = 64 * 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_NAME_ATTEMPTS = 999;

function openNew(file: string): { file: string; fd: number } {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? file : numberedPath(file, attempt);
    try {
      return { file: candidate, fd: openSync(candidate, 'wx', 0o600) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= MAX_NAME_ATTEMPTS) {
        throw err;
      }
    }
  }
}

function numberedPath(file: string, number: number): string {
  const extension = path.extname(file);
  return `${file.slice(0, file.length - extension.length)}-${number}${extension}`;
}
