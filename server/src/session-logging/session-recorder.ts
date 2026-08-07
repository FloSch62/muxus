import type { SessionProfile, SessionLogDirection, SessionLogStatus } from '@muxus/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  MuxusDatabase,
  SessionLogCreateInput,
} from '../persistence/database.js';
import {
  type HistoryEvent,
  SessionHistoryStore,
} from './history-store.js';

export interface SessionLoggingState {
  enabled: boolean;
  sessionId?: string;
  paused: boolean;
  captureInput: boolean;
  warning?: string;
}

/** Stable policy identity for saved hosts and deterministic ad-hoc endpoints. */
export function sessionProfileIdentity(profile: SessionProfile): {
  profileKey: string;
  host: string;
} {
  switch (profile.kind) {
    case 'ssh':
      return {
        profileKey: profile.profileId
          ? `profile:${profile.profileId}`
          : `ssh:${profile.target}`,
        host: profile.target,
      };
    case 'telnet': {
      const host = `${profile.host}:${profile.port}`;
      return {
        profileKey: profile.profileId ? `profile:${profile.profileId}` : `telnet:${host}`,
        host,
      };
    }
    case 'serial':
      return {
        profileKey: profile.profileId ? `profile:${profile.profileId}` : `serial:${profile.path}`,
        host: profile.path,
      };
    case 'local':
      return { profileKey: 'local', host: profile.shell?.trim() || 'Local shell' };
  }
}

/**
 * One durable, timestamped recorder. Persistence errors disable only logging;
 * they never interrupt the user's terminal transport.
 */
