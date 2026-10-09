import { create } from 'zustand';
import { terminalHandle } from '../terminal/terminal-registry.js';
import { mirroredTabIds } from './multi-exec.js';

/** A paced paste the backend is typing into a terminal. */
export interface PasteProgress {
  /** The line being sent, from 1, of every queued paste's lines. */
  line: number;
  lines: number;
  sent: number;
  total: number;
}

interface PasteProgressState {
  byTab: Readonly<Record<string, PasteProgress>>;
}

/** Kept apart from the tabs store so progress updates re-render only what shows them. */
export const usePasteProgressStore = create<PasteProgressState>()(() => ({ byTab: {} }));

export function setPasteProgress(tabId: string, progress: PasteProgress | undefined): void {
  usePasteProgressStore.setState((state) => {
    if (progress) return { byTab: { ...state.byTab, [tabId]: progress } };
    if (!(tabId in state.byTab)) return state;
    const byTab = { ...state.byTab };
    delete byTab[tabId];
    return { byTab };
  });
}

export function pasteProgressLabel(progress: PasteProgress): string {
  return `Pasting line ${progress.line} of ${progress.lines}`;
}

export function pasteProgressPercent(progress: PasteProgress): number {
  return progress.total > 0 ? Math.min(100, (progress.sent / progress.total) * 100) : 0;
}

/**
 * Stop a paced paste. Input is mirrored under multi-execution, so stopping
 * it in one mirrored terminal stops it in all of them.
 */
export function cancelPaste(tabId: string): void {
  const mirrored = mirroredTabIds(tabId);
  for (const id of mirrored.length > 0 ? mirrored : [tabId]) terminalHandle(id)?.cancelPaste();
}
