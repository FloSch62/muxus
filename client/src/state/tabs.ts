import { create } from 'zustand';
import type { SessionProfile, WorkspaceLayoutV1 } from '@muxus/shared';
import type { ReattachMode } from '../connection-recovery.js';
import {
  equalizeSplits,
  findPane,
  firstPane,
  neighborPaneId,
  panesInOrder,
  parentSplit,
  placesPaneFirst,
  removePane,
  restoreWorkspace as restoreWorkspaceLayout,
  splitAxis,
  updatePane,
  updateSplitRatio,
  type PaneDirection,
  type PaneLeaf,
  type PaneNode,
  type RestoreWorkspaceOptions,
} from './workspace-layout.js';

export type TabStatus = 'connecting' | 'connected' | 'interrupted' | 'closed';

interface TabBase {
  id: string;
  paneId: string;
  title: string;
  /** Live SSH connection id from `ready`; absent for local, Telnet, and serial tabs. */
  connId?: string;
  /** Stable server-side identity for renderer reattachment, including during setup. */
  terminalId?: string;
  /** Cross-window transfer awaiting acknowledgement from the source window. */
  transferId?: string;
  /** SFTP file panel visible for this tab. */
  sftpOpen: boolean;
  /** Server-advertised capability for the current SSH transport. */
  sftpAvailable?: boolean;
  /** Most recent working directory reported by a live local or remote shell. */
  terminalCwd?: string;
  /** Explicit opt-out from following the terminal in the attached SFTP panel. */
  sftpFollowTerminal?: boolean;
  /** Monotonic UI signal consumed by the mounted terminal search bar. */
  searchRequest: number;
  /** User-set color flag marking the tab. */
  color?: string;
  /** Pinned tabs stay grouped at the start of their pane. */
  pinned?: boolean;
  /** Files open in the Monaco workspace attached to this session. */
  editorPaths: string[];
  activeEditorPath?: string;
  /** Durable server-side history state for this live tab. */
  loggingEnabled?: boolean;
  sessionLogId?: string;
  loggingWarning?: string;
  loggingPaused: boolean;
  captureInput: boolean;
  /** Monotonic signal used to reconnect one or many mounted terminal views. */
  reconnectRequest: number;
  /** Optional multiplexer to attach after the replacement SSH shell is ready. */
  reconnectMode?: ReattachMode;
  /** Most recent connection/end reason, shown without requiring terminal scrollback. */
  failureReason?: string;
  disconnectReason?: 'completed' | 'failed' | 'disconnected';
  /** Tab came from a persisted workspace layout, so stored scrollback may exist. */
  restored?: boolean;
}

export interface SessionTab extends TabBase {
  profile: SessionProfile;
  status: TabStatus;
  /** Whether this tab should establish its session when the terminal view mounts. */
  connectOnMount: boolean;
}

export interface EmptyTab extends TabBase {
  profile: null;
  status: 'idle';
  connectOnMount: false;
}

export type TerminalTab = SessionTab | EmptyTab;
export type TransferableTab = Omit<SessionTab, 'paneId'> | Omit<EmptyTab, 'paneId'>;

type TabUpdate = Partial<{
  title: string;
  status: TabStatus;
  connId: string | undefined;
  terminalId: string | undefined;
  transferId: string | undefined;
  sftpOpen: boolean;
  sftpAvailable: boolean | undefined;
  terminalCwd: string | undefined;
  sftpFollowTerminal: boolean | undefined;
  color: string | undefined;
  loggingEnabled: boolean | undefined;
  sessionLogId: string | undefined;
  loggingWarning: string | undefined;
  loggingPaused: boolean;
  captureInput: boolean;
  failureReason: string | undefined;
  disconnectReason: 'completed' | 'failed' | 'disconnected' | undefined;
}>;

export interface ReconnectOptions {
  reattach?: ReattachMode;
}

export interface SessionSetEntry {
  profile: SessionProfile;
  title: string;
  color?: string;
}

export type SessionSetLayout = 'tabs' | 'columns' | 'rows' | 'grid';

/** Keyboard resize step, as a fraction of the split's own extent. */
export const PANE_RESIZE_STEP = 0.04;

