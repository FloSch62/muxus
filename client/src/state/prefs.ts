import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_SIDEBAR_WIDTH } from '../sidebar-width.js';
import { DEFAULT_SFTP_PANEL_WIDTH } from '../sftp-panel-width.js';
import { muxusStateStorage } from './persist-storage.js';

export type ThemeMode = 'light' | 'dark' | 'os';
export type RightClickAction = 'copy-paste' | 'paste' | 'menu';

/** Bundled icon-only fallback covering Nerd Font and Powerline glyphs. */
export const TERMINAL_SYMBOL_FONT = '"Pure Nerd Font"';

/** Fallback stack appended after the user's chosen family. */
export const MONO_FONT_FALLBACK = `"JetBrains Mono", ${TERMINAL_SYMBOL_FONT}, "Noto Sans Mono", "DejaVu Sans Mono", "Liberation Mono", monospace`;

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
  /** Terminal font family; bundled text and symbol fonts remain as fallbacks. */
  fontFamily: string;
  /** Terminal line height multiplier (1.0 = font metrics). */
  lineHeight: number;
  /** Terminal color scheme id (see terminal/palette.ts). */
  terminalScheme: string;
  /** Scrollback lines kept per terminal. */
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
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
  /** Width of the sessions and hosts sidebar. */
  sidebarWidth: number;
  /** Width of the per-session remote file browser. */
  sftpPanelWidth: number;
  toggleTheme: () => void;
  set: (patch: Partial<Omit<PrefsState, 'set' | 'toggleTheme'>>) => void;
}

/** Upgrade persisted preferences without mutating the storage snapshot. */
export function migratePrefsState(persisted: unknown, version: number): unknown {
  if (persisted === null || typeof persisted !== 'object') return persisted;
  const state = { ...persisted } as Partial<PrefsState> & { termName?: unknown };
  // v0 shipped the Muxus scheme as the default; stored copies of that
  // default follow the new one.
  if (version === 0 && state.terminalScheme === 'muxus') state.terminalScheme = 'vscode-dark';
  // TERM is fixed by the server now; remove the retired client override.
  delete state.termName;
  return state;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      themeMode: 'os',
      monoFontSize: 14,
      fontFamily: 'JetBrains Mono',
      lineHeight: 1.0,
      terminalScheme: 'vscode-dark',
      scrollback: 10_000,
      cursorBlink: true,
      cursorStyle: 'block',
      localShell: 'auto',
      copyOnSelect: false,
      rightClickAction: 'copy-paste',
      pasteWarnMultiline: true,
      confirmCloseConnected: true,
      sidebarCollapsed: false,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sftpPanelWidth: DEFAULT_SFTP_PANEL_WIDTH,
      toggleTheme: () =>
        set((s) => ({ themeMode: s.themeMode === 'light' ? 'dark' : s.themeMode === 'dark' ? 'os' : 'light' })),
      set: (patch) => set(patch),
    }),
    {
      name: 'muxus-prefs',
      version: 3,
      migrate: migratePrefsState,
      storage: createJSONStorage(() => muxusStateStorage),
    },
  ),
);
