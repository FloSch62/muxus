import { create } from 'zustand';
import type { WorkspaceMultiExecGroup } from '@muxus/shared';
import { terminalHandle } from '../terminal/terminal-registry.js';

interface MultiExecState {
  /** Two or more selected tabs automatically form a mirrored-input group. */
  selectedIds: string[];
  /** The last set that actually mirrored, so the toggle can resume it. */
  lastMirroredIds: string[];
  /** Named target sets persisted as part of the active workspace. */
  groups: WorkspaceMultiExecGroup[];
  setSelection: (tabIds: string[]) => void;
  toggleTarget: (tabId: string) => void;
  toggleMirroring: (
    availableTabIds: readonly string[],
    fallbackTabIds: readonly string[],
  ) => boolean;
  reconcile: (availableTabIds: string[]) => void;
  setGroups: (groups: readonly WorkspaceMultiExecGroup[]) => void;
  saveGroup: (name: string, tabIds?: readonly string[]) => string | undefined;
  deleteGroup: (id: string) => void;
  activateGroup: (id: string, availableTabIds: readonly string[]) => void;
}

function unique(tabIds: readonly string[]): string[] {
  return [...new Set(tabIds)];
}

/** Visible panes whose active terminals currently participate in mirrored input. */
export function multiExecPaneIds(
  panes: readonly { id: string; activeTabId: string | null }[],
  selectedIds: readonly string[],
): Set<string> {
  if (selectedIds.length < 2) return new Set();
  const selected = new Set(selectedIds);
  return new Set(
    panes
      .filter((pane) => pane.activeTabId && selected.has(pane.activeTabId))
      .map((pane) => pane.id),
  );
}

/**
 * A selection change that also remembers any set large enough to mirror, so
 * switching multi-execution off and on again lands on the same terminals.
 */
function select(
  state: MultiExecState,
  selectedIds: string[],
): Pick<MultiExecState, 'selectedIds' | 'lastMirroredIds'> {
  return {
    selectedIds,
    lastMirroredIds: selectedIds.length >= 2 ? selectedIds : state.lastMirroredIds,
  };
}

export const useMultiExecStore = create<MultiExecState>()((set) => ({
  selectedIds: [],
  lastMirroredIds: [],
  groups: [],
  setSelection: (tabIds) => set((state) => select(state, unique(tabIds))),
  toggleTarget: (tabId) =>
    set((state) =>
      select(
        state,
        state.selectedIds.includes(tabId)
          ? state.selectedIds.filter((id) => id !== tabId)
          : [...state.selectedIds, tabId],
      ),
    ),
  toggleMirroring: (availableTabIds, fallbackTabIds) => {
    let toggled = false;
    set((state) => {
      // Off is unconditional: whatever is mirroring right now stops, and the
      // set is kept for the next press.
      if (state.selectedIds.length >= 2) {
        toggled = true;
        return { selectedIds: [], lastMirroredIds: state.selectedIds };
      }
      const available = new Set(availableTabIds);
      const resumed = state.lastMirroredIds.filter((id) => available.has(id));
      const selectedIds =
        resumed.length >= 2 ? resumed : unique(fallbackTabIds).filter((id) => available.has(id));
      if (selectedIds.length < 2) return state;
      toggled = true;
      return select(state, selectedIds);
    });
    return toggled;
  },
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
  setGroups: (groups) =>
    set({
      selectedIds: [],
      // Tab ids from the outgoing workspace can never be resumed.
      lastMirroredIds: [],
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        tabIds: unique(group.tabIds),
      })),
    }),
  saveGroup: (name, tabIds) => {
    const normalized = name.trim();
    let savedId: string | undefined;
    set((state) => {
      const targets = unique([...(tabIds ?? state.selectedIds)]);
      if (!normalized || targets.length < 2) return state;
      const existing = state.groups.find(
        (group) => group.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
      );
      savedId = existing?.id ?? `multi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const next = { id: savedId, name: normalized, tabIds: targets };
      return {
        groups: existing
          ? state.groups.map((group) => (group.id === existing.id ? next : group))
          : [...state.groups, next],
      };
    });
    return savedId;
  },
  deleteGroup: (id) =>
    set((state) => ({ groups: state.groups.filter((group) => group.id !== id) })),
  activateGroup: (id, availableTabIds) =>
    set((state) => {
      const group = state.groups.find((candidate) => candidate.id === id);
      if (!group) return state;
      const available = new Set(availableTabIds);
      return select(
        state,
        group.tabIds.filter((tabId) => available.has(tabId)),
      );
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
