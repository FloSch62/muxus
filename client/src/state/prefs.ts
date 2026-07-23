import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { muxusStateStorage } from './persist-storage.js';

export type ThemeMode = 'light' | 'dark' | 'os';
export type RightClickAction = 'copy-paste' | 'paste' | 'menu';

/** Fallback stack appended after the user's chosen family. */
export const MONO_FONT_FALLBACK = '"JetBrains Mono", "Fira Code", monospace';

/** CSS font-family stack for the terminal given the fontFamily pref. */
export function terminalFontStack(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return MONO_FONT_FALLBACK;
  const quoted = /[ ]/.test(trimmed) && !/^["']/.test(trimmed) ? `"${trimmed}"` : trimmed;
  return quoted === '"JetBrains Mono"' || quoted === 'monospace' ? MONO_FONT_FALLBACK : `${quoted}, ${MONO_FONT_FALLBACK}`;
}

interface PrefsState {
  themeMode: ThemeMode;
  /** Base font size for the terminal. */
  monoFontSize: number;
  /** Terminal font family; JetBrains Mono ships with Muxus, others must be installed. */
  fontFamily: string;
  /** Terminal line height multiplier (1.0 = font metrics). */
  lineHeight: number;
  /** Terminal color scheme id (see terminal/palette.ts). */
  terminalScheme: string;
  /** Scrollback lines kept per terminal. */
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  /** TERM advertised to sessions. The compatibility default works on hosts
   *  without kitty's terminfo; users can opt into xterm-kitty. */
  termName: string;
  /** Local terminal shell; 'auto' lets the server pick the login shell. */
  localShell: string;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
  /** Right-click: copy selection / paste (terminal convention), always paste, or context menu. */
  rightClickAction: RightClickAction;
  /** Preview multiline pastes before they can run several shell commands. */
  pasteWarnMultiline: boolean;
  /** Ask before closing a tab with a live session. */
  confirmCloseConnected: boolean;
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  set: (patch: Partial<Omit<PrefsState, 'set' | 'toggleTheme'>>) => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      themeMode: 'os',
      monoFontSize: 14,
      fontFamily: 'JetBrains Mono',
      lineHeight: 1.0,
      terminalScheme: 'muxus',
      scrollback: 10_000,
      cursorBlink: true,
      cursorStyle: 'block',
      termName: 'xterm-256color',
      localShell: 'auto',
      copyOnSelect: false,
      rightClickAction: 'copy-paste',
      pasteWarnMultiline: true,
      confirmCloseConnected: true,
      sidebarCollapsed: false,
      toggleTheme: () =>
        set((s) => ({ themeMode: s.themeMode === 'light' ? 'dark' : s.themeMode === 'dark' ? 'os' : 'light' })),
      set: (patch) => set(patch),
    }),
    { name: 'muxus-prefs', version: 0, storage: createJSONStorage(() => muxusStateStorage) },
  ),
);
