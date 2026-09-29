import { showToast } from '../state/toast.js';
import { markSlowKeywordPattern, type KeywordMatcher } from './keyword-matching.js';
import type { KeywordMatchRequest, KeywordMatchWorkerMessage } from './keyword-match-worker.js';

/** How long the worker may stay silent on one regex rule before it is replaced. */
export const KEYWORD_MATCH_TIMEOUT_MS = 250;
/** Loading the worker script is not a pattern's fault, so it gets longer. */
const WORKER_STARTUP_TIMEOUT_MS = 10_000;
/** Consecutive worker failures before regex highlighting is given up for the session. */
const MAX_WORKER_FAILURES = 3;

export interface KeywordMatchWorker {
  postMessage(request: KeywordMatchRequest): void;
  terminate(): void;
  onmessage: ((event: { data: KeywordMatchWorkerMessage }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** The request was dropped because the worker was replaced; ask again. */
export class KeywordMatchRetry extends Error {}

interface PendingMatch {
  request: KeywordMatchRequest;
  resolve: (matches: number[]) => void;
  reject: (error: Error) => void;
}

/**
 * Runs keyword matching in a worker that can be killed. On the UI thread, one
 * catastrophically backtracking pattern would freeze every terminal; in the
 * worker it only goes quiet. When the worker stays silent on one regex rule
 * for longer than the timeout, it is terminated, that pattern is reported as
 * slow, and every waiting request is rejected with KeywordMatchRetry so its
 * caller can ask again without the pattern.
 */
export class KeywordMatchClient {
  private worker: KeywordMatchWorker | null = null;
  private ready = false;
  private failures = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingMatch>();
  private running: { id: number; rule: number } | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly createWorker: () => KeywordMatchWorker,
    private readonly onSlowPattern: (rule: KeywordMatcher) => void,
    private readonly timeoutMs = KEYWORD_MATCH_TIMEOUT_MS,
  ) {}

  /** False once the worker has failed to start too often; regex rules are then skipped. */
  get available(): boolean {
    return this.failures < MAX_WORKER_FAILURES;
  }

  /** Resolve with `matchKeywordLines` output for these rules and lines. */
  match(rules: KeywordMatcher[], lines: string[]): Promise<number[]> {
    if (!this.available) {
      return Promise.reject(new Error('Keyword matching is unavailable.'));
    }
    const worker = this.worker ?? this.start();
    const request: KeywordMatchRequest = { id: this.nextId++, rules, lines };
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { request, resolve, reject });
      worker.postMessage(request);
      // New work from another terminal must not buy a stalled worker more time.
      if (this.watchdog === undefined) this.arm();
    });
  }

  dispose(): void {
    this.stop(new KeywordMatchRetry('Keyword matching stopped.'));
  }

  private start(): KeywordMatchWorker {
    const worker = this.createWorker();
    this.ready = false;
    worker.onmessage = ({ data }) => this.receive(data);
    worker.onerror = () => {
      this.failures++;
      this.stop(new KeywordMatchRetry('The keyword matching worker failed.'));
    };
    this.worker = worker;
    return worker;
  }

  private receive(message: KeywordMatchWorkerMessage): void {
    if (message.type === 'ready') {
      this.ready = true;
    } else if (message.type === 'rule') {
      this.running = { id: message.id, rule: message.rule };
    } else {
      this.failures = 0;
      if (this.running?.id === message.id) this.running = null;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      pending?.resolve(message.matches);
    }
    this.arm();
  }

  /** Restart the silence timer whenever the worker makes progress or gets work. */
  private arm(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    if (this.pending.size === 0) return;
    this.watchdog = setTimeout(
      () => this.stalled(),
      this.ready ? this.timeoutMs : WORKER_STARTUP_TIMEOUT_MS,
    );
  }

  private stalled(): void {
    const running = this.running;
    const rule = running ? this.pending.get(running.id)?.request.rules[running.rule] : undefined;
    if (rule) this.onSlowPattern(rule);
    else this.failures++;
    this.stop(new KeywordMatchRetry('Keyword matching took too long.'));
  }

  private stop(error: Error): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.running = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}

let sharedClient: KeywordMatchClient | undefined;

/** The worker shared by every terminal in this window, started on first use. */
export function keywordMatchClient(): KeywordMatchClient {
  sharedClient ??= new KeywordMatchClient(
    () =>
      new Worker(new URL('./keyword-match-worker.ts', import.meta.url), {
        type: 'module',
        name: 'keyword-highlighting',
      }) as unknown as KeywordMatchWorker,
    (rule) => {
      markSlowKeywordPattern(rule);
      showToast(
        'warning',
        'A highlighting pattern took too long to match and was paused.',
        rule.keyword,
      );
    },
  );
  return sharedClient;
}
