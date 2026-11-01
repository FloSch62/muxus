import { useMemo } from 'react';
import { create } from 'zustand';
import {
  isFinishedProgramState,
  summarizeProgramStatus,
  type ProgramStatusChange,
  type ProgramStatusRecord,
} from '../terminal/program-status.js';
import { useTabsStore } from './tabs.js';

export interface TabProgramStatus {
  records: readonly ProgramStatusRecord[];
  /** A done or error report arrived that nobody has looked at yet. */
  unseen: boolean;
}

interface ProgramStatusState {
  byTab: Readonly<Record<string, TabProgramStatus>>;
  update: (tabId: string, change: ProgramStatusChange) => void;
  /** The tab was looked at: its finished results stop showing. */
  markSeen: (tabId: string) => void;
}

const EMPTY: readonly ProgramStatusRecord[] = [];

/** The user is looking at this tab right now. */
function isWatched(tabId: string): boolean {
  if (typeof document === 'undefined' || !document.hasFocus()) return false;
  return useTabsStore.getState().activeId === tabId;
}

function newlyFinished(
  before: readonly ProgramStatusRecord[],
  after: readonly ProgramStatusRecord[],
): boolean {
  const previous = new Map(before.map((record) => [record.id, record]));
  return after.some(
    (record) => isFinishedProgramState(record.state) && previous.get(record.id) !== record,
  );
}

function withoutTab(
  byTab: Readonly<Record<string, TabProgramStatus>>,
  tabId: string,
): Readonly<Record<string, TabProgramStatus>> {
  const next = { ...byTab };
  delete next[tabId];
  return next;
}

export const useProgramStatusStore = create<ProgramStatusState>()((set, get) => ({
  byTab: {},
  update: (tabId, change) => {
    const current = get().byTab[tabId];
    const before = current?.records ?? EMPTY;
    const records = change(before);
    if (records === before) return;
    if (records.length === 0) {
      set({ byTab: withoutTab(get().byTab, tabId) });
      return;
    }
    const unseen = newlyFinished(before, records)
      ? !isWatched(tabId)
      : (current?.unseen ?? false);
    set({ byTab: { ...get().byTab, [tabId]: { records, unseen } } });
  },
  markSeen: (tabId) => {
    const current = get().byTab[tabId];
    if (!current?.unseen) return;
    set({ byTab: { ...get().byTab, [tabId]: { ...current, unseen: false } } });
  },
}));

/** The record a tab shows, if any. */
export function useTabProgramStatus(tabId: string): ProgramStatusRecord | undefined {
  // Select the stored object, which keeps its identity until it changes, and
  // summarize outside the selector: an inherited app name makes a new object.
  const status = useProgramStatusStore((state) => state.byTab[tabId]);
  return useMemo(
    () => (status ? summarizeProgramStatus(status.records, status.unseen) : undefined),
    [status],
  );
}

// Activating a tab, or returning to the window with it active, counts as
// looking at it. Closed tabs drop their records.
useTabsStore.subscribe((state, previous) => {
  const { byTab, markSeen } = useProgramStatusStore.getState();
  if (state.tabs !== previous.tabs) {
    const open = new Set(state.tabs.map((tab) => tab.id));
    const closed = Object.keys(byTab).filter((tabId) => !open.has(tabId));
    if (closed.length) {
      const next = { ...byTab };
      for (const tabId of closed) delete next[tabId];
      useProgramStatusStore.setState({ byTab: next });
    }
  }
  if (state.activeId && state.activeId !== previous.activeId && isWatched(state.activeId)) {
    markSeen(state.activeId);
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    const { activeId } = useTabsStore.getState();
    if (activeId) useProgramStatusStore.getState().markSeen(activeId);
  });
}
