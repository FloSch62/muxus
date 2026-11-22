import { create } from 'zustand';
import type { SavedHostProfile, SshGateway, SshHostEntry } from '@muxus/shared';
import type { CompareText } from '../compare-sources.js';
import type { HostDraft } from '../components/host-editor/draft.js';
import { openSettingsWindow } from '../window-management.js';
import { usePrefsStore } from './prefs.js';

/** Unified editor state for OpenSSH entries and Muxus-owned Telnet/serial/RDP/VNC hosts. */
export type HostEditorState =
  | false
  | {
      mode: 'new';
      prefillTarget?: string;
      /** Name for the new host, e.g. when adding a gNMI host for an SSH one. */
      prefillName?: string;
      /** SSH gateway for a new gNMI or NETCONF host, e.g. the jump host of the SSH one it is for. */
      prefillGateway?: SshGateway;
      group?: string;
      kind?: SavedHostProfile['kind'];
      /** A new SSH host already filled in, e.g. a container found on a host. */
      draft?: HostDraft;
    }
  | { mode: 'duplicate'; entry: SshHostEntry }
  | { mode: 'edit'; entry: SshHostEntry }
  | { mode: 'duplicate-profile'; entry: SavedHostProfile }
  | { mode: 'edit-profile'; entry: SavedHostProfile };

/**
 * Sidebar folder editing. Folders are group paths rather than records, so each
 * mode is ultimately a rewrite of one path prefix.
 */
export type FolderDialogState =
  | false
  /** Create a folder, optionally already nested under `parentPath`. */
  | { mode: 'new'; parentPath?: string }
  /** Rename, re-parent, colour or icon an existing folder. */
  | { mode: 'edit'; path: string }
  /**
   * Pick the folder hosts should live in. `currentPath` is the folder they all
   * share, or '' when they are spread across several.
   */
  | { mode: 'move-hosts'; hostKeys: string[]; hostName?: string; currentPath: string };

/**
 * Shared sessions, asked for from the sidebar or the quick launcher: follow
 * a link (or change the one with `sourceId`), or publish a folder as a list.
 */
export type SharedSessionsDialogState =
  | false
  | { mode: 'link'; sourceId?: string }
  | { mode: 'share'; path: string };

export const SETTINGS_SECTIONS = [
  'appearance',
  'terminal',
  'local-shells',
  'logging',
  'highlighting',
  'behavior',
  'x11',
  'keyboard',
  'passwords',
  'data',
  'debug',
  'about',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly unknown[]).includes(value);
}

/** What the sidebar's panel shows. */
export type SidebarView = 'hosts' | 'files' | 'environments' | 'forwarding';

export const SIDEBAR_VIEWS: readonly SidebarView[] = ['hosts', 'files', 'environments', 'forwarding'];

/** Where settings open, and the entry in that section to bring into view,
 * such as one local shell profile. */
export interface SettingsTarget {
  section: SettingsSection;
  item?: string;
}

