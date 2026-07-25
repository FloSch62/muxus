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
} from './workspace-layout.js';

export type TabStatus = 'connecting' | 'connected' | 'interrupted' | 'closed';

interface TabBase {
  id: string;
  paneId: string;
  title: string;
  /** Live SSH connection id from `ready`; absent for local, Telnet, and serial tabs. */
  connId?: string;
  /** SFTP file panel visible for this tab. */
  sftpOpen: boolean;
  /** Monotonic UI signal consumed by the mounted terminal search bar. */
  searchRequest: number;
  /** User-set color flag marking the tab. */
  color?: string;
  /** Remote files open in the Monaco workspace attached to this session. */
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

type TabUpdate = Partial<{
  title: string;
  status: TabStatus;
  connId: string | undefined;
  sftpOpen: boolean;
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
  /** Activate the nth tab of the focused pane, or its last one. */
  activateTabIndex: (index: number | 'last') => boolean;
  /** Reorder the active tab inside its own pane. */
  moveTabWithinPane: (offset: -1 | 1) => boolean;
  split: (paneId: string, direction: PaneDirection) => string | undefined;
  closePane: (paneId: string) => void;
  /** Focus the pane that borders the active one in a direction. */
  focusPaneDirection: (direction: PaneDirection) => boolean;
  /** Focus the next/previous pane in reading order. */
  cyclePane: (backwards: boolean) => boolean;
  /** Move the active tab to the bordering pane, splitting off a new one when there is none. */
  moveTabToDirection: (direction: PaneDirection) => boolean;
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
  restore: (layout: WorkspaceLayoutV1) => void;
  /** Replace the pane canvas with a freshly connected, arranged session set. */
  launchSet: (entries: readonly SessionSetEntry[], layout: SessionSetLayout) => string[];
  /** Start fresh connections for selected ended/restored sessions. */
  reconnect: (tabIds: readonly string[], options?: ReconnectOptions) => void;
  /** Reconnect every ended/restored session in the current workspace. */
  reconnectAll: (options?: ReconnectOptions) => void;
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

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
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
        return {
          tabs,
          root: collapsed.root,
          zoomedPaneId: state.zoomedPaneId === closing.paneId ? null : state.zoomedPaneId,
          activePaneId: focused ? collapsed.focus.id : state.activePaneId,
          activeId: focused ? collapsed.focus.activeTabId : state.activeId,
        };
      }
      const pane = findPane(state.root, closing.paneId);
      const paneActiveId = pane?.activeTabId === id ? replacement : (pane?.activeTabId ?? null);
      return {
        tabs,
        root: updatePane(state.root, closing.paneId, (leaf) => ({ ...leaf, activeTabId: paneActiveId })),
        activeId: state.activeId === id ? paneActiveId : state.activeId,
      };
    }),
  activate: (id) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === id);
      if (!tab) return state;
      return {
        root: updatePane(state.root, tab.paneId, (pane) => ({ ...pane, activeTabId: id })),
        activePaneId: tab.paneId,
        activeId: id,
        zoomedPaneId: state.zoomedPaneId === tab.paneId ? state.zoomedPaneId : null,
      };
    }),
  focusPane: (paneId) =>
    set((state) => {
      const pane = findPane(state.root, paneId);
      if (!pane) return state;
      return {
        activePaneId: paneId,
        activeId: pane.activeTabId,
        zoomedPaneId: state.zoomedPaneId === paneId ? state.zoomedPaneId : null,
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
        activeId,
        root: updatePane(state.root, state.activePaneId, (pane) => ({ ...pane, activeTabId: activeId })),
      };
    }),
  activateTabIndex: (index) => {
    const state = get();
    const paneTabs = state.tabs.filter((tab) => tab.paneId === state.activePaneId);
    const target = index === 'last' ? paneTabs.at(-1) : paneTabs[index];
    if (!target || target.id === state.activeId) return paneTabs.length > 0;
    state.activate(target.id);
    return true;
  },
  moveTabWithinPane: (offset) => {
    const state = get();
    const paneTabs = state.tabs.filter((tab) => tab.paneId === state.activePaneId);
    const position = paneTabs.findIndex((tab) => tab.id === state.activeId);
    const swapWith = paneTabs[position + offset];
    if (position < 0 || !swapWith) return false;
    const tabs = [...state.tabs];
    const from = tabs.findIndex((tab) => tab.id === paneTabs[position]!.id);
    const to = tabs.findIndex((tab) => tab.id === swapWith.id);
    [tabs[from], tabs[to]] = [tabs[to]!, tabs[from]!];
    set({ tabs });
    return true;
  },
  split: (paneId, direction) => {
    let created: string | undefined;
    set((state) => {
      if (!findPane(state.root, paneId)) return state;
      const { root, pane } = insertSplit(state.root, paneId, direction);
      created = pane.id;
      return { root, activePaneId: pane.id, activeId: null, zoomedPaneId: null };
    });
    return created;
  },
  closePane: (paneId) =>
    set((state) => {
      const collapsed = collapsePane(state.root, paneId);
      if (!collapsed) return state;
      const focused = state.activePaneId === paneId;
      return {
        tabs: state.tabs.filter((tab) => tab.paneId !== paneId),
        root: collapsed.root,
        zoomedPaneId: state.zoomedPaneId === paneId ? null : state.zoomedPaneId,
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

    let root = state.root;
    let targetId = neighbor;
    if (!targetId) {
      const inserted = insertSplit(root, sourceId, direction);
      root = inserted.root;
      targetId = inserted.pane.id;
    }

    const others = state.tabs.filter((candidate) => candidate.id !== tab.id);
    const lastOfTarget = others.reduce(
      (found, candidate, index) => (candidate.paneId === targetId ? index : found),
      -1,
    );
    const tabs = [...others];
    tabs.splice(lastOfTarget >= 0 ? lastOfTarget + 1 : tabs.length, 0, { ...tab, paneId: targetId });

    const remaining = tabs.filter((candidate) => candidate.paneId === sourceId);
    const sourceIndex = sourceTabs.findIndex((candidate) => candidate.id === tab.id);
    const sourceActiveId = remaining[Math.min(sourceIndex, remaining.length - 1)]?.id ?? null;
    root = updatePane(root, targetId, (pane) => ({ ...pane, activeTabId: tab.id }));
    root = updatePane(root, sourceId, (pane) => ({ ...pane, activeTabId: sourceActiveId }));

    let zoomedPaneId = state.zoomedPaneId;
    if (remaining.length === 0) {
      const collapsed = collapsePane(root, sourceId);
      if (collapsed) {
        root = collapsed.root;
        if (zoomedPaneId === sourceId) zoomedPaneId = null;
      }
    }
    set({
      tabs,
      root,
      activePaneId: targetId,
      activeId: tab.id,
      zoomedPaneId: zoomedPaneId === targetId ? zoomedPaneId : null,
    });
    return true;
  },
  toggleZoom: (paneId) => {
    const state = get();
    const target = paneId ?? state.activePaneId;
    if (state.root.type === 'pane' && !state.zoomedPaneId) return false;
    const pane = findPane(state.root, target);
    if (!pane) return false;
    set({
      zoomedPaneId: state.zoomedPaneId === target ? null : target,
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
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId || !tab.editorPaths.includes(path)) return tab;
        const index = tab.editorPaths.indexOf(path);
        const editorPaths = tab.editorPaths.filter((candidate) => candidate !== path);
        const activeEditorPath =
          tab.activeEditorPath === path
            ? editorPaths[Math.min(index, editorPaths.length - 1)]
            : tab.activeEditorPath;
        return { ...tab, editorPaths, activeEditorPath };
      }),
    })),
  restore: (layout) =>
    set((state) => {
      if (!layout.root) {
        const pane = initialPane();
        return {
          tabs: [],
          root: pane,
          activePaneId: pane.id,
          activeId: null,
          zoomedPaneId: null,
        };
      }
      const restored = restoreWorkspaceLayout(layout);
      if (!restored) return state;
      return {
        ...restored,
        zoomedPaneId: null,
        tabs: restored.tabs.map((tab) => ({
          ...tab,
          status: tab.connectOnMount ? 'connecting' as const : 'closed' as const,
          sftpOpen: false,
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
              reconnectRequest: tab.reconnectRequest + 1,
              reconnectMode:
                tab.profile.kind === 'ssh' ? options?.reattach : undefined,
              failureReason: undefined,
              disconnectReason: undefined,
            }
          : tab,
      ),
    })),
  update: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        if (tab.profile) return { ...tab, ...patch };
        const { status: _status, connId: _connId, sftpOpen: _sftpOpen, ...emptyPatch } = patch;
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
