import { create } from 'zustand';
import type { SavedSession } from './sessions.js';

interface UiState {
  settingsOpen: boolean;
  /** Session dialog: false closed, 'new' create, else the session being edited. */
  sessionDialog: false | 'new' | SavedSession;
  /** Forwards dialog targets the active tab's connection. */
  forwardsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setSessionDialog: (value: false | 'new' | SavedSession) => void;
  setForwardsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  sessionDialog: false,
  forwardsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSessionDialog: (sessionDialog) => set({ sessionDialog }),
  setForwardsOpen: (forwardsOpen) => set({ forwardsOpen }),
}));
