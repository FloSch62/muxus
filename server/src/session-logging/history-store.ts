import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { nanoid } from 'nanoid';
import type {
  SessionHistoryResponse,
  SessionHistorySettings,
  SessionHistoryStorageStatus,
  SessionLogDetail,
  SessionLogDirection,
  SessionLoggingPolicy,
} from '@muxus/shared';
import type { SessionLogCreateInput } from '../persistence/database.js';

export interface HistoryEvent {
  sequence: number;
  recordedAt: string;
  elapsedMs: number;
  direction: SessionLogDirection;
  raw: Buffer;
  text: string;
}

export interface SessionHistoryQuery {
  query?: string;
  profileKey?: string;
  host?: string;
  kind?: SessionLogDetail['kind'];
  startedAfter?: string;
  startedBefore?: string;
  limit: number;
  cursor?: string;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * Async facade for the dedicated history worker. The terminal transport only
 * performs bounded memory copies; filesystem, compression, SQLite, quota, and
 * search work all stays on the worker thread.
 */
export class SessionHistoryStore {
  readonly root: string;
  private readonly temporaryRoot: boolean;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly failureListeners = new Map<string, Set<(message: string) => void>>();
  private nextRequestId = 1;
  private pendingWriteBytes = 0;
  private closed = false;

  private constructor(
    root: string,
    temporaryRoot: boolean,
    private settings: SessionHistorySettings,
    legacyDatabasePath?: string,
  ) {
    const resolvedRoot = path.resolve(root);
    if (path.parse(resolvedRoot).root === resolvedRoot) {
      throw new Error('the filesystem root cannot be used as the session history location');
    }
    root = resolvedRoot;
    this.root = resolvedRoot;
    this.temporaryRoot = temporaryRoot;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.worker = new Worker(new URL('./history-worker.js', import.meta.url), {
      workerData: { root, settings, legacyDatabasePath },
    });
    this.worker.on('message', (reply: WorkerReply) => this.handleReply(reply));
    this.worker.on('error', (error) => this.failAll(error));
    this.worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        this.failAll(new Error(`session history worker stopped with exit code ${code}`));
      }
    });
  }

  static async open(input: {
    root?: string;
    settings: SessionHistorySettings;
    legacyDatabasePath?: string;
  }): Promise<SessionHistoryStore> {
    const temporary = !input.root;
    const root =
      input.root ??
      mkdtempSync(path.join(os.tmpdir(), 'muxus-session-history-'));
    const store = new SessionHistoryStore(
      root,
      temporary,
      input.settings,
      input.legacyDatabasePath,
    );
    await store.request('ready');
    return store;
  }

  beginSession(
    input: SessionLogCreateInput,
    policy: Pick<SessionLoggingPolicy, 'maxPartBytes' | 'maxParts'>,
  ): string {
    const id = nanoid();
    void this.request('begin', { id, input, policy }).catch((error) => {
      this.notifyFailure(id, error.message);
    });
    return id;
  }

  /**
   * Queue one recorder batch without awaiting disk. False is explicit
   * backpressure: callers must suspend logging for that session.
   */
  append(
    sessionId: string,
    events: HistoryEvent[],
    policy: Pick<SessionLoggingPolicy, 'maxPartBytes' | 'maxParts'>,
  ): boolean {
    const bytes = events.reduce(
      (total, event) =>
        total + event.raw.byteLength + Buffer.byteLength(event.text, 'utf8') + 64,
      0,
    );
    if (
      this.closed ||
      bytes > MAX_PENDING_WRITE_BYTES ||
      this.pendingWriteBytes + bytes > MAX_PENDING_WRITE_BYTES
    ) {
      return false;
    }
    this.pendingWriteBytes += bytes;
    void this.request('append', { sessionId, events, policy })
      .catch((error) => this.notifyFailure(sessionId, error.message))
      .finally(() => {
        this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - bytes);
      });
    return true;
  }

  setSessionState(
    sessionId: string,
    patch: { paused?: boolean; captureInput?: boolean },
  ): void {
    void this.request('set-state', { sessionId, patch }).catch((error) => {
      this.notifyFailure(sessionId, error.message);
    });
  }

  finishSession(
    sessionId: string,
    status: 'completed' | 'disconnected' | 'failed',
    endedAt: string,
  ): void {
    void this.request('finish', { sessionId, status, endedAt }).catch((error) => {
      this.notifyFailure(sessionId, error.message);
    });
  }

  onSessionFailure(sessionId: string, listener: (message: string) => void): () => void {
    const listeners = this.failureListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.failureListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.failureListeners.delete(sessionId);
    };
  }

  sessionHistory(input: SessionHistoryQuery): Promise<SessionHistoryResponse> {
    return this.request('search', input);
  }

  /**
   * `matchQuery` anchors a limited event window on the first full-text match
   * (instead of the newest events) when the match would otherwise be cut off.
   */
  sessionLog(
    id: string,
    eventLimit?: number,
    matchQuery?: string,
  ): Promise<SessionLogDetail | undefined> {
    return this.request('detail', { id, eventLimit, matchQuery });
  }

  rawSessionLogEvents(id: string): Promise<HistoryEvent[] | undefined> {
    return this.request<HistoryEvent[] | undefined>('raw', { id }).then((events) =>
      events?.map((event) => ({ ...event, raw: Buffer.from(event.raw) })),
    );
  }

  deleteSession(id: string): Promise<boolean> {
    return this.request('delete', { id });
  }

  setPinned(id: string, pinned: boolean): Promise<boolean> {
    return this.request('pin', { id, pinned });
  }

  async updateSettings(settings: SessionHistorySettings): Promise<void> {
    this.settings = settings;
    await this.request('settings', settings);
  }

  storageStatus(configuredLocation?: string): Promise<SessionHistoryStorageStatus> {
    return this.request('status', {
      settings: this.settings,
      configuredLocation,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.request('close');
    } catch {
      // The worker may already have stopped after a fatal storage failure.
    }
    await this.worker.terminate();
    if (this.temporaryRoot) {
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  private request<T>(op: string, payload?: unknown): Promise<T> {
    if (this.closed && op !== 'close') {
      return Promise.reject(new Error('session history store is closed'));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, op, payload });
    });
  }

  private handleReply(reply: WorkerReply): void {
    const request = this.pending.get(reply.id);
    if (!request) return;
    this.pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.value);
    else request.reject(new Error(reply.error ?? 'session history operation failed'));
  }

  private notifyFailure(sessionId: string, message: string): void {
    for (const listener of this.failureListeners.get(sessionId) ?? []) {
      listener(message);
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export function defaultHistoryRoot(databasePath: string): string | undefined {
  if (databasePath === ':memory:') return undefined;
  return path.join(path.dirname(databasePath), 'history');
}
