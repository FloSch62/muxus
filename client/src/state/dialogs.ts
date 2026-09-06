import type { ReactNode } from 'react';
import { create } from 'zustand';

/**
 * The app's one "ask the user something" queue. Everything that used to reach
 * for `window.confirm`/`window.prompt` posts a request here instead, so every
 * question is themed, keyboard-driven and identical wherever it comes from —
 * and so it works in the desktop app, where Electrobun replaces `window.prompt`
 * with a function that throws.
 */

export interface ConfirmOption {
  label: string;
  /** Called on confirm when the box was ticked (e.g. "don't ask again"). */
  onChecked: () => void;
}

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the confirm button as destructive and keeps Cancel the safe default. */
  destructive?: boolean;
  checkbox?: ConfirmOption;
}

export interface PromptOptions {
  title: string;
  description?: ReactNode;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Returns a message to block submission, or null when the value is usable. */
  validate?: (value: string) => string | null;
}

export type DialogRequest =
  | ({ id: number; kind: 'confirm'; resolve: (confirmed: boolean) => void } & ConfirmOptions)
  | ({ id: number; kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions);

interface DialogState {
  /** FIFO — a question raised while another is open waits its turn. */
  queue: DialogRequest[];
  push: (request: DialogRequest) => void;
  resolveHead: (value: boolean | string | null) => void;
}

export const useDialogStore = create<DialogState>()((set, get) => ({
  queue: [],
  push: (request) => set((state) => ({ queue: [...state.queue, request] })),
  resolveHead: (value) => {
    const head = get().queue[0];
    if (!head) return;
    set((state) => ({ queue: state.queue.slice(1) }));
    if (head.kind === 'confirm') head.resolve(value === true);
    else head.resolve(typeof value === 'string' ? value : null);
  },
}));

let nextId = 1;

/** Ask for confirmation. Resolves false on cancel, Escape or backdrop click. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().push({ id: nextId++, kind: 'confirm', resolve, ...options });
  });
}

/** Ask for a line of text. Resolves null when dismissed. */
export function promptForText(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().push({ id: nextId++, kind: 'prompt', resolve, ...options });
  });
}
