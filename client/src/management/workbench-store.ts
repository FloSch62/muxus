import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ManagementError, ManagementProtocol, ManagementResult } from '@muxus/shared';
import { createRoot, KeyRegistry, type DataNode } from './data-tree.js';
import type { LiveTable } from './live-table.js';
import {
  defaultGnmiDraft,
  defaultNetconfDraft,
  type GnmiDraft,
  type ManagementDraft,
  type NetconfDraft,
} from './requests.js';

/**
 * Everything one NETCONF or gNMI tab remembers: the request being edited,
 * every run with its result, and the explorer tree. It belongs to the tab,
 * not the connection, so a reconnect keeps drafts, results and history.
 */

export type RunStatus = 'running' | 'streaming' | 'ok' | 'error' | 'cancelled';

export interface RunRecord {
  id: string;
  draft: ManagementDraft;
  /** Short label of the operation: "Get", "Subscribe", "edit-config", … */
  label: string;
  summary: string;
  startedAt: number;
  status: RunStatus;
  durationMs?: number;
  bytes?: number;
  error?: ManagementError;
  result?: ManagementResult;
  /** Subscriptions: the live values, updated in place. */
  live?: LiveTable;
  /** Subscriptions: the device finished sending the initial state. */
  synced?: boolean;
  /** Set by internal helpers (explorer, candidate checks) that stay out of history. */
  hidden?: boolean;
}

export type NavigatorTab = 'explore' | 'library' | 'history' | 'device';
/** What the gNMI workbench shows: data (gNMI), operations (gNOI) or security (gNSI). */
export type WorkbenchArea = 'data' | 'operations' | 'security';
export type ResultView = 'tree' | 'table' | 'raw';

export interface ExplorerState {
  root: DataNode;
  registry: KeyRegistry;
  expanded: Set<string>;
  loading: Set<string>;
  errors: Map<string, string>;
  selected?: string;
  /** gNMI: data type to browse. NETCONF: configuration only, or with state. */
  scope: 'config' | 'all';
  /** gNMI: the device ignored or rejected the depth extension. */
  noDepth?: boolean;
  /** Bumped on every in-place change of the tree or its sets. */
  version: number;
}

export interface WorkbenchState {
  protocol: ManagementProtocol;
  draft: ManagementDraft;
  runs: RunRecord[];
  selectedRunId?: string;
  navigator: NavigatorTab;
  navigatorOpen: boolean;
  resultView: ResultView;
  explorer: ExplorerState;
  /** NETCONF candidate datastore: uncommitted changes, as last checked. */
  candidate?: { dirty: boolean; checking: boolean; checkedAt?: number; error?: string };
  /** A confirmed commit waiting to be confirmed, with its deadline. */
  confirmDeadline?: number;
  /** gNMI: the commit-confirmed id the confirmation or rollback must name. */
  commitId?: string;
  /** Datastores this session holds a lock on. */
  locks: string[];
  /** The SSH login banner the device showed, if any. */
  banner?: string;
  /** NETCONF notifications received after create-subscription. */
  notifications: Array<{ xml: string; eventTime?: string; receivedAt: string }>;
  area: WorkbenchArea;
  /** The tool open in each tools area. */
  tool: { operations: string; security: string };
  /** Each tool's own state (form, last result), kept while you look at another. */
  tools: Record<string, unknown>;
  setArea(area: WorkbenchArea): void;
  setTool(area: 'operations' | 'security', tool: string): void;
  setToolState(key: string, update: (current: unknown) => unknown): void;

  setDraft(update: Partial<ManagementDraft> | ((draft: ManagementDraft) => ManagementDraft)): void;
  replaceDraft(draft: ManagementDraft): void;
  addRun(run: RunRecord): void;
  updateRun(id: string, patch: Partial<RunRecord>): void;
  selectRun(id: string | undefined): void;
  clearHistory(): void;
  setNavigator(tab: NavigatorTab): void;
  setNavigatorOpen(open: boolean): void;
  setResultView(view: ResultView): void;
  touchExplorer(update?: (explorer: ExplorerState) => void): void;
  resetExplorer(scope?: 'config' | 'all'): void;
}

const MAX_RUNS = 100;

function freshExplorer(scope: 'config' | 'all'): ExplorerState {
  return {
    root: createRoot(),
    registry: new KeyRegistry(),
    expanded: new Set(['']),
    loading: new Set(),
    errors: new Map(),
    scope,
    version: 0,
  };
}

export type WorkbenchStore = StoreApi<WorkbenchState>;

export function createWorkbenchStore(protocol: ManagementProtocol): WorkbenchStore {
  return createStore<WorkbenchState>()((set, get) => ({
    protocol,
    draft: protocol === 'gnmi' ? defaultGnmiDraft() : defaultNetconfDraft(),
    runs: [],
    navigator: 'explore',
    navigatorOpen: true,
    resultView: 'tree',
    explorer: freshExplorer(protocol === 'gnmi' ? 'all' : 'config'),
    locks: [],
    notifications: [],
    area: 'data',
    tool: { operations: 'ping', security: 'authz' },
    tools: {},
    setArea: (area) => set({ area }),
    setTool: (area, tool) => set((state) => ({ tool: { ...state.tool, [area]: tool } })),
    setToolState: (key, update) => set((state) => ({ tools: { ...state.tools, [key]: update(state.tools[key]) } })),

    setDraft: (update) =>
      set((state) => ({
        draft:
          typeof update === 'function'
            ? update(state.draft)
            : ({ ...state.draft, ...update } as GnmiDraft | NetconfDraft),
      })),
    replaceDraft: (draft) => set({ draft }),
    addRun: (run) =>
      set((state) => {
        const runs = [run, ...state.runs];
        // Drop the oldest finished runs; live subscriptions stay.
        while (runs.length > MAX_RUNS) {
          const index = runs.map((candidate) => candidate.status).lastIndexOf('ok');
          runs.splice(index >= 0 ? index : runs.length - 1, 1);
        }
        return { runs, selectedRunId: run.hidden ? state.selectedRunId : run.id };
      }),
    updateRun: (id, patch) =>
      set((state) => ({ runs: state.runs.map((run) => (run.id === id ? { ...run, ...patch } : run)) })),
    selectRun: (id) => set({ selectedRunId: id }),
    clearHistory: () =>
      set((state) => {
        const running = state.runs.filter((run) => run.status === 'running' || run.status === 'streaming');
        return {
          runs: running,
          selectedRunId: running.some((run) => run.id === state.selectedRunId) ? state.selectedRunId : undefined,
        };
      }),
    setNavigator: (navigator) => set({ navigator, navigatorOpen: true }),
    setNavigatorOpen: (navigatorOpen) => set({ navigatorOpen }),
    setResultView: (resultView) => set({ resultView }),
    touchExplorer: (update) => {
      const explorer = get().explorer;
      update?.(explorer);
      set({ explorer: { ...explorer, version: explorer.version + 1 } });
    },
    resetExplorer: (scope) =>
      set((state) => ({ explorer: freshExplorer(scope ?? state.explorer.scope) })),
  }));
}
