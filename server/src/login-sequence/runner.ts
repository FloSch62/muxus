import type { LoginSequenceStep } from '@muxus/shared';
import {
  compileWaitPattern,
  LoginOutputBuffer,
  PatternTimeoutError,
} from './output-matcher.js';

export interface LoginSequenceProgress {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** 1-based step that is running, or where the sequence stopped. */
  step: number;
  steps: number;
  detail: string;
  message?: string;
}

export type LoginSequenceOutcome =
  | { state: 'done' }
  | { state: 'failed'; step: number; message: string }
  | { state: 'cancelled'; step: number }
  /** The session ended while the sequence ran; nobody is left to tell. */
  | { state: 'closed' };

/** Why a vault step could not type its secret, or undefined once it did. */
export type SecretStepResult = string | undefined;

export interface LoginSequenceIo {
  /** Type bytes into the session, past session logging; false once the session is gone. */
  write(data: Buffer): boolean;
  /** Plain text a send step typed, for input capture. Secrets never pass through here. */
  typed(data: Buffer): void;
  /** Type a vault secret, asking for the master password when the vault needs it. */
  typeSecret(secretId: string, enter: boolean, signal: AbortSignal): Promise<SecretStepResult>;
  progress(update: LoginSequenceProgress): void;
}

class StepStopped extends Error {
  constructor(readonly outcome: Exclude<LoginSequenceOutcome, { state: 'done' }>) {
    super(outcome.state);
  }
}

const LABEL_MAX = 60;

function quoted(text: string): string {
  const flat = text.replace(/\p{Cc}+/gu, ' ');
  return `“${flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat}”`;
}

/** What a step does, as the tab shows it while the step runs. */
export function describeLoginStep(step: LoginSequenceStep, secretName?: string): string {
  switch (step.kind) {
    case 'wait':
      return step.regex ? `Waiting for a match of ${quoted(step.pattern)}` : `Waiting for ${quoted(step.pattern)}`;
    case 'send':
      if (!step.text) return 'Pressing Enter';
      return `Typing ${quoted(step.text)}${step.enter ? ' and Enter' : ''}`;
    case 'secret':
      return `Typing the secret ${quoted(secretName ?? 'from the password vault')}${step.enter ? ' and Enter' : ''}`;
  }
}

/**
 * Runs one login sequence over a live session. Output is fed in as it
 * arrives — from the moment the session attaches, so a banner sent before the
 * first step starts still counts — and each wait step consumes what it
 * matched. Checks are coalesced to once per event-loop turn, so a flood of
 * small chunks costs one match attempt rather than one per chunk.
 */
export class LoginSequenceRunner {
  private readonly buffer: LoginOutputBuffer;
  private readonly controller = new AbortController();
  private wake: (() => void) | undefined;
  private checkQueued = false;
  private running = true;

  constructor(
    private readonly steps: readonly LoginSequenceStep[],
    private readonly io: LoginSequenceIo,
    private readonly options: {
      secretName?: (secretId: string) => string | undefined;
      buffer?: LoginOutputBuffer;
    } = {},
  ) {
    this.buffer = options.buffer ?? new LoginOutputBuffer();
  }

  output(data: Uint8Array): void {
    if (!this.running) return;
    this.buffer.append(data);
    if (!this.wake || this.checkQueued) return;
    this.checkQueued = true;
    setImmediate(() => {
      this.checkQueued = false;
      this.wake?.();
    });
  }

  /** Stop at the current step at the user's request; the session stays open. */
  cancel(): void {
    if (this.running) this.controller.abort('cancelled');
  }

  /** The session ended: stop quietly. */
  close(): void {
    if (this.running) this.controller.abort('closed');
  }

  async run(): Promise<LoginSequenceOutcome> {
    const total = this.steps.length;
    let current = 0;
    let detail = '';
    try {
      for (const [index, step] of this.steps.entries()) {
        current = index + 1;
        this.throwIfStopped(current);
        detail = describeLoginStep(
          step,
          step.kind === 'secret' ? this.options.secretName?.(step.secretId) : undefined,
        );
        this.io.progress({ state: 'running', step: current, steps: total, detail });
        await this.runStep(step, current);
      }
      this.finish({ state: 'done', step: total, steps: total, detail });
      return { state: 'done' };
    } catch (err) {
      if (!(err instanceof StepStopped)) throw err;
      const outcome = err.outcome;
      if (outcome.state === 'failed') {
        this.finish({ state: 'failed', step: current, steps: total, detail, message: outcome.message });
      } else if (outcome.state === 'cancelled') {
        this.finish({ state: 'cancelled', step: current, steps: total, detail });
      } else {
        this.running = false;
      }
      return outcome;
    }
  }

  private finish(update: LoginSequenceProgress): void {
    this.running = false;
    this.wake = undefined;
    this.io.progress(update);
  }

  private stopped(step: number): StepStopped | undefined {
    const signal = this.controller.signal;
    if (!signal.aborted) return undefined;
    return new StepStopped(signal.reason === 'cancelled' ? { state: 'cancelled', step } : { state: 'closed' });
  }

  private throwIfStopped(step: number): void {
    const stopped = this.stopped(step);
    if (stopped) throw stopped;
  }

  private async runStep(step: LoginSequenceStep, number: number): Promise<void> {
    switch (step.kind) {
      case 'wait':
        return this.waitFor(step, number);
      case 'send': {
        const data = Buffer.from(step.enter ? `${step.text}\r` : step.text, 'utf8');
        if (data.length === 0) return;
        if (!this.io.write(data)) throw new StepStopped({ state: 'closed' });
        this.io.typed(data);
        return;
      }
      case 'secret': {
        let problem: SecretStepResult;
        try {
          problem = await this.io.typeSecret(step.secretId, step.enter, this.controller.signal);
        } catch (err) {
          problem = err instanceof Error ? err.message : String(err);
        }
        this.throwIfStopped(number);
        if (problem) throw new StepStopped({ state: 'failed', step: number, message: `Step ${number}: ${problem}` });
        return;
      }
    }
  }

  private waitFor(
    step: Extract<LoginSequenceStep, { kind: 'wait' }>,
    number: number,
  ): Promise<void> {
    let pattern: string | RegExp;
    try {
      pattern = compileWaitPattern(step.pattern, step.regex === true);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return Promise.reject(
        new StepStopped({ state: 'failed', step: number, message: `Step ${number} has an invalid pattern: ${reason}` }),
      );
    }
    const signal = this.controller.signal;
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: StepStopped) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.wake = undefined;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => settle(this.stopped(number));
      const check = () => {
        try {
          const match = this.buffer.find(pattern);
          if (!match) return;
          this.buffer.consume(match.end);
          settle();
        } catch (err) {
          const message =
            err instanceof PatternTimeoutError
              ? `Step ${number}'s pattern took too long to match, so it was stopped.`
              : `Step ${number} could not match: ${err instanceof Error ? err.message : String(err)}`;
          settle(new StepStopped({ state: 'failed', step: number, message }));
        }
      };
      const timer = setTimeout(() => {
        settle(
          new StepStopped({
            state: 'failed',
            step: number,
            message: `Step ${number} timed out after ${step.timeoutSeconds} s ${describeLoginStep(step).replace(/^W/, 'w')}.`,
          }),
        );
      }, step.timeoutSeconds * 1000);
      timer.unref?.();
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.wake = check;
      check();
    });
  }
}
