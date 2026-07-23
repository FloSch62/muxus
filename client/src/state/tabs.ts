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
  /** Live connection id from the server's `ready` (SSH only) — keys SFTP/forwards. */
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
}

export interface SessionTab extends TabBase {
  profile: SessionProfile;
  status: TabStatus;
  /** Restored layouts wait for an explicit reconnect instead of starting a new process. */
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
}>;

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
      if (state.root.type === 'pane' || state.tabs.some((tab) => tab.paneId === paneId)) return state;
      const root = removePane(state.root, paneId);
      if (!root) return state;
      const activePane = firstPane(root);
      return {
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
      const restored = restoreWorkspaceLayout(layout);
      if (!restored) return state;
      return {
        ...restored,
        tabs: restored.tabs.map((tab) => ({
          ...tab,
          status: 'closed' as const,
          sftpOpen: false,
          searchRequest: 0,
          editorPaths: [],
          activeEditorPath: undefined,
        })),
      };
    }),
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

export type { PaneLeaf, PaneNode };
