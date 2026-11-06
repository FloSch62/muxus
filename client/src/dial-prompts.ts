import type { DialHandlers } from './api/dial.js';
import type { AuthPromptRequest, AuthPromptResult } from './components/AuthPromptDialog.js';
import type { HostKeyRequest } from './components/HostKeyDialog.js';

/** One question for the window's prompt host. */
export type WindowPrompt =
  | { kind: 'auth'; request: AuthPromptRequest; resolve: (result: AuthPromptResult | null) => void }
  | { kind: 'host-key'; request: HostKeyRequest; resolve: (accept: boolean) => void };

/** Shows a prompt and returns a function that takes it back if it is still waiting. */
type ShowPrompt = (prompt: WindowPrompt) => () => void;

let show: ShowPrompt | undefined;

export function setWindowPromptHost(next: ShowPrompt | undefined): void {
  show = next;
}

/**
 * Sign-in and host-key prompts for connections a window opens outside any
 * tab: the app root answers them wherever in the window they were started
 * from. Aborting `signal` (the dial gave up, or was cancelled) takes back the
 * prompts still waiting and answers them as cancelled.
 */
export function windowDialHandlers(signal?: AbortSignal): DialHandlers {
  const host = show;
  if (!host) throw new Error('Muxus is not ready to ask for sign-ins yet.');
  const ask = <T>(make: (resolve: (value: T) => void) => WindowPrompt, cancelled: T): Promise<T> =>
    new Promise<T>((resolve) => {
      if (signal?.aborted) {
        resolve(cancelled);
        return;
      }
      let done = false;
      const finish = (value: T) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const withdraw = host(make(finish));
      const onAbort = () => {
        withdraw();
        finish(cancelled);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  return {
    onAuthPrompt: (request) => ask<AuthPromptResult | null>((resolve) => ({ kind: 'auth', request, resolve }), null),
    onHostKey: (request) => ask<boolean>((resolve) => ({ kind: 'host-key', request, resolve }), false),
  };
}
