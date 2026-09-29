// Runs keyword highlighting rules away from the UI thread. A regex can
// backtrack for seconds or forever; here that only stalls this worker, which
// KeywordMatchClient notices and replaces.
import { matchKeywordLines, type KeywordMatcher } from './keyword-matching.js';

export interface KeywordMatchRequest {
  id: number;
  rules: KeywordMatcher[];
  lines: string[];
}

export type KeywordMatchWorkerMessage =
  | { type: 'ready' }
  /** Sent before each regex rule, so a stall can be blamed on the right one. */
  | { type: 'rule'; id: number; rule: number }
  | { type: 'result'; id: number; matches: number[] };

interface WorkerScope {
  postMessage(message: KeywordMatchWorkerMessage): void;
  onmessage: ((event: MessageEvent<KeywordMatchRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = ({ data }) => {
  const matches = matchKeywordLines(data.rules, data.lines, (rule) =>
    scope.postMessage({ type: 'rule', id: data.id, rule }),
  );
  scope.postMessage({ type: 'result', id: data.id, matches });
};

scope.postMessage({ type: 'ready' });
