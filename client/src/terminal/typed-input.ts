import {
  isPacedPaste,
  MAX_PACED_PASTE_LENGTH,
  terminalPasteData,
  type PastePacing,
  type TerminalClientMessage,
  type TerminalEnterKey,
} from '@muxus/shared';

export type TypedInput =
  | { kind: 'direct'; data: string }
  | { kind: 'paced'; message: Extract<TerminalClientMessage, { op: 'paste' }> };

/**
 * Saved text is typed, never bracketed, so Enter still executes; its line
 * breaks go out as the host's Enter key. Paced hosts route it through the
 * backend pacer, which also queues it behind a running paste; `behindPaste`
 * queues it there too when only that paste was paced.
 */
export function typedInput(
  text: string,
  pacing: PastePacing,
  behindPaste = false,
  enterKey: TerminalEnterKey = 'cr',
): TypedInput {
  if (!text || text.length > MAX_PACED_PASTE_LENGTH || !(behindPaste || isPacedPaste(pacing))) {
    return { kind: 'direct', data: terminalPasteData(text, false, enterKey) };
  }
  return {
    kind: 'paced',
    message: {
      op: 'paste',
      text,
      bracketed: false,
      ...pacing,
      ...(enterKey === 'cr' ? {} : { enterKey }),
    },
  };
}