interface TabsState {
  tabs: TerminalTab[];
  /** Terminal tabs with output that arrived while they were not visible. */
  unreadOutputIds: Set<string>;
  root: PaneNode;
  activePaneId: string;
  activeId: string | null;
  /** Pane temporarily filling the canvas; siblings stay mounted underneath. */
  zoomedPaneId: string | null;
  open: (profile: SessionProfile, title: string) => string;
  openEmpty: () => string;
  replaceEmpty: (id: string, profile: SessionProfile, title: string) => boolean;
  close: (id: string) => void;
  activate: (id: string) => void;
  focusPane: (paneId: string) => void;
  cycle: (backwards: boolean) => void;
  /** Activate the nth tab across the whole window in pane/strip order. */
  activateTabIndex: (index: number) => boolean;
  /** Reorder the active tab inside its own pane. */
  moveTabWithinPane: (offset: -1 | 1) => boolean;
  /** Place one tab before or after another tab in the same pane and pin group. */
  reorderTab: (id: string, targetId: string, edge: 'before' | 'after') => boolean;
  /** Move a tab to an exact position in another split pane. */
  moveTabToPane: (
    id: string,
    paneId: string,
    targetId?: string,
    edge?: 'before' | 'after',
  ) => boolean;
  /** Pin or unpin a tab and move it to the corresponding strip boundary. */
  setPinned: (id: string, pinned: boolean) => boolean;
  split: (paneId: string, direction: PaneDirection) => string | undefined;
  closePane: (paneId: string) => void;
  /** Focus the pane that borders the active one in a direction. */
  focusPaneDirection: (direction: PaneDirection) => boolean;
  /** Focus the next/previous pane in reading order. */
  cyclePane: (backwards: boolean) => boolean;
  /** Move the active tab to the bordering pane, splitting off a new one when there is none. */
  moveTabToDirection: (direction: PaneDirection) => boolean;
  /** Split a specific tab into a newly created neighbouring pane. */
  moveTabToNewPane: (id: string, direction: PaneDirection) => boolean;
  /** Fill the canvas with one pane (tmux-style zoom), or restore the layout. */
  toggleZoom: (paneId?: string) => boolean;
  resizeSplit: (splitId: string, ratio: number) => void;
  /** Grow or shrink the focused pane inside its nearest split. */
  resizeActivePane: (delta: number) => boolean;
  /** Give every pane an equal share of the canvas. */
  equalizePanes: () => boolean;
  requestSearch: () => void;
  openEditor: (tabId: string, path: string) => void;
  activateEditor: (tabId: string, path: string) => void;
  closeEditor: (tabId: string, path: string) => void;
  restore: (layout: WorkspaceLayoutV1, options?: RestoreWorkspaceOptions) => void;
  /** Replace the pane canvas with a freshly connected, arranged session set. */
  launchSet: (entries: readonly SessionSetEntry[], layout: SessionSetLayout) => string[];
  /** Start fresh connections for selected ended/restored sessions. */
  reconnect: (tabIds: readonly string[], options?: ReconnectOptions) => void;
  /** Reconnect every ended/restored session in the current workspace. */
  reconnectAll: (options?: ReconnectOptions) => void;
  /** Record terminal output, notifying only while the tab is hidden. */
  notifyOutput: (id: string) => void;
  update: (id: string, patch: TabUpdate) => void;
}

