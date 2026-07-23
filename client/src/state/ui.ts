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

interface UiState {
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  hostEditor: HostEditorState;
  /** Host whose Muxus-only display metadata is being organized. */
  hostOrganizer: SshHostEntry | false;
  /** Global forwarding side panel (saved tunnels + live forwards). */
  forwardingOpen: boolean;
  /** Tab ids awaiting a close confirmation (live sessions). */
  confirmCloseTabs: string[] | null;
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setHostEditor: (value: HostEditorState) => void;
  setHostOrganizer: (value: SshHostEntry | false) => void;
  setForwardingOpen: (open: boolean) => void;
  setConfirmCloseTabs: (tabIds: string[] | null) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  shortcutsOpen: false,
  hostEditor: false,
  hostOrganizer: false,
  forwardingOpen: false,
  confirmCloseTabs: null,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setHostEditor: (hostEditor) => set({ hostEditor }),
  setHostOrganizer: (hostOrganizer) => set({ hostOrganizer }),
  setForwardingOpen: (forwardingOpen) => set({ forwardingOpen }),
  setConfirmCloseTabs: (confirmCloseTabs) => set({ confirmCloseTabs }),
}));
