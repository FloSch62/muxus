import { create } from 'zustand';
import type { SshHostEntry } from '@muxus/shared';

/**
 * Host editor dialog state: closed, creating (optionally duplicating an
 * existing entry), or editing an entry's Host block in ~/.ssh/config.
 */
export type HostEditorState =
  | false
  | { mode: 'new'; prefillTarget?: string }
  | { mode: 'duplicate'; entry: SshHostEntry }
  | { mode: 'edit'; entry: SshHostEntry };

export interface ConfirmCloseRequest {
  tabIds: string[];
  /** When set, the tabs belong to a pane that should collapse after confirmation. */
  paneId?: string;
}

interface UiState {
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  hostEditor: HostEditorState;
  /** Host whose Muxus-only display metadata is being organized. */
  hostOrganizer: SshHostEntry | false;
  /** Global forwarding side panel (saved tunnels + live forwards). */
  forwardingOpen: boolean;
  /** Tabs, and optionally their pane, awaiting a live-session close confirmation. */
  confirmClose: ConfirmCloseRequest | null;
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setHostEditor: (value: HostEditorState) => void;
  setHostOrganizer: (value: SshHostEntry | false) => void;
  setForwardingOpen: (open: boolean) => void;
  setConfirmClose: (request: ConfirmCloseRequest | null) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  shortcutsOpen: false,
  hostEditor: false,
  hostOrganizer: false,
  forwardingOpen: false,
  confirmClose: null,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setHostEditor: (hostEditor) => set({ hostEditor }),
  setHostOrganizer: (hostOrganizer) => set({ hostOrganizer }),
  setForwardingOpen: (forwardingOpen) => set({ forwardingOpen }),
  setConfirmClose: (confirmClose) => set({ confirmClose }),
}));
