import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  pastedLineCount,
  pastePacingSteps,
  preparePasteText,
  type PastePacing,
} from '@muxus/shared';
import { pastedLineText, PastePromptWatch, type PromptWatchResult } from './paste-prompt.js';

/** Least time between two progress reports of a running paste. */
const PROGRESS_INTERVAL_MS = 200;

export interface PasteRequest extends PastePacing {
  text: string;
  bracketed: boolean;
}

export interface PasteProgress {
  state: 'running' | 'done' | 'cancelled' | 'stopped';
  line: number;
  lines: number;
  sent: number;
  total: number;
  /** Why a stopped paste stopped. */
  message?: string;
  /** Numbers the session's stopped pastes, so a returning window can tell a stop it has noted. */
  stopId?: number;
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
 * write before it, so a slow link cannot eat into the delay. A paste that
 * waits for the prompt reads the session's output after each line instead,
 * and stops at the first line the device rejects.
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
  /** Reads output while a paste that waits for the prompt runs. */
  private watch: PastePromptWatch | undefined;
  private wake: (() => void) | undefined;
  private checkQueued = false;
  private stops = 0;

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
      // A bracketed paste reaches the program whole, with no prompt after each line.
      prompt: request.bracketed ? undefined : request.prompt,
    });
    // A cancelled run still winding down recounts the queue for the run after it.
    if (!this.controller?.signal.aborted) {
      this.total += prepared.length;
      this.lines += lines;
    }
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

  /** Output from the session; only a paste waiting for the prompt reads it. */
  output(data: Uint8Array): void {
    if (!this.watch) return;
    this.watch.append(data);
    // Checked once per event-loop turn, so a flood of small chunks costs one match.
    if (!this.wake || this.checkQueued) return;
    this.checkQueued = true;
    setImmediate(() => {
      this.checkQueued = false;
      this.wake?.();
    });
  }

  private async run(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    // Why the paste stopped by itself; nothing after it, queued pastes included, is sent.
    let stopped: string | undefined;
    const stop = (message: string) => {
      stopped = message;
      this.queue.length = 0;
      controller.abort();
    };
    let bracketOpen = false;
    let failed = false;
    try {
      // A paste sent in the same tick as a cancel stays queued for the next run.
      while (!signal.aborted) {
        const paste = this.queue.shift();
        if (!paste) break;
        const steps = pastePacingSteps(paste.prepared, paste);
        let step = steps.next();
        this.watch = undefined;
        try {
          if (paste.prompt) this.watch = new PastePromptWatch(paste.prompt);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          stop(`The prompt or error pattern cannot be used: ${reason}`);
        }
        // Set once this paste has sent a line, whose answer can still come while the next is typed.
        let answering: PastePromptWatch | undefined;
        // The line being typed, and the last one sent whole: the line the output read now answers.
        let typed = '';
        let sentLine = { number: 0, text: '' };
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
          // Only output from here on answers this line.
          const watch = step.value.lineEnd ? this.watch : undefined;
          watch?.reset();
          await untilAborted(this.write(Buffer.from(data, 'utf8')), signal);
          this.sent += step.value.data.length;
          typed += step.value.data;
          if (step.value.lineEnd) {
            this.linesDone += 1;
            sentLine = { number: sentLine.number + 1, text: typed };
            typed = '';
          }
          let answer: PromptWatchResult | undefined;
          if (watch && paste.prompt && !signal.aborted) {
            answering = watch;
            this.reportProgress('running');
            const { timeoutMs } = paste.prompt;
            answer = await this.waitForPrompt(watch, timeoutMs, step.value.delayMs, signal);
          } else if (step.value.delayMs > 0 && !signal.aborted) {
            this.reportProgress('running');
            if (answering) answer = await this.readAnswer(answering, step.value.delayMs, false, signal);
            else await sleep(step.value.delayMs, signal);
          }
          const problem = stopReason(answer, sentLine.number, paste.lines, sentLine.text);
          if (problem) stop(problem);
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
    this.watch = undefined;
    if (!this.closed && stopped !== undefined) {
      this.report({
        state: 'stopped',
        line: this.linesDone,
        lines: this.lines,
        sent: this.sent,
        total: this.total,
        message: stopped,
        stopId: ++this.stops,
      });
    } else if (!this.closed && this.reported) {
      this.reportProgress(cancelled ? 'cancelled' : 'done', true);
    }
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

  /**
   * Wait for the answer to the line just sent: the prompt, an error line or a
   * failing pattern ends the wait. Without the prompt in time, the line falls
   * back to its fixed delay, and an error that comes meanwhile still counts.
   */
  private async waitForPrompt(
    watch: PastePromptWatch,
    timeoutMs: number,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<PromptWatchResult | undefined> {
    const answer = await this.readAnswer(watch, timeoutMs, true, signal);
    if (answer || signal.aborted || delayMs <= timeoutMs) return answer;
    return this.readAnswer(watch, delayMs - timeoutMs, false, signal);
  }

  /** Read the answer for up to `ms`; the prompt is looked for only while it is awaited. */
  private readAnswer(
    watch: PastePromptWatch,
    ms: number,
    untilPrompt: boolean,
    signal: AbortSignal,
  ): Promise<PromptWatchResult | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), ms);
      const settle = (result: PromptWatchResult | undefined) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.wake = undefined;
        resolve(result);
      };
      const onAbort = () => settle(undefined);
      const check = () => {
        const result = watch.check(untilPrompt);
        if (result) settle(result);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.wake = check;
      check();
    });
  }
}

/** Why a paste has to stop at this answer to its line `line` of `lines`, if it does. */
function stopReason(
  answer: PromptWatchResult | undefined,
  line: number,
  lines: number,
  text: string,
): string | undefined {
  if (answer?.kind !== 'error' && answer?.kind !== 'failed') return undefined;
  const quoted = pastedLineText(text);
  const sent = `Line ${line} of ${lines}${quoted ? ` (“${quoted}”)` : ''}`;
  return answer.kind === 'error'
    ? `${sent} was answered with “${answer.line}”`
    : `${sent}: ${answer.message}.`;
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
