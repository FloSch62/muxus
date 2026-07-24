import { create } from 'zustand';
import type { SessionProfile, WorkspaceLayoutV1 } from '@muxus/shared';
import {
  findPane,
  firstPane,
  removePane,
  restoreWorkspace as restoreWorkspaceLayout,
  updatePane,
  updateSplitRatio,
  type PaneLeaf,
  type PaneNode,
} from './workspace-layout.js';

export type TabStatus = 'connecting' | 'connected' | 'closed';

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
}>;

export interface SessionSetEntry {
  profile: SessionProfile;
  title: string;
  color?: string;
}

export type SessionSetLayout = 'tabs' | 'columns' | 'rows' | 'grid';

interface TabsState {
  tabs: TerminalTab[];
  root: PaneNode;
  activePaneId: string;
  activeId: string | null;
  open: (profile: SessionProfile, title: string) => string;
  openEmpty: () => string;
  replaceEmpty: (id: string, profile: SessionProfile, title: string) => boolean;
  close: (id: string) => void;
  activate: (id: string) => void;
  focusPane: (paneId: string) => void;
  cycle: (backwards: boolean) => void;
  split: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  closePane: (paneId: string) => void;
  resizeSplit: (splitId: string, ratio: number) => void;
  requestSearch: () => void;
  openEditor: (tabId: string, path: string) => void;
  activateEditor: (tabId: string, path: string) => void;
  closeEditor: (tabId: string, path: string) => void;
  restore: (layout: WorkspaceLayoutV1) => void;
  /** Replace the pane canvas with a freshly connected, arranged session set. */
  launchSet: (entries: readonly SessionSetEntry[], layout: SessionSetLayout) => string[];
  /** Start fresh connections for selected ended/restored sessions. */
  reconnect: (tabIds: readonly string[]) => void;
  update: (id: string, patch: TabUpdate) => void;
}

let nextId = 1;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${nextId++}`;
const initialPane = (): PaneLeaf => ({ id: newId('pane'), type: 'pane', activeTabId: null });
const initial = initialPane();

export const useTabsStore = create<TabsState>()((set) => ({
  tabs: [],
  root: initial,
  activePaneId: initial.id,
  activeId: null,
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
      const pane = findPane(state.root, closing.paneId);
      const paneActiveId = pane?.activeTabId === id ? replacement : (pane?.activeTabId ?? null);
      return {
        tabs: state.tabs.filter((tab) => tab.id !== id),
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
      };
    }),
  focusPane: (paneId) =>
    set((state) => {
      const pane = findPane(state.root, paneId);
      if (!pane) return state;
      return { activePaneId: paneId, activeId: pane.activeTabId };
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
  split: (paneId, direction) =>
    set((state) => {
      if (!findPane(state.root, paneId)) return state;
      const newPane: PaneLeaf = { id: newId('pane'), type: 'pane', activeTabId: null };
      const root = updatePane(state.root, paneId, (pane) => ({
        id: newId('split'),
        type: 'split',
        direction,
        ratio: 0.5,
        children: [pane, newPane],
      }));
      return { root, activePaneId: newPane.id, activeId: null };
    }),
  closePane: (paneId) =>
    set((state) => {
      if (state.root.type === 'pane') return state;
      const root = removePane(state.root, paneId);
      if (!root) return state;
      const activePane = firstPane(root);
      return {
        tabs: state.tabs.filter((tab) => tab.paneId !== paneId),
        root,
        activePaneId: state.activePaneId === paneId ? activePane.id : state.activePaneId,
        activeId: state.activePaneId === paneId ? activePane.activeTabId : state.activeId,
      };
    }),
  resizeSplit: (splitId, ratio) => set((state) => ({ root: updateSplitRatio(state.root, splitId, ratio) })),
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
        };
      }
      const restored = restoreWorkspaceLayout(layout);
      if (!restored) return state;
      return {
        ...restored,
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
    });
    return ids;
  },
  reconnect: (tabIds) => {
    const requested = new Set(tabIds);
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.profile && tab.status === 'closed' && requested.has(tab.id)
          ? {
              ...tab,
              status: 'connecting' as const,
              connectOnMount: true,
              reconnectRequest: tab.reconnectRequest + 1,
            }
          : tab,
      ),
    }));
  },
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

export type { PaneLeaf, PaneNode };
