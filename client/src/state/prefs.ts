import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { muxusStateStorage } from './persist-storage.js';

export type ThemeMode = 'light' | 'dark' | 'os';

interface PrefsState {
  themeMode: ThemeMode;
  /** Base font size for the terminal. */
  monoFontSize: number;
  /** Scrollback lines kept per terminal. */
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  /** TERM advertised to sessions. xterm-kitty is honest: Muxus speaks the
   *  kitty graphics and keyboard protocols. */
  termName: string;
  /** Local terminal shell; 'auto' lets the server pick the login shell. */
  localShell: string;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  set: (patch: Partial<Omit<PrefsState, 'set' | 'toggleTheme'>>) => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      themeMode: 'os',
      monoFontSize: 13,
      scrollback: 10_000,
      cursorBlink: true,
      cursorStyle: 'block',
      termName: 'xterm-kitty',
      localShell: 'auto',
      copyOnSelect: false,
      sidebarCollapsed: false,
      toggleTheme: () =>
        set((s) => ({ themeMode: s.themeMode === 'light' ? 'dark' : s.themeMode === 'dark' ? 'os' : 'light' })),
      set: (patch) => set(patch),
    }),
    { name: 'muxus-prefs', version: 0, storage: createJSONStorage(() => muxusStateStorage) },
  ),
);
