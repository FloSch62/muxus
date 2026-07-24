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

export interface ConfirmCloseRequest {
  tabIds: string[];
  /** When set, the tabs belong to a pane that should collapse after confirmation. */
  paneId?: string;
}

interface UiState {
  settingsOpen: boolean;
  commandButtonsOpen: boolean;
  shortcutsOpen: boolean;
  historyOpen: boolean;
  workspacesOpen: boolean;
  hostEditor: HostEditorState;
  /** Host whose Muxus-only display metadata is being organized. */
  hostOrganizer: SshHostEntry | SavedHostProfile | false;
  /** Global forwarding side panel (saved tunnels + live forwards). */
  forwardingOpen: boolean;
  /** Tabs, and optionally their pane, awaiting a live-session close confirmation. */
  confirmClose: ConfirmCloseRequest | null;
  setSettingsOpen: (open: boolean) => void;
  setCommandButtonsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  setWorkspacesOpen: (open: boolean) => void;
  setHostEditor: (value: HostEditorState) => void;
  setHostOrganizer: (value: SshHostEntry | SavedHostProfile | false) => void;
  setForwardingOpen: (open: boolean) => void;
  setConfirmClose: (request: ConfirmCloseRequest | null) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  commandButtonsOpen: false,
  shortcutsOpen: false,
  historyOpen: false,
  workspacesOpen: false,
  hostEditor: false,
  hostOrganizer: false,
  forwardingOpen: false,
  confirmClose: null,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCommandButtonsOpen: (commandButtonsOpen) => set({ commandButtonsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  setWorkspacesOpen: (workspacesOpen) => set({ workspacesOpen }),
  setHostEditor: (hostEditor) => set({ hostEditor }),
  setHostOrganizer: (hostOrganizer) => set({ hostOrganizer }),
  setForwardingOpen: (forwardingOpen) => set({ forwardingOpen }),
  setConfirmClose: (confirmClose) => set({ confirmClose }),
}));
