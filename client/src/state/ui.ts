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

interface UiState {
  settingsOpen: boolean;
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
  /** Global forwarding side panel (saved tunnels + live forwards). */
  forwardingOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setCommandButtonsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setQuickLauncherOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  openHistory: (query?: string, selectedId?: string) => void;
  setWorkspacesOpen: (open: boolean) => void;
  setHostEditor: (value: HostEditorState) => void;
  setHostOrganizer: (value: SshHostEntry | SavedHostProfile | false) => void;
  setForwardingOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  commandButtonsOpen: false,
  shortcutsOpen: false,
  quickLauncherOpen: false,
  historyOpen: false,
  historyQuery: '',
  workspacesOpen: false,
  hostEditor: false,
  hostOrganizer: false,
  forwardingOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
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
  setForwardingOpen: (forwardingOpen) => set({ forwardingOpen }),
}));
