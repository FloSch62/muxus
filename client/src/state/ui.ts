import { create } from 'zustand';
import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';

/** Unified editor state for OpenSSH entries and Muxus-owned Telnet/serial hosts. */
export type HostEditorState =
  | false
  | { mode: 'new'; prefillTarget?: string; kind?: 'ssh' | 'telnet' | 'serial' }
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
  /** Pick the folder one host should live in. */
  | { mode: 'move-host'; hostKey: string; hostName: string; currentPath: string };

interface UiState {
  settingsOpen: boolean;
  commandButtonMenuOpen: boolean;
  commandButtonsOpen: boolean;
  shortcutsOpen: boolean;
  quickLauncherOpen: boolean;
  historyOpen: boolean;
  historyQuery: string;
  historySelectedId?: string;
  workspacesOpen: boolean;
  hostEditor: HostEditorState;
  /** Host whose Muxus-only display metadata is being organized. */
  hostOrganizer: SshHostEntry | SavedHostProfile | false;
  /** Sidebar folder being created, renamed, styled, or picked as a target. */
  folderDialog: FolderDialogState;
  /** Global forwarding side panel (saved tunnels + live forwards). */
  forwardingOpen: boolean;
  /** Diagnostic log viewer (settings → debug). */
  logViewerOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setCommandButtonMenuOpen: (open: boolean) => void;
  setCommandButtonsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setQuickLauncherOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  openHistory: (query?: string, selectedId?: string) => void;
  setWorkspacesOpen: (open: boolean) => void;
  setHostEditor: (value: HostEditorState) => void;
  setHostOrganizer: (value: SshHostEntry | SavedHostProfile | false) => void;
  setFolderDialog: (value: FolderDialogState) => void;
  setForwardingOpen: (open: boolean) => void;
  setLogViewerOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  commandButtonMenuOpen: false,
  commandButtonsOpen: false,
  shortcutsOpen: false,
  quickLauncherOpen: false,
  historyOpen: false,
  historyQuery: '',
  workspacesOpen: false,
  hostEditor: false,
  hostOrganizer: false,
  folderDialog: false,
  forwardingOpen: false,
  logViewerOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCommandButtonMenuOpen: (commandButtonMenuOpen) => set({ commandButtonMenuOpen }),
  setCommandButtonsOpen: (commandButtonsOpen) => set({ commandButtonsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setQuickLauncherOpen: (quickLauncherOpen) => set({ quickLauncherOpen }),
  setHistoryOpen: (historyOpen) =>
    set({
      historyOpen,
      ...(historyOpen ? { historyQuery: '', historySelectedId: undefined } : {}),
    }),
  openHistory: (historyQuery = '', historySelectedId) =>
    set({ historyOpen: true, historyQuery, historySelectedId }),
  setWorkspacesOpen: (workspacesOpen) => set({ workspacesOpen }),
  setHostEditor: (hostEditor) => set({ hostEditor }),
  setHostOrganizer: (hostOrganizer) => set({ hostOrganizer }),
  setFolderDialog: (folderDialog) => set({ folderDialog }),
  setForwardingOpen: (forwardingOpen) => set({ forwardingOpen }),
  setLogViewerOpen: (logViewerOpen) => set({ logViewerOpen }),
}));