export class SessionRecorder {
  readonly state: SessionLoggingState;
  private startedAtMs = Date.now();
  private inputNormalizer = new TerminalTextNormalizer(0);
  private outputNormalizer = new TerminalTextNormalizer();
  private sequence = 0;
  private terminalEnded = false;
  private pending: PendingEvent[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private stateListener: ((state: SessionLoggingState) => void) | undefined;
  private unsubscribeFailure: (() => void) | undefined;

  private constructor(
    private readonly history: SessionHistoryStore,
    private readonly logger: FastifyBaseLogger,
    private readonly policy: ReturnType<MuxusDatabase['sessionLoggingPolicy']>,
    private readonly sessionTemplate: Omit<
      SessionLogCreateInput,
      'startedAt' | 'captureInput'
    >,
    state: SessionLoggingState,
  ) {
    this.state = state;
  }

  static start(
    database: MuxusDatabase,
    history: SessionHistoryStore,
    logger: FastifyBaseLogger,
    profile: SessionProfile,
    title?: string,
  ): SessionRecorder {
    const identity = sessionProfileIdentity(profile);
    const policy = database.sessionLoggingPolicy(identity.profileKey);
    const recorder = new SessionRecorder(
      history,
      logger,
      policy,
      {
        profileKey: identity.profileKey,
        title: title?.trim() || identity.host,
        kind: profile.kind,
        host: identity.host,
      },
      {
        enabled: false,
        paused: false,
        captureInput: policy.captureInput,
      },
    );
    if (policy.enabled) recorder.startLogging();
    return recorder;
  }

  private startLogging(): void {
    if (this.state.enabled || this.terminalEnded) return;
    const startedAt = new Date().toISOString();
    this.startedAtMs = Date.parse(startedAt);
    this.inputNormalizer = new TerminalTextNormalizer(0);
    this.outputNormalizer = new TerminalTextNormalizer();
    this.sequence = 0;
    this.pending = [];
    this.state.enabled = true;
    this.state.sessionId = this.history.beginSession(
      {
        ...this.sessionTemplate,
        startedAt,
        captureInput: this.state.captureInput,
      },
      this.policy,
    );
    this.state.paused = false;
    this.state.warning = undefined;
    this.unsubscribeFailure = this.history.onSessionFailure(
      this.state.sessionId,
      (message) => this.suspend(message),
    );
    this.system('Session logging started.');
  }

  private finishLogging(
    status: Exclude<SessionLogStatus, 'active'>,
    marker: string,
  ): void {
    if (!this.state.enabled || !this.state.sessionId) return;
    // A closing marker is useful in a replay even if the session was paused.
    this.state.paused = false;
    this.flushNormalizerSnapshots(true);
    this.system(marker);
    this.state.enabled = false;
    this.state.paused = false;
    this.history.finishSession(
      this.state.sessionId,
      status,
      new Date().toISOString(),
    );
    this.unsubscribeFailure?.();
    this.unsubscribeFailure = undefined;
  }

  onStateChange(listener: (state: SessionLoggingState) => void): void {
    this.stateListener = listener;
  }

  input(data: Buffer): void {
    if (
      !this.state.enabled ||
      this.state.paused ||
      this.terminalEnded ||
      !this.state.captureInput
    ) return;
    this.flushOutputNormalizerSnapshot();
    this.append('input', data, this.inputNormalizer.write(data));
  }

  output(data: Buffer | string): void {
    if (!this.state.enabled || this.state.paused || this.terminalEnded) return;
    if (this.state.captureInput) this.flushInputNormalizerSnapshot();
    const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.append('output', raw, this.outputNormalizer.write(raw));
  }

  system(message: string): void {
    // Markers must follow every normalized row that was visible before them,
    // even when the reconciler was still retaining an editable shell prompt.
    this.flushNormalizerSnapshots();
    const text = `${message}\n`;
    this.appendNow('system', Buffer.from(text, 'utf8'), text);
  }

  setState(patch: {
    enabled?: boolean;
    paused?: boolean;
    captureInput?: boolean;
  }): SessionLoggingState {
    if (this.terminalEnded) return { ...this.state };
    if (patch.enabled === false && this.state.enabled) {
      this.finishLogging('completed', 'Session logging stopped.');
      return { ...this.state };
    }
    if (patch.enabled === true && !this.state.enabled) this.startLogging();
    if (!this.state.enabled) return { ...this.state };
    if (patch.paused !== undefined && patch.paused !== this.state.paused) {
      if (patch.paused) {
        this.flushNormalizerSnapshots();
        this.system('Session logging paused.');
        this.state.paused = true;
      } else {
        this.state.paused = false;
        this.system('Session logging resumed.');
      }
    }
    if (
      patch.captureInput !== undefined &&
      patch.captureInput !== this.state.captureInput
    ) {
      if (!patch.captureInput) this.flushInputNormalizerSnapshot();
      this.state.captureInput = patch.captureInput;
      this.system(
        patch.captureInput
          ? 'Input recording enabled.'
          : 'Input recording suppressed.',
      );
    }
    this.history.setSessionState(this.state.sessionId!, {
      paused: this.state.paused,
      captureInput: this.state.captureInput,
    });
    return { ...this.state };
  }

  end(status: Exclude<SessionLogStatus, 'active'>): void {
    if (this.terminalEnded) return;
    this.finishLogging(status, `Session logging ended (${status}).`);
    this.terminalEnded = true;
  }

  private append(
    direction: SessionLogDirection,
    raw: Buffer,
    normalized?: string,
  ): void {
    const text = normalized ?? raw.toString('utf8');
    if (
      !this.state.enabled ||
      this.state.paused ||
      this.terminalEnded ||
      (raw.byteLength === 0 && text.length === 0)
    ) return;
    const recordedAt = new Date().toISOString();
    const elapsedMs = Math.max(0, Date.parse(recordedAt) - this.startedAtMs);
    const previous = this.pending.at(-1);
    if (
      previous?.direction === direction &&
      previous.rawBytes + raw.byteLength <= MAX_BUFFERED_EVENT_BYTES
    ) {
      previous.raw.push(raw);
      previous.text.push(text);
      previous.rawBytes += raw.byteLength;
    } else {
      this.pending.push({
        sequence: ++this.sequence,
        recordedAt,
        elapsedMs,
        direction,
        raw: [raw],
        text: [text],
        rawBytes: raw.byteLength,
      });
    }
    if (raw.byteLength >= MAX_BUFFERED_EVENT_BYTES) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  private appendNow(
    direction: SessionLogDirection,
    raw: Buffer,
    text: string,
  ): void {
    if (
      !this.state.enabled ||
      this.state.paused ||
      this.terminalEnded ||
      (raw.byteLength === 0 && text.length === 0)
    ) return;
    const recordedAt = new Date().toISOString();
    this.persist([{
      sequence: ++this.sequence,
      recordedAt,
      elapsedMs: Math.max(0, Date.parse(recordedAt) - this.startedAtMs),
      direction,
      raw,
      text,
    }]);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const pending = this.pending;
    this.pending = [];
    const events = pending.map((event): HistoryEvent => ({
        sequence: event.sequence,
        recordedAt: event.recordedAt,
        elapsedMs: event.elapsedMs,
        direction: event.direction,
        raw:
          event.raw.length === 1
            ? event.raw[0]!
            : Buffer.concat(event.raw, event.rawBytes),
        text: event.text.join(''),
      }));
    if (events.length > 0) this.persist(events);
  }

  private persist(events: HistoryEvent[]): void {
    if (!this.history.append(this.state.sessionId!, events, this.policy)) {
      this.suspend('Session logging suspended: the history write queue is full.');
    }
  }

  private flushNormalizerSnapshots(final = false): void {
    this.flush();
    const input = final ? this.inputNormalizer.finish() : this.inputNormalizer.drain();
    const output = final ? this.outputNormalizer.finish() : this.outputNormalizer.drain();
    if (input) this.appendNow('input', Buffer.alloc(0), input);
    if (output) this.appendNow('output', Buffer.alloc(0), output);
  }

  private flushInputNormalizerSnapshot(): void {
    this.flush();
    const input = this.inputNormalizer.drain();
    if (input) this.appendNow('input', Buffer.alloc(0), input);
  }

  private flushOutputNormalizerSnapshot(): void {
    this.flush();
    const output = this.outputNormalizer.drain();
    if (output) this.appendNow('output', Buffer.alloc(0), output);
  }

  private suspend(message: string): void {
    if (!this.state.enabled || this.terminalEnded) return;
    this.state.enabled = false;
    this.state.paused = false;
    this.state.warning = message;
    this.pending = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.history.finishSession(
      this.state.sessionId!,
      'failed',
      new Date().toISOString(),
    );
    this.unsubscribeFailure?.();
    this.unsubscribeFailure = undefined;
    this.logger.warn(
      { sessionId: this.state.sessionId, reason: message },
      'terminal session logging suspended',
    );
    this.stateListener?.({ ...this.state });
  }
}

const FLUSH_INTERVAL_MS = 250;
const MAX_BUFFERED_EVENT_BYTES = 256 * 1024;

interface PendingEvent {
  sequence: number;
  recordedAt: string;
  elapsedMs: number;
  direction: SessionLogDirection;
  raw: Buffer[];
  text: string[];
  rawBytes: number;
}

/**
 * Small streaming terminal-line reconciler used only for search and readable
 * transcripts. It applies the cursor/erase operations used by shells and
 * progress displays, retaining a few editable rows so prompt redraws replace
 * their earlier state instead of becoming duplicate transcript lines. The
 * original byte events remain untouched for exact export.
 */
export class TerminalTextNormalizer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private state:
    | 'text'
    | 'escape'
    | 'escape-intermediate'
    | 'csi'
    | 'string'
    | 'string-escape' = 'text';
  private csi = '';
  private rows: string[][] = [[]];
  private cursorRow = 0;
  private cursorCol = 0;
  private savedCursor: [number, number] = [0, 0];
  private committed = '';

  constructor(private readonly editableRows = 4) {}

  write(data: Uint8Array): string {
    this.process(this.decoder.decode(data, { stream: true }));
    this.commitReadyRows();
    return this.takeCommitted();
  }

  /** Flush the currently visible rows and start a fresh transcript screen. */
  drain(): string {
    this.commitAllRows();
    this.resetRows();
    return this.takeCommitted();
  }

  /** Final decoder flush plus all still-editable rows at session end. */
  finish(): string {
    this.process(this.decoder.decode());
    return this.drain();
  }

  private process(decoded: string): void {
    for (const char of decoded) {
      const code = char.codePointAt(0)!;
      if (this.state === 'text') {
        if (code === 0x1b) {
          this.state = 'escape';
          continue;
        }
        if (char === '\r') {
          this.cursorCol = 0;
          continue;
        }
        if (char === '\n') {
          this.cursorRow += 1;
          this.ensureRow(this.cursorRow);
          continue;
        }
        if (char === '\b') {
          this.cursorCol = Math.max(0, this.cursorCol - 1);
          continue;
        }
        if (char === '\t') {
          const spaces = 8 - (this.cursorCol % 8);
          for (let index = 0; index < spaces; index += 1) this.put(' ');
          continue;
        }
        if (code >= 0x20 && code !== 0x7f) this.put(char);
        continue;
      }

      if (this.state === 'escape') {
        if (char === '[') {
          this.csi = '';
          this.state = 'csi';
        }
        else if (char === ']' || char === 'P' || char === '_' || char === '^') {
          this.state = 'string';
        } else if (code >= 0x20 && code <= 0x2f) {
          this.state = 'escape-intermediate';
        } else {
          this.handleEscape(char);
          this.state = 'text';
        }
        continue;
      }
      if (this.state === 'escape-intermediate') {
        if (code >= 0x30 && code <= 0x7e) this.state = 'text';
        continue;
      }
      if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          this.handleCsi(char);
          this.csi = '';
          this.state = 'text';
        } else {
          this.csi += char;
        }
        continue;
      }
      if (this.state === 'string') {
        if (code === 0x07) this.state = 'text';
        else if (code === 0x1b) this.state = 'string-escape';
        continue;
      }
      if (this.state === 'string-escape') {
        this.state = char === '\\' ? 'text' : char === '\x1b' ? 'string-escape' : 'string';
      }
    }
  }

  private put(char: string): void {
    const row = this.ensureRow(this.cursorRow);
    while (row.length < this.cursorCol) row.push(' ');
    row[this.cursorCol] = char;
    this.cursorCol += 1;
  }

  private handleEscape(final: string): void {
    if (final === '7') {
      this.savedCursor = [this.cursorRow, this.cursorCol];
      return;
    }
    if (final === '8') {
      [this.cursorRow, this.cursorCol] = this.savedCursor;
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'D') {
      this.cursorRow += 1;
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'E') {
      this.cursorRow += 1;
      this.cursorCol = 0;
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'M') {
      this.cursorRow = Math.max(0, this.cursorRow - 1);
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'c') this.resetRows();
  }

  private handleCsi(final: string): void {
    const privateMode = /^[?>]/.test(this.csi);
    const raw = this.csi.replace(/^[?>]/, '');
    const params = raw
      .split(';')
      .map((value) => (value === '' ? 0 : Number.parseInt(value, 10)))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const first = params[0] ?? 0;
    const amount = Math.max(1, first);

    if (privateMode && (final === 'h' || final === 'l')) return;
    switch (final) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - amount);
        break;
      case 'B':
        this.cursorRow += amount;
        break;
      case 'C':
        this.cursorCol += amount;
        break;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - amount);
        break;
      case 'E':
        this.cursorRow += amount;
        this.cursorCol = 0;
        break;
      case 'F':
        this.cursorRow = Math.max(0, this.cursorRow - amount);
        this.cursorCol = 0;
        break;
      case 'G':
      case '`':
        this.cursorCol = Math.max(0, amount - 1);
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, (params[0] || 1) - 1);
        this.cursorCol = Math.max(0, (params[1] || 1) - 1);
        break;
      case 'd':
        this.cursorRow = Math.max(0, amount - 1);
        break;
      case 'J':
        this.eraseDisplay(first);
        break;
      case 'K':
        this.eraseLine(first);
        break;
      case 'P':
        this.ensureRow(this.cursorRow).splice(this.cursorCol, amount);
        break;
      case '@':
        this.ensureRow(this.cursorRow).splice(
          this.cursorCol,
          0,
          ...Array.from({ length: amount }, () => ' '),
        );
        break;
      case 'X': {
        const row = this.ensureRow(this.cursorRow);
        for (let index = 0; index < amount; index += 1) {
          if (this.cursorCol + index < row.length) row[this.cursorCol + index] = ' ';
        }
        break;
      }
      case 's':
        this.savedCursor = [this.cursorRow, this.cursorCol];
        break;
      case 'u':
        [this.cursorRow, this.cursorCol] = this.savedCursor;
        break;
    }
    this.ensureRow(this.cursorRow);
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      // A deliberate clear still belongs to searchable history, while the
      // following screen starts without stale editable prompt fragments.
      this.commitAllRows();
      this.resetRows();
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      this.rows.splice(this.cursorRow + 1);
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row += 1) this.rows[row] = [];
      this.eraseLine(1);
    }
  }

  private eraseLine(mode: number): void {
    const row = this.ensureRow(this.cursorRow);
    if (mode === 2) {
      this.rows[this.cursorRow] = [];
      return;
    }
    if (mode === 1) {
      const end = Math.min(this.cursorCol, row.length - 1);
      for (let index = 0; index <= end; index += 1) row[index] = ' ';
      return;
    }
    row.splice(this.cursorCol);
  }

  private ensureRow(index: number): string[] {
    while (this.rows.length <= index) this.rows.push([]);
    return this.rows[index]!;
  }

  private commitReadyRows(): void {
    const count = Math.max(0, this.cursorRow - this.editableRows);
    for (let index = 0; index < count; index += 1) {
      this.committed += `${lineText(this.rows[index]!)}\n`;
    }
    if (count === 0) return;
    this.rows.splice(0, count);
    this.cursorRow -= count;
    this.savedCursor = [
      Math.max(0, this.savedCursor[0] - count),
      this.savedCursor[1],
    ];
  }

  private commitAllRows(): void {
    let last = this.rows.length - 1;
    while (last >= 0 && lineText(this.rows[last]!) === '') last -= 1;
    if (last < 0) return;
    for (let index = 0; index <= last; index += 1) {
      this.committed += lineText(this.rows[index]!);
      if (index < last || last < this.rows.length - 1) this.committed += '\n';
    }
  }

  private resetRows(): void {
    this.rows = [[]];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.savedCursor = [0, 0];
  }

  private takeCommitted(): string {
    const output = this.committed;
    this.committed = '';
    return output;
  }
}

function lineText(row: readonly string[]): string {
  let end = row.length;
  while (end > 0 && row[end - 1] === ' ') end -= 1;
  return row.slice(0, end).join('');
}
