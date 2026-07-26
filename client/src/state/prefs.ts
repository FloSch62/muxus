import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_SIDEBAR_WIDTH } from '../sidebar-width.js';
import { DEFAULT_SFTP_PANEL_WIDTH } from '../sftp-panel-width.js';
import { muxusStateStorage } from './persist-storage.js';
import type { KeywordHighlightRule } from '@muxus/shared';

export type ThemeMode = 'light' | 'dark' | 'os';
export type RightClickAction = 'copy-paste' | 'paste' | 'menu';

/** Presentation of one sidebar folder. Folders are paths, not records, so
 *  their looks cannot hang off a host and live here instead. */
export interface FolderStyle {
  color?: string;
  icon?: string;
}

export interface CommandButton {
  id: string;
  label: string;
  command: string;
  /** Append an Enter keystroke after sending the saved command. */
  sendEnter: boolean;
}

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

export interface PrefsState {
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
  /** Dial remote sessions on workspace restore and retry dropped connections. */
  autoReconnectRemote: boolean;
  /** Persist recent terminal output and replay it on restore and reconnect. */
  restoreScrollback: boolean;
  /** Scale of the whole interface, 1 = 100%. */
  interfaceZoom: number;
  /** Splitting a pane opens a second session on the same host. */
  splitInheritsSession: boolean;
  /**
   * Chords per command id, replacing that command's defaults. An empty array
   * unbinds the command; commands absent from the map keep their defaults.
   */
  keybindings: Record<string, string[]>;
  /** One-click commands shown in the action bar. */
  commandButtons: CommandButton[];
  /** Rules applied to every terminal; hosts may add to or replace these. */
  keywordHighlights: KeywordHighlightRule[];
  /** Whether the whole hosts sidebar is hidden — not to be confused with
   *  sidebarCollapsedFolders, which collapses individual folders inside it. */
  sidebarCollapsed: boolean;
  /** Width of the sessions and hosts sidebar. */
  sidebarWidth: number;
  /** Folder keys the user collapsed. Absent means expanded, so a new folder
   *  shows its contents the first time it appears. */
  sidebarCollapsedFolders: string[];
  /** Colour and icon per folder key. */
  sidebarFolderStyles: Record<string, FolderStyle>;
  /** Manual sibling order per parent folder key: parent → ordered child keys.
   *  Folders missing from a list fall back to alphabetical, after the ranked
   *  ones — the same rule hosts already follow with sortOrder. */
  sidebarFolderOrder: Record<string, string[]>;
  /** Folders the user created that hold no host yet; canonical paths, since an
   *  empty folder has no host to carry its label. */
  sidebarEmptyFolders: string[];
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
  // Folder presentation arrived in v5. A restored or hand-edited snapshot can
  // carry the wrong shape here, and every reader assumes the right one.
  if (!isStringArray(state.sidebarCollapsedFolders)) delete state.sidebarCollapsedFolders;
  if (!isStringArray(state.sidebarEmptyFolders)) delete state.sidebarEmptyFolders;
  if (!isFolderStyleMap(state.sidebarFolderStyles)) delete state.sidebarFolderStyles;
  if (!isFolderOrderMap(state.sidebarFolderOrder)) delete state.sidebarFolderOrder;
  // The sidebar grew in v6 to fit its search box. A stored copy of the old
  // default was never a choice, so it follows; a dragged width is left alone.
  if (version < 6 && state.sidebarWidth === PREVIOUS_DEFAULT_SIDEBAR_WIDTH) {
    state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  }
  return state;
}

/** What `DEFAULT_SIDEBAR_WIDTH` was before v6, for the migration above. */
const PREVIOUS_DEFAULT_SIDEBAR_WIDTH = 248;

function isFolderOrderMap(value: unknown): value is Record<string, string[]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isStringArray);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFolderStyleMap(value: unknown): value is Record<string, FolderStyle> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (style) =>
      style !== null &&
      typeof style === 'object' &&
      !Array.isArray(style) &&
      Object.entries(style).every(
        ([key, entry]) =>
          (key === 'color' || key === 'icon') &&
          (entry === undefined || typeof entry === 'string'),
      ),
  );
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
      autoReconnectRemote: true,
      restoreScrollback: true,
      interfaceZoom: 1,
      splitInheritsSession: true,
      keybindings: {},
      commandButtons: [],
      keywordHighlights: [],
      sidebarCollapsed: false,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarCollapsedFolders: [],
      sidebarFolderStyles: {},
      sidebarFolderOrder: {},
      sidebarEmptyFolders: [],
      sftpPanelWidth: DEFAULT_SFTP_PANEL_WIDTH,
      toggleTheme: () =>
        set((s) => ({ themeMode: s.themeMode === 'light' ? 'dark' : s.themeMode === 'dark' ? 'os' : 'light' })),
      set: (patch) => set(patch),
    }),
    {
      name: 'muxus-prefs',
      version: 6,
      migrate: migratePrefsState,
      storage: createJSONStorage(() => muxusStateStorage),
    },
  ),
);
