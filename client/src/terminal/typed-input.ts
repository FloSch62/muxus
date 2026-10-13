import {
  isPacedPaste,
  MAX_PACED_PASTE_LENGTH,
  type PastePacing,
  type TerminalClientMessage,
} from '@muxus/shared';

export type TypedInput =
  | { kind: 'direct'; data: string }
  | { kind: 'paced'; message: Extract<TerminalClientMessage, { op: 'paste' }> };

/**
 * Saved text is typed, never bracketed, so Enter still executes. Paced hosts
 * route it through the backend pacer, which also queues it behind a running paste;
 * `behindPaste` queues it there too when only that paste was paced.
 */
export function typedInput(text: string, pacing: PastePacing, behindPaste = false): TypedInput {
  if (!text || text.length > MAX_PACED_PASTE_LENGTH || !(behindPaste || isPacedPaste(pacing))) {
    return { kind: 'direct', data: text };
  }
  return { kind: 'paced', message: { op: 'paste', text, bracketed: false, ...pacing } };
}