let nextId = 1;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${nextId++}`;
const initialPane = (): PaneLeaf => ({ id: newId('pane'), type: 'pane', activeTabId: null });
const initial = initialPane();

/**
 * Drop an emptied pane and hand focus to the sibling that takes over its
 * space, so closing the last tab of a split behaves like closing the pane.
 * Returns undefined when the pane is the whole canvas — that one stays.
 */
function collapsePane(
  root: PaneNode,
  paneId: string,
): { root: PaneNode; focus: PaneLeaf } | undefined {
  if (root.type === 'pane') return undefined;
  const parent = parentSplit(root, paneId);
  const sibling = parent ? parent.split.children[parent.branch === 0 ? 1 : 0] : undefined;
  const next = removePane(root, paneId);
  if (!next) return undefined;
  return { root: next, focus: firstPane(sibling ?? next) };
}

/** Split a pane in place, returning the tree plus the pane that was added. */
function insertSplit(
  root: PaneNode,
  paneId: string,
  direction: PaneDirection,
): { root: PaneNode; pane: PaneLeaf } {
  const pane: PaneLeaf = { id: newId('pane'), type: 'pane', activeTabId: null };
  return {
    pane,
    root: updatePane(root, paneId, (existing) => ({
      id: newId('split'),
      type: 'split',
      direction: splitAxis(direction),
      ratio: 0.5,
      children: placesPaneFirst(direction) ? [pane, existing] : [existing, pane],
    })),
  };
}

/** Whether a terminal, rather than one of its editors, is visible on the canvas. */
function terminalIsVisible(
  tab: TerminalTab,
  root: PaneNode,
  zoomedPaneId: string | null,
): boolean {
  return (
    !tab.activeEditorPath &&
    (!zoomedPaneId || zoomedPaneId === tab.paneId) &&
    findPane(root, tab.paneId)?.activeTabId === tab.id
  );
}

/** Drop notifications for every terminal currently visible on the canvas. */
function clearVisibleOutput(
  unreadOutputIds: Set<string>,
  tabs: readonly TerminalTab[],
  root: PaneNode,
  zoomedPaneId: string | null,
): Set<string> {
  if (unreadOutputIds.size === 0) return unreadOutputIds;
  const next = new Set(unreadOutputIds);
  for (const tab of tabs) {
    if (terminalIsVisible(tab, root, zoomedPaneId)) next.delete(tab.id);
  }
  return next.size === unreadOutputIds.size ? unreadOutputIds : next;
}

/** Remove one tab from the unread set without allocating when it is already read. */
function clearOutput(unreadOutputIds: Set<string>, id: string): Set<string> {
  if (!unreadOutputIds.has(id)) return unreadOutputIds;
  const next = new Set(unreadOutputIds);
  next.delete(id);
  return next;
}

/** Replace one pane's ordered tabs without disturbing the other panes' slots. */
function replacePaneTabs(
  tabs: readonly TerminalTab[],
  paneId: string,
  paneTabs: readonly TerminalTab[],
): TerminalTab[] {
  let index = 0;
  return tabs.map((tab) => tab.paneId === paneId ? paneTabs[index++]! : tab);
}

/** Tabs in deterministic window-wide order: panes first, then each strip left-to-right. */
export function tabsInOrder(
  root: PaneNode,
  tabs: readonly TerminalTab[],
): TerminalTab[] {
  const byPane = new Map<string, TerminalTab[]>();
  for (const tab of tabs) {
    const paneTabs = byPane.get(tab.paneId);
    if (paneTabs) paneTabs.push(tab);
    else byPane.set(tab.paneId, [tab]);
  }
  const ordered: TerminalTab[] = [];
  for (const pane of panesInOrder(root)) ordered.push(...(byPane.get(pane.id) ?? []));
  return ordered;
}

/** Browser-style bulk close target: unpinned tabs after one tab in its strip. */
export function closableTabIdsToRight(
  paneTabs: readonly TerminalTab[],
  tabId: string,
): string[] {
  const index = paneTabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return [];
  return paneTabs.slice(index + 1).filter((tab) => !tab.pinned).map((tab) => tab.id);
}

/** Insert a tab at an exact target, while keeping each pane's pinned group first. */
export function insertIntoPane(
  tabs: readonly TerminalTab[],
  tab: TerminalTab,
  paneId: string,
  targetId?: string,
  edge: 'before' | 'after' = 'after',
): TerminalTab[] {
  const next = [...tabs];
  const paneTabs = next.filter((candidate) => candidate.paneId === paneId);
  const targetIndex = paneTabs.findIndex(
    (candidate) => candidate.id === targetId && !!candidate.pinned === !!tab.pinned,
  );
  const firstUnpinned = paneTabs.findIndex((candidate) => !candidate.pinned);
  const paneIndex = targetIndex >= 0
    ? targetIndex + (edge === 'after' ? 1 : 0)
    : tab.pinned
      ? firstUnpinned < 0 ? paneTabs.length : firstUnpinned
      : paneTabs.length;
  const anchor = paneTabs[paneIndex];
  const previous = paneTabs[paneIndex - 1];
  const index = anchor
    ? next.findIndex((candidate) => candidate.id === anchor.id)
    : previous
      ? next.findIndex((candidate) => candidate.id === previous.id) + 1
      : next.length;
  next.splice(index, 0, { ...tab, paneId });
  return next;
}

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  unreadOutputIds: new Set(),
  root: initial,
  activePaneId: initial.id,
  activeId: null,
  zoomedPaneId: null,
  open: (profile, title) => {
    const id = newId('tab');
    set((state) => {
      const pane = findPane(state.root, state.activePaneId) ?? firstPane(state.root);
      return {
        tabs: [
          ...state.tabs,
          {
            id,
            paneId: pane.id,
            title,
            profile,
            status: 'connecting',
            connectOnMount: true,
            sftpOpen: false,
            searchRequest: 0,
            editorPaths: [],
            loggingPaused: false,
            captureInput: false,
            reconnectRequest: 0,
          },
        ],
        root: updatePane(state.root, pane.id, (leaf) => ({ ...leaf, activeTabId: id })),
        activePaneId: pane.id,
        activeId: id,
      };
    });
    return id;
  },
  openEmpty: () => {
    const id = newId('tab');
    set((state) => {
      const pane = findPane(state.root, state.activePaneId) ?? firstPane(state.root);
      return {
        tabs: [
          ...state.tabs,
          {
            id,
            paneId: pane.id,
            title: 'New tab',
            profile: null,
            status: 'idle',
            connectOnMount: false,
            sftpOpen: false,
            searchRequest: 0,
            editorPaths: [],
            loggingPaused: false,
            captureInput: false,
            reconnectRequest: 0,
          },
        ],
        root: updatePane(state.root, pane.id, (leaf) => ({ ...leaf, activeTabId: id })),
        activePaneId: pane.id,
        activeId: id,
      };
    });
    return id;
  },
  replaceEmpty: (id, profile, title) => {
    let replaced = false;
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== id || tab.profile !== null) return tab;
        replaced = true;
        return {
          ...tab,
          title,
          profile,
          status: 'connecting' as const,
          connectOnMount: true as const,
          connId: undefined,
          sftpOpen: false,
          sftpAvailable: undefined,
          terminalCwd: undefined,
          searchRequest: 0,
          editorPaths: [],
          activeEditorPath: undefined,
          loggingEnabled: undefined,
          sessionLogId: undefined,
          loggingWarning: undefined,
          loggingPaused: false,
          captureInput: false,
          reconnectRequest: 0,
        };
      }),
    }));
    return replaced;
  },
  close: (id) =>
    set((state) => {
      const closing = state.tabs.find((tab) => tab.id === id);
      if (!closing) return state;
      const paneTabs = state.tabs.filter((tab) => tab.paneId === closing.paneId);
      const index = paneTabs.findIndex((tab) => tab.id === id);
      const replacement = paneTabs.filter((tab) => tab.id !== id)[Math.min(index, paneTabs.length - 2)]?.id ?? null;
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      // The last tab of a split pane takes the pane with it, the way closing
      // the last program in a tmux pane does.
      const collapsed = replacement === null ? collapsePane(state.root, closing.paneId) : undefined;
      if (collapsed) {
        const focused = state.activePaneId === closing.paneId;
        const zoomedPaneId = state.zoomedPaneId === closing.paneId ? null : state.zoomedPaneId;
        return {
          tabs,
          root: collapsed.root,
          unreadOutputIds: clearVisibleOutput(
            clearOutput(state.unreadOutputIds, id),
            tabs,
            collapsed.root,
            zoomedPaneId,
          ),
          zoomedPaneId,
          activePaneId: focused ? collapsed.focus.id : state.activePaneId,
          activeId: focused ? collapsed.focus.activeTabId : state.activeId,
        };
      }
      const pane = findPane(state.root, closing.paneId);
      const paneActiveId = pane?.activeTabId === id ? replacement : (pane?.activeTabId ?? null);
      const root = updatePane(state.root, closing.paneId, (leaf) => ({ ...leaf, activeTabId: paneActiveId }));
      return {
        tabs,
        root,
        unreadOutputIds: clearVisibleOutput(
          clearOutput(state.unreadOutputIds, id),
          tabs,
          root,
          state.zoomedPaneId,
        ),
        activeId: state.activeId === id ? paneActiveId : state.activeId,
      };
    }),
  activate: (id) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === id);
      if (!tab) return state;
      const root = updatePane(state.root, tab.paneId, (pane) => ({ ...pane, activeTabId: id }));
      const zoomedPaneId = state.zoomedPaneId === tab.paneId ? state.zoomedPaneId : null;
      return {
        unreadOutputIds: clearVisibleOutput(state.unreadOutputIds, state.tabs, root, zoomedPaneId),
        root,
        activePaneId: tab.paneId,
        activeId: id,
        zoomedPaneId,
      };
    }),
  focusPane: (paneId) =>
    set((state) => {
      const pane = findPane(state.root, paneId);
      if (!pane) return state;
      const zoomedPaneId = state.zoomedPaneId === paneId ? state.zoomedPaneId : null;
      return {
        unreadOutputIds: clearVisibleOutput(state.unreadOutputIds, state.tabs, state.root, zoomedPaneId),
        activePaneId: paneId,
        activeId: pane.activeTabId,
        zoomedPaneId,
      };
    }),
  cycle: (backwards) =>
    set((state) => {
      const paneTabs = state.tabs.filter((tab) => tab.paneId === state.activePaneId);
      if (paneTabs.length < 2) return state;
      const index = paneTabs.findIndex((tab) => tab.id === state.activeId);
      const next = (index + (backwards ? -1 : 1) + paneTabs.length) % paneTabs.length;
      const activeId = paneTabs[next]!.id;
      return {
        unreadOutputIds: clearOutput(state.unreadOutputIds, activeId),
        activeId,
        root: updatePane(state.root, state.activePaneId, (pane) => ({ ...pane, activeTabId: activeId })),
      };
    }),
  activateTabIndex: (index) => {
    const state = get();
    const target = tabsInOrder(state.root, state.tabs)[index];
    if (!target || target.id === state.activeId) return !!target;
    state.activate(target.id);
    return true;
  },
  moveTabWithinPane: (offset) => {
    const state = get();
    const paneTabs = state.tabs.filter((tab) => tab.paneId === state.activePaneId);
    const position = paneTabs.findIndex((tab) => tab.id === state.activeId);
    const swapWith = paneTabs[position + offset];
    if (position < 0 || !swapWith || !!swapWith.pinned !== !!paneTabs[position]!.pinned) {
      return false;
    }
    return state.reorderTab(
      paneTabs[position]!.id,
      swapWith.id,
      offset < 0 ? 'before' : 'after',
    );
  },
  reorderTab: (id, targetId, edge) => {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.id === id);
    const target = state.tabs.find((candidate) => candidate.id === targetId);
    if (
      !tab ||
      !target ||
      tab.id === target.id ||
      tab.paneId !== target.paneId ||
      !!tab.pinned !== !!target.pinned
    ) {
      return false;
    }
    return state.moveTabToPane(id, target.paneId, targetId, edge);
  },
  moveTabToPane: (id, paneId, targetId, edge = 'after') => {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.id === id);
    if (!tab || !findPane(state.root, paneId) || targetId === id) return false;
    if (targetId && !state.tabs.some((candidate) => candidate.id === targetId && candidate.paneId === paneId)) {
      return false;
    }
    const sourceId = tab.paneId;
    const sourceTabs = state.tabs.filter((candidate) => candidate.paneId === sourceId);
    const others = state.tabs.filter((candidate) => candidate.id !== id);
    const tabs = insertIntoPane(others, tab, paneId, targetId, edge);
    if (
      state.tabs.every(
        (candidate, index) =>
          candidate.id === tabs[index]?.id && candidate.paneId === tabs[index]?.paneId,
      )
    ) {
      return false;
    }
    if (sourceId === paneId) {
      set({ tabs });
      return true;
    }

    const sourceIndex = sourceTabs.findIndex((candidate) => candidate.id === id);
    const remaining = tabs.filter((candidate) => candidate.paneId === sourceId);
    const previousSourceActiveId = findPane(state.root, sourceId)?.activeTabId;
    const sourceActiveId = previousSourceActiveId === id
      ? remaining[Math.min(sourceIndex, remaining.length - 1)]?.id ?? null
      : previousSourceActiveId ?? null;
    let root = updatePane(state.root, sourceId, (pane) => ({ ...pane, activeTabId: sourceActiveId }));
    root = updatePane(root, paneId, (pane) => ({ ...pane, activeTabId: id }));
    let zoomedPaneId = state.zoomedPaneId;
    if (remaining.length === 0) {
      const collapsed = collapsePane(root, sourceId);
      if (collapsed) {
        root = collapsed.root;
        if (zoomedPaneId === sourceId) zoomedPaneId = null;
      }
    }
    const nextZoomedPaneId = zoomedPaneId === paneId ? zoomedPaneId : null;
    set({
      tabs,
      root,
      unreadOutputIds: clearVisibleOutput(state.unreadOutputIds, tabs, root, nextZoomedPaneId),
      activePaneId: paneId,
      activeId: id,
      zoomedPaneId: nextZoomedPaneId,
    });
    return true;
  },
  setPinned: (id, pinned) => {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.id === id);
    if (!tab || !!tab.pinned === pinned) return false;
    const paneTabs = state.tabs.filter((candidate) => candidate.paneId === tab.paneId);
    const reordered = paneTabs.filter((candidate) => candidate.id !== id);
    const boundary = reordered.findIndex((candidate) => !candidate.pinned);
    const index = boundary < 0 ? reordered.length : boundary;
    reordered.splice(index, 0, { ...tab, pinned: pinned || undefined });
    set({ tabs: replacePaneTabs(state.tabs, tab.paneId, reordered) });
    return true;
  },
  split: (paneId, direction) => {
    let created: string | undefined;
    set((state) => {
      if (!findPane(state.root, paneId)) return state;
      const { root, pane } = insertSplit(state.root, paneId, direction);
      created = pane.id;
      return {
        root,
        unreadOutputIds: clearVisibleOutput(state.unreadOutputIds, state.tabs, root, null),
        activePaneId: pane.id,
        activeId: null,
        zoomedPaneId: null,
      };
    });
    return created;
  },
  closePane: (paneId) =>
    set((state) => {
      const collapsed = collapsePane(state.root, paneId);
      if (!collapsed) return state;
      const focused = state.activePaneId === paneId;
      const zoomedPaneId = state.zoomedPaneId === paneId ? null : state.zoomedPaneId;
      const closedIds = new Set(
        state.tabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.id),
      );
      const remainingOutputIds = new Set(
        [...state.unreadOutputIds].filter((id) => !closedIds.has(id)),
      );
      const tabs = state.tabs.filter((tab) => tab.paneId !== paneId);
      return {
        tabs,
        root: collapsed.root,
        unreadOutputIds: clearVisibleOutput(remainingOutputIds, tabs, collapsed.root, zoomedPaneId),
        zoomedPaneId,
        activePaneId: focused ? collapsed.focus.id : state.activePaneId,
        activeId: focused ? collapsed.focus.activeTabId : state.activeId,
      };
    }),
  focusPaneDirection: (direction) => {
    const state = get();
    const target = neighborPaneId(state.root, state.activePaneId, direction);
    if (!target) return false;
    state.focusPane(target);
    return true;
  },
  cyclePane: (backwards) => {
    const state = get();
    const panes = panesInOrder(state.root);
    if (panes.length < 2) return false;
    const index = panes.findIndex((pane) => pane.id === state.activePaneId);
    const next = panes[(index + (backwards ? -1 : 1) + panes.length) % panes.length]!;
    state.focusPane(next.id);
    return true;
  },
  moveTabToDirection: (direction) => {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
    if (!tab) return false;
    const sourceId = tab.paneId;
    const sourceTabs = state.tabs.filter((candidate) => candidate.paneId === sourceId);
    const neighbor = neighborPaneId(state.root, sourceId, direction);
    // Splitting off the only tab of a pane would just move the pane around.
    if (!neighbor && sourceTabs.length < 2) return false;
    const targetId = neighbor ?? state.split(sourceId, direction);
    return targetId ? get().moveTabToPane(tab.id, targetId) : false;
  },
  moveTabToNewPane: (id, direction) => {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.id === id);
    if (!tab) return false;
    const sourceTabs = state.tabs.filter((candidate) => candidate.paneId === tab.paneId);
    // Splitting away the only tab would leave an empty source pane and merely
    // relocate the session, rather than turning a tabbed pair into two panes.
    if (sourceTabs.length < 2) return false;
    const targetId = state.split(tab.paneId, direction);
    return targetId ? get().moveTabToPane(tab.id, targetId) : false;
  },
  toggleZoom: (paneId) => {
    const state = get();
    const target = paneId ?? state.activePaneId;
    if (state.root.type === 'pane' && !state.zoomedPaneId) return false;
    const pane = findPane(state.root, target);
    if (!pane) return false;
    const zoomedPaneId = state.zoomedPaneId === target ? null : target;
    set({
      unreadOutputIds: clearVisibleOutput(state.unreadOutputIds, state.tabs, state.root, zoomedPaneId),
      zoomedPaneId,
      activePaneId: target,
      activeId: pane.activeTabId,
    });
    return true;
  },
  resizeSplit: (splitId, ratio) => set((state) => ({ root: updateSplitRatio(state.root, splitId, ratio) })),
  resizeActivePane: (delta) => {
    const state = get();
    const parent = parentSplit(state.root, state.activePaneId);
    if (!parent) return false;
    const ratio = parent.split.ratio + (parent.branch === 0 ? delta : -delta);
    set({ root: updateSplitRatio(state.root, parent.split.id, ratio) });
    return true;
  },
  equalizePanes: () => {
    const state = get();
    if (state.root.type === 'pane') return false;
    set({ root: equalizeSplits(state.root) });
    return true;
  },
  requestSearch: () =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeId ? { ...tab, searchRequest: tab.searchRequest + 1 } : tab,
      ),
    })),
  openEditor: (tabId, path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.profile
          ? {
              ...tab,
              editorPaths: tab.editorPaths.includes(path) ? tab.editorPaths : [...tab.editorPaths, path],
              activeEditorPath: path,
            }
          : tab,
      ),
    })),
  activateEditor: (tabId, path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.editorPaths.includes(path)
          ? { ...tab, activeEditorPath: path }
          : tab,
      ),
    })),
  closeEditor: (tabId, path) =>
    set((state) => {
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== tabId || !tab.editorPaths.includes(path)) return tab;
        const index = tab.editorPaths.indexOf(path);
        const editorPaths = tab.editorPaths.filter((candidate) => candidate !== path);
        const activeEditorPath =
          tab.activeEditorPath === path
            ? editorPaths[Math.min(index, editorPaths.length - 1)]
            : tab.activeEditorPath;
        return { ...tab, editorPaths, activeEditorPath };
      });
      return {
        tabs,
        unreadOutputIds: clearVisibleOutput(
          state.unreadOutputIds,
          tabs,
          state.root,
          state.zoomedPaneId,
        ),
      };
    }),
  restore: (layout, options) =>
    set((state) => {
      if (!layout.root) {
        const pane = initialPane();
        return {
          tabs: [],
          unreadOutputIds: new Set(),
          root: pane,
          activePaneId: pane.id,
          activeId: null,
          zoomedPaneId: null,
        };
      }
      const restored = restoreWorkspaceLayout(layout, options);
      if (!restored) return state;
      return {
        ...restored,
        zoomedPaneId: null,
        unreadOutputIds: new Set(),
        tabs: restored.tabs.map((tab) => ({
          ...tab,
          restored: true,
          status: tab.connectOnMount ? 'connecting' as const : 'closed' as const,
          sftpOpen: false,
          sftpAvailable: undefined,
          terminalCwd: undefined,
          searchRequest: 0,
          editorPaths: [],
          activeEditorPath: undefined,
          loggingEnabled: undefined,
          sessionLogId: undefined,
          loggingWarning: undefined,
          loggingPaused: false,
          captureInput: false,
          reconnectRequest: 0,
        })),
      };
    }),
  launchSet: (entries, layout) => {
    if (entries.length === 0) return [];
    const ids = entries.map(() => newId('tab'));
    const paneIds =
      layout === 'tabs'
        ? [newId('pane')]
        : entries.map(() => newId('pane'));
    const tabs: SessionTab[] = entries.map((entry, index) => ({
      id: ids[index]!,
      paneId: layout === 'tabs' ? paneIds[0]! : paneIds[index]!,
      title: entry.title,
      profile: entry.profile,
      status: 'connecting',
      connectOnMount: true,
      sftpOpen: false,
      searchRequest: 0,
      color: entry.color,
      editorPaths: [],
      loggingPaused: false,
      captureInput: false,
      reconnectRequest: 0,
    }));
    const leaves = paneIds.map(
      (id, index): PaneLeaf => ({
        id,
        type: 'pane',
        activeTabId: layout === 'tabs' ? ids.at(-1)! : ids[index]!,
      }),
    );
    const root =
      layout === 'tabs'
        ? leaves[0]!
        : buildSessionSetTree(
            leaves,
            layout === 'rows' ? 'vertical' : 'horizontal',
            layout === 'grid',
          );
    const activePane = firstPane(root);
    set({
      tabs,
      root,
      unreadOutputIds: new Set(),
      activePaneId: activePane.id,
      activeId: activePane.activeTabId,
      zoomedPaneId: null,
    });
    return ids;
  },
  reconnect: (tabIds, options) => {
    const requested = new Set(tabIds);
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.profile && tab.status === 'closed' && requested.has(tab.id)
          ? {
              ...tab,
              status: 'connecting' as const,
              connectOnMount: true,
              terminalId: undefined,
              transferId: undefined,
              reconnectRequest: tab.reconnectRequest + 1,
              reconnectMode:
                tab.profile.kind === 'ssh' ? options?.reattach : undefined,
              failureReason: undefined,
              disconnectReason: undefined,
            }
          : tab,
      ),
    }));
  },
  reconnectAll: (options) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.profile && tab.status === 'closed'
          ? {
              ...tab,
              status: 'connecting' as const,
              connectOnMount: true,
              terminalId: undefined,
              transferId: undefined,
              reconnectRequest: tab.reconnectRequest + 1,
              reconnectMode:
                tab.profile.kind === 'ssh' ? options?.reattach : undefined,
              failureReason: undefined,
              disconnectReason: undefined,
            }
          : tab,
      ),
    })),
  notifyOutput: (id) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === id);
      if (!tab?.profile) return state;
      const visible = terminalIsVisible(tab, state.root, state.zoomedPaneId);
      const unread = state.unreadOutputIds.has(id);
      if (unread === !visible) return state;
      const unreadOutputIds = new Set(state.unreadOutputIds);
      if (visible) unreadOutputIds.delete(id);
      else unreadOutputIds.add(id);
      return { unreadOutputIds };
    }),
  update: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        if (tab.profile) return { ...tab, ...patch };
        const {
          status: _status,
          connId: _connId,
          sftpOpen: _sftpOpen,
          sftpAvailable: _sftpAvailable,
          terminalCwd: _terminalCwd,
          sftpFollowTerminal: _sftpFollowTerminal,
          ...emptyPatch
        } = patch;
        return { ...tab, ...emptyPatch };
      }),
    })),
}));

function buildSessionSetTree(
  panes: readonly PaneLeaf[],
  direction: 'horizontal' | 'vertical',
  grid: boolean,
  depth = 0,
): PaneNode {
  if (panes.length === 1) return panes[0]!;
  const midpoint = Math.ceil(panes.length / 2);
  const first = panes.slice(0, midpoint);
  const second = panes.slice(midpoint);
  const splitDirection =
    grid && depth % 2 === 1
      ? direction === 'horizontal'
        ? 'vertical'
        : 'horizontal'
      : direction;
  return {
    id: newId('split'),
    type: 'split',
    direction: splitDirection,
    ratio: first.length / panes.length,
    children: [
      buildSessionSetTree(first, direction, grid, depth + 1),
      buildSessionSetTree(second, direction, grid, depth + 1),
    ],
  };
}

export type { PaneDirection, PaneLeaf, PaneNode };
