import type { AntiIdle } from '@muxus/shared';

/** How soon a wait that ended while something else was typing looks again. */
const BUSY_RECHECK_MS = 1_000;

export interface AntiIdleIo {
  /** Type into the session the way typed input travels. */
  write(data: Buffer): void;
  /** A paced paste or a login sequence is typing into the session. */
  busy(): boolean;
}

/** What a setting types: its text as is, then Enter only when asked for. */
export function antiIdleInput(setting: AntiIdle): Buffer {
  return Buffer.from(setting.enter ? `${setting.text}\r` : setting.text, 'utf8');
}

/**
 * Types a host's anti-idle text into one session each time it goes a full
 * interval without input. Any input starts the wait over. While a paced
 * paste or a login sequence runs the wait is held, and a full interval
 * starts once it is done, so the text never lands inside either. Time is
 * monotonic, so a wall-clock change cannot delay or hasten a send.
 */
export class AntiIdleTimer {
  private readonly data: Buffer;
  private readonly intervalMs: number;
  private lastInputAt = 0;
  private held = false;
  private startOnInput = false;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    setting: AntiIdle,
    private readonly io: AntiIdleIo,
  ) {
    this.data = antiIdleInput(setting);
    this.intervalMs = setting.intervalSeconds * 1000;
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.startOnInput = false;
    this.lastInputAt = performance.now();
    this.schedule(this.intervalMs);
  }

  /**
   * Start the first wait at the session's first input rather than now, for
   * sessions that log in after they open: one left at a login prompt must not
   * get the text as a username.
   */
  startAfterFirstInput(): void {
    if (this.closed || this.timer) return;
    this.startOnInput = true;
  }

  /** Input reached the session. */
  input(): void {
    if (this.startOnInput) {
      this.start();
      return;
    }
    this.lastInputAt = performance.now();
  }

  /** The session is gone. */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(this.check, ms);
    this.timer.unref?.();
  }

  private readonly check = (): void => {
    this.timer = undefined;
    if (this.closed) return;
    if (this.io.busy()) {
      this.held = true;
      this.schedule(BUSY_RECHECK_MS);
      return;
    }
    const now = performance.now();
    // The first look that finds the hold over starts a full wait, never a shorter one.
    if (this.held) {
      this.held = false;
      this.lastInputAt = now;
    }
    // Input only moves the mark; the timer catches up here rather than per keystroke.
    const idleMs = now - this.lastInputAt;
    if (idleMs < this.intervalMs) {
      this.schedule(this.intervalMs - idleMs);
      return;
    }
    this.io.write(this.data);
    this.lastInputAt = now;
    this.schedule(this.intervalMs);
  };
}
