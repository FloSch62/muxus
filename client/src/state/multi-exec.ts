import { create } from 'zustand';
import { terminalHandle } from '../terminal/terminal-registry.js';

interface MultiExecState {
  /** Two or more selected tabs automatically form a mirrored-input group. */
  selectedIds: string[];
  setSelection: (tabIds: string[]) => void;
  toggleTarget: (tabId: string) => void;
  reconcile: (availableTabIds: string[]) => void;
}

function unique(tabIds: string[]): string[] {
  return [...new Set(tabIds)];
}

export const useMultiExecStore = create<MultiExecState>()((set) => ({
  selectedIds: [],
  setSelection: (tabIds) => set({ selectedIds: unique(tabIds) }),
  toggleTarget: (tabId) =>
    set((state) => {
      const selectedIds = state.selectedIds.includes(tabId)
        ? state.selectedIds.filter((id) => id !== tabId)
        : [...state.selectedIds, tabId];
      return { selectedIds };
    }),
  reconcile: (availableTabIds) =>
    set((state) => {
      const available = new Set(availableTabIds);
      const selectedIds = state.selectedIds.filter((id) => available.has(id));
      if (
        selectedIds.length === state.selectedIds.length &&
        selectedIds.every((id, index) => id === state.selectedIds[index])
      ) {
        return state;
      }
      return { selectedIds };
    }),
}));

/**
 * Mirror user input from one selected terminal to every other selected
 * terminal. Direct socket writes avoid re-entering xterm's onData handler.
 */
export function broadcastTerminalInput(
  sourceTabId: string,
  data: string | Uint8Array<ArrayBuffer>,
): number {
  const { selectedIds } = useMultiExecStore.getState();
  if (selectedIds.length < 2 || !selectedIds.includes(sourceTabId)) return 0;
  let delivered = 0;
  for (const tabId of selectedIds) {
    if (tabId !== sourceTabId && terminalHandle(tabId)?.sendInput(data)) delivered++;
  }
  return delivered;
}