interface UiState {
  /** Temporary distraction-free presentation; saved visibility preferences stay untouched. */
  focusMode: boolean;
  /** The settings dialog of a regular browser; the desktop app opens a window. */
  settingsOpen: boolean;
  /** Read when the dialog opens; null opens its first section. */
  settingsTarget: SettingsTarget | null;
  commandButtonMenuOpen: boolean;
  commandButtonsOpen: boolean;
  /** The Scripts dialog, with the hosts to run on already picked when opened from a selection. */
  scriptsDialog: false | { hostKeys?: string[] };
  /** The Send secret… picker beside the active terminal cursor. */
  sendSecretMenuOpen: boolean;
  /**
   * Command button group picked while a session whose host opens its own
   * group was active, by tab id. Kept per window and never persisted, so
   * switching tabs cannot rewrite the saved preferences.
   */
  commandButtonGroupByTab: Readonly<Record<string, string>>;
  shortcutsOpen: boolean;
  quickLauncherOpen: boolean;
  historyOpen: boolean;
  historyQuery: string;
  historySelectedId?: string;
  /** The compare dialog, opened with the side it was invoked from. */
  compareSource: CompareText | false;
  /** Changes with each new source, so the dialog starts over instead of keeping the last one's state. */
  compareId: number;
  workspacesOpen: boolean;
  hostEditor: HostEditorState;
  /** Host whose Muxus-only display metadata is being organized. */
  hostOrganizer: SshHostEntry | SavedHostProfile | false;
  /** Hosts edited together, by managed host key. */
  hostBulkEditor: string[] | false;
  /** Sidebar folder being created, renamed, styled, or picked as a target. */
  folderDialog: FolderDialogState;
  /** Following a shared sessions link, or sharing a folder as one. */
  sharedSessionsDialog: SharedSessionsDialogState;
  /**
   * The forwarding view (saved tunnels + live forwards) is in front of the
   * open sidebar panel. Follows `sidebarView`; set it through the actions.
   */
  forwardingOpen: boolean;
  /**
   * The containers, clusters and VMs view while it is in front of the open
   * sidebar panel: every host found so far, or one host (`hostKey`) opened
   * from its sidebar badge or menu. Follows `sidebarView` like the above.
   */
  environmentsPanel: { hostKey?: string } | false;
  /**
   * The sidebar view in front. Kept per window and never persisted, like the
   * window's tabs, so each window browses its own sessions.
   */
  sidebarView: SidebarView;
  /** Whether the panel is open beside the rail; closed, the rail stands alone. */
  sidebarPanelOpen: boolean;
  /** Folder the hosts are narrowed to in the folder scope view; '' is every host. */
  sidebarScopePath: string;
  /** Diagnostic log viewer (settings → debug). */
  logViewerOpen: boolean;
  setFocusMode: (active: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  openSettings: (target: SettingsTarget) => void;
  setCommandButtonMenuOpen: (open: boolean) => void;
  setCommandButtonsOpen: (open: boolean) => void;
  setScriptsDialog: (state: false | { hostKeys?: string[] }) => void;
  setSendSecretMenuOpen: (open: boolean) => void;
  setCommandButtonGroupForTab: (tabId: string, groupId: string) => void;
  setShortcutsOpen: (open: boolean) => void;
  setQuickLauncherOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  openHistory: (query?: string, selectedId?: string) => void;
  setCompareSource: (source: CompareText | false) => void;
  setWorkspacesOpen: (open: boolean) => void;
  setHostEditor: (value: HostEditorState) => void;
  setHostOrganizer: (value: SshHostEntry | SavedHostProfile | false) => void;
  setHostBulkEditor: (hostKeys: string[] | false) => void;
  setFolderDialog: (value: FolderDialogState) => void;
  setSharedSessionsDialog: (value: SharedSessionsDialogState) => void;
  setForwardingOpen: (open: boolean) => void;
  setEnvironmentsPanel: (value: { hostKey?: string } | false) => void;
  /** Bring a view to the front, opening the panel and a hidden sidebar for it. */
  setSidebarView: (view: SidebarView) => void;
  /** The rail's click: open the view, or close the panel when it is already in front. */
  toggleSidebarView: (view: SidebarView) => void;
  setSidebarPanelOpen: (open: boolean) => void;
  setSidebarScopePath: (path: string) => void;
  setLogViewerOpen: (open: boolean) => void;
}

type SidebarViewState = Pick<
  UiState,
  'sidebarView' | 'sidebarPanelOpen' | 'forwardingOpen' | 'environmentsPanel'
>;

/**
 * The one place the panel's view changes. `forwardingOpen` and
 * `environmentsPanel` are kept in step here, so everything that reads them
 * still answers "is that view on screen" without knowing about the panel.
 */
function sidebarViewPatch(
  state: SidebarViewState,
  view: SidebarView,
  open: boolean,
  environments?: { hostKey?: string },
): SidebarViewState {
  return {
    sidebarView: view,
    sidebarPanelOpen: open,
    forwardingOpen: open && view === 'forwarding',
    environmentsPanel:
      open && view === 'environments' ? (environments ?? (state.environmentsPanel || {})) : false,
  };
}

/** Open the panel on a view. Asking for one also brings back a hidden sidebar. */
function showSidebarView(
  state: SidebarViewState,
  view: SidebarView,
  environments?: { hostKey?: string },
): SidebarViewState {
  const prefs = usePrefsStore.getState();
  if (prefs.sidebarCollapsed) prefs.set({ sidebarCollapsed: false });
  return sidebarViewPatch(state, view, true, environments);
}

export const useUiStore = create<UiState>()((set) => ({
  focusMode: false,
  settingsOpen: false,
  settingsTarget: null,
  commandButtonMenuOpen: false,
  commandButtonsOpen: false,
  scriptsDialog: false,
  sendSecretMenuOpen: false,
  commandButtonGroupByTab: {},
  shortcutsOpen: false,
  quickLauncherOpen: false,
  historyOpen: false,
  historyQuery: '',
  compareSource: false,
  compareId: 0,
  workspacesOpen: false,
  hostEditor: false,
  hostOrganizer: false,
  hostBulkEditor: false,
  folderDialog: false,
  sharedSessionsDialog: false,
  forwardingOpen: false,
  environmentsPanel: false,
  sidebarView: 'hosts',
  sidebarPanelOpen: true,
  sidebarScopePath: '',
  logViewerOpen: false,
  setFocusMode: (focusMode) => set({ focusMode }),
  // The desktop app opens (or raises) the settings window instead of the dialog.
  setSettingsOpen: (settingsOpen) => {
    if (settingsOpen && openSettingsWindow()) return;
    set({ settingsOpen, settingsTarget: null });
  },
  openSettings: (settingsTarget) => {
    if (openSettingsWindow(settingsTarget)) return;
    set({ settingsOpen: true, settingsTarget });
  },
  setCommandButtonMenuOpen: (commandButtonMenuOpen) => set({ commandButtonMenuOpen }),
  setCommandButtonsOpen: (commandButtonsOpen) => set({ commandButtonsOpen }),
  setScriptsDialog: (scriptsDialog) => set({ scriptsDialog }),
  setSendSecretMenuOpen: (sendSecretMenuOpen) => set({ sendSecretMenuOpen }),
  setCommandButtonGroupForTab: (tabId, groupId) =>
    set((state) => ({
      commandButtonGroupByTab: { ...state.commandButtonGroupByTab, [tabId]: groupId },
    })),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setQuickLauncherOpen: (quickLauncherOpen) => set({ quickLauncherOpen }),
  setHistoryOpen: (historyOpen) =>
    set({
      historyOpen,
      ...(historyOpen ? { historyQuery: '', historySelectedId: undefined } : {}),
    }),
  openHistory: (historyQuery = '', historySelectedId) =>
    set({ historyOpen: true, historyQuery, historySelectedId }),
  setCompareSource: (compareSource) =>
    set((state) => ({ compareSource, compareId: compareSource ? state.compareId + 1 : state.compareId })),
  setWorkspacesOpen: (workspacesOpen) => set({ workspacesOpen }),
  setHostEditor: (hostEditor) => set({ hostEditor }),
  setHostOrganizer: (hostOrganizer) => set({ hostOrganizer }),
  setHostBulkEditor: (hostBulkEditor) => set({ hostBulkEditor }),
  setFolderDialog: (folderDialog) => set({ folderDialog }),
  setSharedSessionsDialog: (sharedSessionsDialog) => set({ sharedSessionsDialog }),
  // Closing either view from its own control brings the hosts back rather
  // than shutting the panel, the way putting the file browser away does.
  setForwardingOpen: (open) =>
    set((state) => {
      if (open) return showSidebarView(state, 'forwarding');
      return state.sidebarView === 'forwarding'
        ? sidebarViewPatch(state, 'hosts', state.sidebarPanelOpen)
        : state;
    }),
  setEnvironmentsPanel: (scope) =>
    set((state) => {
      if (scope) return showSidebarView(state, 'environments', scope);
      return state.sidebarView === 'environments'
        ? sidebarViewPatch(state, 'hosts', state.sidebarPanelOpen)
        : state;
    }),
  setSidebarView: (view) => set((state) => showSidebarView(state, view)),
  toggleSidebarView: (view) =>
    set((state) =>
      state.sidebarPanelOpen && state.sidebarView === view
        ? sidebarViewPatch(state, view, false)
        : showSidebarView(state, view),
    ),
  setSidebarPanelOpen: (open) =>
    set((state) =>
      open ? showSidebarView(state, state.sidebarView) : sidebarViewPatch(state, state.sidebarView, false),
    ),
  setSidebarScopePath: (sidebarScopePath) => set({ sidebarScopePath }),
  setLogViewerOpen: (logViewerOpen) => set({ logViewerOpen }),
}));
