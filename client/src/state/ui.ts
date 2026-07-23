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
  hostEditor: HostEditorState;
  /** Forwards dialog targets the active tab's connection. */
  forwardsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setHostEditor: (value: HostEditorState) => void;
  setForwardsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  hostEditor: false,
  forwardsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHostEditor: (hostEditor) => set({ hostEditor }),
  setForwardsOpen: (forwardsOpen) => set({ forwardsOpen }),
}));
