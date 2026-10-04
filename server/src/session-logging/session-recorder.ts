import type {
  SessionLineTimestamp,
  SessionLogDirection,
  SessionLogStatus,
  TerminalProfile,
} from '@muxus/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  MuxusDatabase,
  SessionLogCreateInput,
} from '../persistence/database.js';
import {
  type HistoryEvent,
  SessionHistoryStore,
} from './history-store.js';
import { SessionLogFile, sessionLogFilePath } from './session-log-file.js';
import { TerminalTextNormalizer } from './terminal-text-normalizer.js';

export interface SessionLoggingState {
  enabled: boolean;
  sessionId?: string;
  paused: boolean;
  captureInput: boolean;
  warning?: string;
  /** Plain-text log file currently written for this session. */
  filePath?: string;
}

/** Stable policy identity for saved hosts and deterministic ad-hoc endpoints. */
export function sessionProfileIdentity(profile: TerminalProfile): {
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
 * One durable, timestamped recorder. It feeds session history and, on its
 * own schedule, a plain-text log file; pausing and input capture apply to
 * both. Persistence errors disable only logging; they never interrupt the
 * user's terminal transport.
 */
export class SessionRecorder {
  readonly state: SessionLoggingState;
  private file: SessionLogFile | undefined;
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
    private readonly database: MuxusDatabase,
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
    profile: TerminalProfile,
    title?: string,
  ): SessionRecorder {
    const identity = sessionProfileIdentity(profile);
    const policy = database.sessionLoggingPolicy(identity.profileKey);
    const recorder = new SessionRecorder(
      database,
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
    if (policy.logToFile) recorder.startFileLog();
    return recorder;
  }

  private startLogging(): void {
    if (this.state.enabled || this.terminalEnded) return;
    // Only a log file can be paused here; the new record joins the pause.
    const paused = this.state.paused;
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
    this.historySystem('Session logging started.');
    if (paused) {
      this.historySystem('Session logging paused.');
      this.state.paused = true;
      this.history.setSessionState(this.state.sessionId, {
        paused: true,
        captureInput: this.state.captureInput,
      });
    }
  }

  private finishLogging(
    status: Exclude<SessionLogStatus, 'active'>,
    marker: string,
  ): void {
    if (!this.state.enabled || !this.state.sessionId) return;
    // A closing marker is useful in a replay even if the session was paused.
    const paused = this.state.paused;
    this.state.paused = false;
    this.flushNormalizerSnapshots(true);
    this.historySystem(marker);
    this.state.enabled = false;
    // A log file that is still written stays paused.
    this.state.paused = paused && this.file !== undefined;
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
    if (this.state.paused || this.terminalEnded || !this.state.captureInput) return;
    this.file?.input(data);
    if (!this.state.enabled) return;
    this.flushOutputNormalizerSnapshot();
    const text = this.inputNormalizer.write(data);
    this.append('input', data, text, this.inputNormalizer.takeLineTimestamps());
  }

  output(data: Buffer | string): void {
    if ((!this.state.enabled && !this.file) || this.state.paused || this.terminalEnded) return;
    const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.file?.output(raw);
    if (!this.state.enabled) return;
    if (this.state.captureInput) this.flushInputNormalizerSnapshot();
    const text = this.outputNormalizer.write(raw);
    this.append('output', raw, text, this.outputNormalizer.takeLineTimestamps());
  }

  /** A status line for every active log. */
  system(message: string): void {
    if (!this.state.paused && !this.terminalEnded) this.file?.system(message);
    this.historySystem(message);
  }

  private historySystem(message: string): void {
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
    logToFile?: boolean;
    logFilePath?: string;
  }): SessionLoggingState {
    if (this.terminalEnded) return { ...this.state };
    if (patch.logToFile === false) this.stopFileLog('Logging to file stopped');
    else if (patch.logToFile === true) this.startFileLog(patch.logFilePath);
    if (patch.enabled === false && this.state.enabled) {
      this.finishLogging('completed', 'Session logging stopped.');
    } else if (patch.enabled === true && !this.state.enabled) {
      this.startLogging();
    }
    if (!this.state.enabled && !this.file) return { ...this.state };
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
    if (this.state.enabled) {
      this.history.setSessionState(this.state.sessionId!, {
        paused: this.state.paused,
        captureInput: this.state.captureInput,
      });
    }
    return { ...this.state };
  }

  /**
   * Follow a tab rename: the active record and any record started later in
   * this terminal take the new title; finished records keep theirs.
   */
  setTitle(title: string): void {
    const next = title.trim() || this.sessionTemplate.host;
    if (next === this.sessionTemplate.title) return;
    this.sessionTemplate.title = next;
    if (this.state.enabled && this.state.sessionId) {
      this.history.setSessionTitle(this.state.sessionId, next);
    }
  }

  end(status: Exclude<SessionLogStatus, 'active'>): void {
    if (this.terminalEnded) return;
    this.finishLogging(status, `Session logging ended (${status}).`);
    this.stopFileLog(`Logging to file ended (${status})`);
    this.terminalEnded = true;
  }

  /**
   * Start writing a log file: `requestedPath` is appended to, otherwise a new
   * file is named from the log file settings. A failure only sets a warning.
   */
  private startFileLog(requestedPath?: string): void {
    if (this.file || this.terminalEnded) return;
    const settings = this.database.sessionLogFileSettings();
    const { title, host, kind } = this.sessionTemplate;
    const target =
      requestedPath ??
      sessionLogFilePath(settings, { host, title, kind, startedAt: new Date() });
    let file: SessionLogFile;
    try {
      file = SessionLogFile.open(target, {
        append: requestedPath !== undefined,
        timestamps: settings.timestamps,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.state.warning = `Could not write the log file ${target}: ${reason}`;
      this.logger.warn({ path: target, err }, 'session log file could not be opened');
      return;
    }
    file.onFailure((error) => this.fileFailed(file, error));
    this.file = file;
    this.state.filePath = file.path;
    this.state.warning = undefined;
    const name = title === host ? host : `${title} (${host})`;
    file.system(`Logging to file started: ${name} at ${new Date().toISOString()}.`);
    if (this.state.paused) file.system('Session logging paused.');
  }

  private stopFileLog(marker: string): void {
    if (!this.file) return;
    this.file.close(`${marker} at ${new Date().toISOString()}.`);
    this.file = undefined;
    this.state.filePath = undefined;
    if (!this.state.enabled) this.state.paused = false;
  }

  private fileFailed(file: SessionLogFile, error: Error): void {
    this.logger.warn({ path: file.path, err: error }, 'session log file write failed');
    if (this.file !== file) return;
    this.file = undefined;
    this.state.filePath = undefined;
    if (!this.state.enabled) this.state.paused = false;
    this.state.warning = `Logging to ${file.path} stopped: ${error.message}`;
    this.stateListener?.({ ...this.state });
  }

  private append(
    direction: SessionLogDirection,
    raw: Buffer,
    normalized?: string,
    lineTimestamps: SessionLineTimestamp[] = [],
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
      const offset = previous.text.reduce((length, part) => length + part.length, 0);
      for (const stamp of lineTimestamps) {
        previous.lineTimestamps.push({ ...stamp, offset: stamp.offset + offset });
      }
      previous.raw.push(raw);
      previous.text.push(text);
      previous.rawBytes += raw.byteLength;
    } else {
      this.pending.push({
        sequence: ++this.sequence,
        recordedAt,
        elapsedMs,
        direction,
        lineTimestamps,
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
    lineTimestamps?: SessionLineTimestamp[],
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
      lineTimestamps,
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
        lineTimestamps: event.lineTimestamps,
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
    if (input) this.appendNow('input', Buffer.alloc(0), input, this.inputNormalizer.takeLineTimestamps());
    if (output) this.appendNow('output', Buffer.alloc(0), output, this.outputNormalizer.takeLineTimestamps());
  }

  private flushInputNormalizerSnapshot(): void {
    this.flush();
    const input = this.inputNormalizer.drain();
    if (input) this.appendNow('input', Buffer.alloc(0), input, this.inputNormalizer.takeLineTimestamps());
  }

  private flushOutputNormalizerSnapshot(): void {
    this.flush();
    const output = this.outputNormalizer.drain();
    if (output) this.appendNow('output', Buffer.alloc(0), output, this.outputNormalizer.takeLineTimestamps());
  }

  private suspend(message: string): void {
    if (!this.state.enabled || this.terminalEnded) return;
    this.state.enabled = false;
    // A log file that is still written stays paused.
    if (!this.file) this.state.paused = false;
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
  lineTimestamps: SessionLineTimestamp[];
}
