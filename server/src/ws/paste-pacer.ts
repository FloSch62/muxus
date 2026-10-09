import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  pastedLineCount,
  pastePacingSteps,
  preparePasteText,
  type PastePacing,
} from '@muxus/shared';

/** Least time between two progress reports of a running paste. */
const PROGRESS_INTERVAL_MS = 200;

export interface PasteRequest extends PastePacing {
  text: string;
  bracketed: boolean;
}

export interface PasteProgress {
  state: 'running' | 'done' | 'cancelled';
  line: number;
  lines: number;
  sent: number;
  total: number;
}

interface QueuedPaste extends PastePacing {
  prepared: string;
  bracketed: boolean;
  lines: number;
}

/**
 * Types pastes into one terminal session at their pace, one paste after the
 * other. The waits run on backend timers, which a hidden or throttled window
 * does not slow down, and each one starts once the transport has taken the
 * write before it, so a slow link cannot eat into the delay.
 */
export class PastePacer {
  private readonly queue: QueuedPaste[] = [];
  private controller: AbortController | undefined;
  private closed = false;
  private sent = 0;
  private total = 0;
  private linesDone = 0;
  private lines = 0;
  private reported = false;
  private lastReportAt = 0;

  constructor(
    private readonly write: (data: Buffer) => Promise<void> | void,
    private readonly report: (progress: PasteProgress) => void,
  ) {}

  enqueue(request: PasteRequest): void {
    if (this.closed) return;
    const prepared = preparePasteText(request.text, request.bracketed);
    if (!prepared) return;
    const lines = pastedLineCount(prepared);
    this.queue.push({
      prepared,
      bracketed: request.bracketed,
      lines,
      lineDelayMs: request.lineDelayMs,
      charDelayMs: request.charDelayMs,
    });
    this.total += prepared.length;
    this.lines += lines;
    if (!this.controller) void this.run();
  }

  /** Stop at the user's request, closing an open bracket so the shell leaves paste mode. */
  cancel(): void {
    this.queue.length = 0;
    this.controller?.abort();
  }

  /** The session is gone: stop without writing or reporting anything more. */
  close(): void {
    this.closed = true;
    this.cancel();
  }

  private async run(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    let bracketOpen = false;
    let failed = false;
    try {
      for (let paste = this.queue.shift(); paste && !signal.aborted; paste = this.queue.shift()) {
        const steps = pastePacingSteps(paste.prepared, paste);
        let step = steps.next();
        while (!step.done && !signal.aborted) {
          const next = steps.next();
          let data = step.value.data;
          if (paste.bracketed && !bracketOpen) {
            data = BRACKETED_PASTE_START + data;
            bracketOpen = true;
          }
          if (paste.bracketed && next.done) {
            data += BRACKETED_PASTE_END;
            bracketOpen = false;
          }
          await untilAborted(this.write(Buffer.from(data, 'utf8')), signal);
          this.sent += step.value.data.length;
          if (step.value.lineEnd) this.linesDone += 1;
          if (step.value.delayMs > 0 && !signal.aborted) {
            this.reportProgress('running');
            await sleep(step.value.delayMs, signal);
          }
          step = next;
        }
      }
    } catch {
      // The transport failed underneath; the session is ending.
      failed = true;
    }
    const cancelled = signal.aborted || failed;
    if (cancelled && bracketOpen && !this.closed && !failed) {
      try {
        await this.write(Buffer.from(BRACKETED_PASTE_END, 'utf8'));
      } catch {
        /* the session is ending */
      }
    }
    this.controller = undefined;
    if (!this.closed && this.reported) this.reportProgress(cancelled ? 'cancelled' : 'done', true);
    this.sent = 0;
    this.linesDone = 0;
    this.reported = false;
    this.total = this.queue.reduce((sum, paste) => sum + paste.prepared.length, 0);
    this.lines = this.queue.reduce((sum, paste) => sum + paste.lines, 0);
    // A paste sent after a cancel but before this run wound down starts afresh.
    if (!this.closed && this.queue.length > 0) void this.run();
  }

  private reportProgress(state: PasteProgress['state'], force = false): void {
    const now = Date.now();
    if (!force && this.reported && now - this.lastReportAt < PROGRESS_INTERVAL_MS) return;
    this.reported = true;
    this.lastReportAt = now;
    this.report({
      state,
      line: Math.min(this.linesDone + 1, this.lines),
      lines: this.lines,
      sent: this.sent,
      total: this.total,
    });
  }
}

/** Settle with the write, or as soon as the paste is stopped. */
function untilAborted(work: Promise<void> | void, signal: AbortSignal): Promise<void> {
  if (!work) return Promise.resolve();
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
