import type { DialHandlers } from './api/dial.js';

/**
 * Sign-in and host-key prompts for connections a window opens outside any
 * tab: the app root answers them wherever in the window they were started
 * from.
 */
let handlers: DialHandlers | undefined;

export function setWindowDialHandlers(next: DialHandlers | undefined): void {
  handlers = next;
}

export function windowDialHandlers(): DialHandlers {
  if (!handlers) throw new Error('Muxus is not ready to ask for sign-ins yet.');
  return handlers;
}
