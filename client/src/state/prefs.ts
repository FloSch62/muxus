import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_SIDEBAR_WIDTH } from '../sidebar-width.js';
import { DEFAULT_SFTP_PANEL_WIDTH } from '../sftp-panel-width.js';
import { muxusStateStorage } from './persist-storage.js';
import { isKeywordHighlightProfileArray } from '../highlight-profiles.js';
import type { KeywordHighlightProfile, KeywordHighlightRule } from '@muxus/shared';

export type ThemeMode = 'light' | 'dark' | 'os';
export type EffectiveThemeMode = Exclude<ThemeMode, 'os'>;
export type RightClickAction = 'copy-paste' | 'paste' | 'menu';
export type TerminalFileLinkActivation = 'direct' | 'alt' | 'ctrl' | 'meta';
export type TabNumberVisibility = 'shortcut' | 'always';

export const DEFAULT_INACTIVE_PANE_DIM_STRENGTH = 0.15;
export const MIN_INACTIVE_PANE_DIM_STRENGTH = 0.1;
export const MAX_INACTIVE_PANE_DIM_STRENGTH = 0.6;

/** Keep hand-edited or older persisted values from making a pane illegible. */
export function clampInactivePaneDimStrength(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INACTIVE_PANE_DIM_STRENGTH;
  return Math.min(
    MAX_INACTIVE_PANE_DIM_STRENGTH,
    Math.max(MIN_INACTIVE_PANE_DIM_STRENGTH, value),
  );
}

/** Presentation-only opacity for one pane; terminal buffers remain untouched. */
export function paneFocusOpacity(
  emphasized: boolean,
  dimInactivePanes: boolean,
  dimStrength: number,
): number {
  return emphasized || !dimInactivePanes ? 1 : 1 - clampInactivePaneDimStrength(dimStrength);
}

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

/** A reusable local terminal launch configuration. Arguments stay structured
 * so paths and values containing spaces are never reparsed as a command line. */
export interface LocalShellProfileConfig {
  id: string;
  name: string;
  shell: string;
  args: string[];
  cwd: string;
  startupCommand: string;
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
  /** Terminal color scheme id used while the effective application theme is light. */
  lightTerminalScheme: string;
  /** Terminal color scheme id used while the effective application theme is dark. */
  darkTerminalScheme: string;
  /** Terminal text color; empty follows the color scheme's foreground. */
  fontColor: string;
  /** Terminal background color; empty follows the color scheme's background. */
  backgroundColor: string;
  /** Scrollback lines kept per terminal. */
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  /** Render terminals on the GPU via WebGL; off keeps the DOM renderer. */
  webglRenderer: boolean;
  /** Local terminal shell; 'auto' lets the server pick the login shell. */
  localShell: string;
  /** Named alternatives offered wherever a local terminal can be launched. */
  localShellProfiles: LocalShellProfileConfig[];
  /** Empty selects the legacy automatic/custom localShell preference. */
  defaultLocalShellProfileId: string;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
  /** Let terminal applications replace the system clipboard via OSC 52. */
  allowOsc52ClipboardWrite: boolean;
  /** Right-click: copy selection / paste (terminal convention), always paste, or context menu. */
  rightClickAction: RightClickAction;
  /** Mouse gesture that opens a detected terminal file path or web URL. */
  terminalFileLinkActivation: TerminalFileLinkActivation;
  /** Preview multiline pastes before they can run several shell commands. */
  pasteWarnMultiline: boolean;
  /** Ask before closing a tab with a live session. */
  confirmCloseConnected: boolean;
  /** Dial remote sessions on workspace restore and retry dropped connections. */
  autoReconnectRemote: boolean;
  /** Show a notification at startup when a newer release is available. */
  notifyOnNewVersion: boolean;
  /** Persist recent terminal output and replay it on restore and reconnect. */
  restoreScrollback: boolean;
  /** Scale of the whole interface, 1 = 100%. */
  interfaceZoom: number;
  /** Splitting a pane opens a second session on the same host. */
  splitInheritsSession: boolean;
  /** When window-wide shortcut numbers are shown on terminal tabs. */
  tabNumberVisibility: TabNumberVisibility;
  /** Draw a theme-accented border around focused and multi-exec panes in a split layout. */
  activePaneBorder: boolean;
  /** Reduce the presentation opacity of panes that do not receive keyboard input. */
  dimInactivePanes: boolean;
  /** Fraction removed from inactive-pane opacity while dimming is enabled. */
  inactivePaneDimStrength: number;
  /**
   * Chords per command id, replacing that command's defaults. An empty array
   * unbinds the command; commands absent from the map keep their defaults.
   */
  keybindings: Record<string, string[]>;
  /** One-click commands shown in the action bar. */
  commandButtons: CommandButton[];
  /** Show saved commands as buttons above the terminal in addition to the keyboard menu. */
  showCommandBar: boolean;
  /** Rules applied to every terminal; hosts may add to or replace these. */
  keywordHighlights: KeywordHighlightRule[];
  /** Named rule sets referenced by saved-host highlighting metadata. */
  keywordHighlightProfiles: KeywordHighlightProfile[];
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
  /** Verbose diagnostic logging plus access to the log viewer and export. */
  debugMode: boolean;
  set: (patch: Partial<Omit<PrefsState, 'set'>>) => void;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'os' || value === 'dark';
}

function isTabNumberVisibility(value: unknown): value is TabNumberVisibility {
  return value === 'shortcut' || value === 'always';
}

export function isTerminalFileLinkActivation(
  value: unknown,
): value is TerminalFileLinkActivation {
  return value === 'direct' || value === 'alt' || value === 'ctrl' || value === 'meta';
}

export function terminalSchemeIdForMode(
  prefs: Pick<PrefsState, 'lightTerminalScheme' | 'darkTerminalScheme'>,
  mode: EffectiveThemeMode,
): string {
  return mode === 'light' ? prefs.lightTerminalScheme : prefs.darkTerminalScheme;
}

/** Upgrade persisted preferences without mutating the storage snapshot. */
export function migratePrefsState(persisted: unknown, version: number): unknown {
  if (persisted === null || typeof persisted !== 'object') return persisted;
  const state = { ...persisted } as Partial<PrefsState> & {
    terminalScheme?: unknown;
    termName?: unknown;
  };
  // A missing or invalid value falls through to the store's System default.
  if (!isThemeMode(state.themeMode)) delete state.themeMode;
  if (!isTabNumberVisibility(state.tabNumberVisibility)) delete state.tabNumberVisibility;
  if (!isTerminalFileLinkActivation(state.terminalFileLinkActivation)) {
    delete state.terminalFileLinkActivation;
  }
  if (typeof state.activePaneBorder !== 'boolean') delete state.activePaneBorder;
  if (typeof state.dimInactivePanes !== 'boolean') delete state.dimInactivePanes;
  if (
    typeof state.inactivePaneDimStrength !== 'number' ||
    !Number.isFinite(state.inactivePaneDimStrength) ||
    state.inactivePaneDimStrength < MIN_INACTIVE_PANE_DIM_STRENGTH ||
    state.inactivePaneDimStrength > MAX_INACTIVE_PANE_DIM_STRENGTH
  ) {
    delete state.inactivePaneDimStrength;
  }
  // v0 shipped the Muxus scheme as the default; stored copies of that
  // default follow the new one.
  let legacyTerminalScheme = state.terminalScheme;
  if (version === 0 && legacyTerminalScheme === 'muxus') {
    legacyTerminalScheme = 'vscode-dark';
  }
  // v9 split the single scheme preference by effective appearance. Copying
  // the old value to both modes preserves the terminal users saw before the
  // upgrade; they can then choose a different scheme for either mode.
  if (version < 9 && typeof legacyTerminalScheme === 'string') {
    if (typeof state.lightTerminalScheme !== 'string') {
      state.lightTerminalScheme = legacyTerminalScheme;
    }
    if (typeof state.darkTerminalScheme !== 'string') {
      state.darkTerminalScheme = legacyTerminalScheme;
    }
  }
  delete state.terminalScheme;
  // TERM is fixed by the server now; remove the retired client override.
  delete state.termName;
  // Folder presentation arrived in v5. A restored or hand-edited snapshot can
  // carry the wrong shape here, and every reader assumes the right one.
  if (!isStringArray(state.sidebarCollapsedFolders)) delete state.sidebarCollapsedFolders;
  if (!isStringArray(state.sidebarEmptyFolders)) delete state.sidebarEmptyFolders;
  if (!isFolderStyleMap(state.sidebarFolderStyles)) delete state.sidebarFolderStyles;
  if (!isFolderOrderMap(state.sidebarFolderOrder)) delete state.sidebarFolderOrder;
  const localShellProfiles = isLocalShellProfileArray(state.localShellProfiles)
    ? state.localShellProfiles
    : undefined;
  if (!localShellProfiles) delete state.localShellProfiles;
  if (typeof state.defaultLocalShellProfileId !== 'string') {
    delete state.defaultLocalShellProfileId;
  } else if (
    state.defaultLocalShellProfileId &&
    !localShellProfiles?.some((profile) => profile.id === state.defaultLocalShellProfileId)
  ) {
    state.defaultLocalShellProfileId = '';
  }
  if (!isKeywordHighlightProfileArray(state.keywordHighlightProfiles)) {
    delete state.keywordHighlightProfiles;
  }
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

export function isLocalShellProfileArray(value: unknown): value is LocalShellProfileConfig[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const profile = entry as Record<string, unknown>;
    if (
      typeof profile.id !== 'string' ||
      !profile.id ||
      profile.id.length > 200 ||
      ids.has(profile.id) ||
      typeof profile.name !== 'string' ||
      !profile.name.trim() ||
      profile.name.length > 200 ||
      typeof profile.shell !== 'string' ||
      profile.shell.length > 4096 ||
      typeof profile.cwd !== 'string' ||
      profile.cwd.length > 4096 ||
      typeof profile.startupCommand !== 'string' ||
      profile.startupCommand.length > 32_768 ||
      !Array.isArray(profile.args) ||
      profile.args.length > 64 ||
      !profile.args.every((arg) => typeof arg === 'string' && arg.length <= 4096)
    ) {
      return false;
    }
    ids.add(profile.id);
    return true;
  });
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      themeMode: 'os',
      monoFontSize: 14,
      fontFamily: 'JetBrains Mono',
      lineHeight: 1.0,
      lightTerminalScheme: 'vscode-light',
      darkTerminalScheme: 'vscode-dark',
      fontColor: '',
      backgroundColor: '',
      scrollback: 10_000,
      cursorBlink: true,
      cursorStyle: 'block',
      webglRenderer: true,
      localShell: 'auto',
      localShellProfiles: [],
      defaultLocalShellProfileId: '',
      copyOnSelect: false,
      allowOsc52ClipboardWrite: true,
      rightClickAction: 'copy-paste',
      terminalFileLinkActivation: 'alt',
      pasteWarnMultiline: true,
      confirmCloseConnected: true,
      autoReconnectRemote: true,
      notifyOnNewVersion: true,
      restoreScrollback: true,
      interfaceZoom: 1,
      splitInheritsSession: true,
      tabNumberVisibility: 'shortcut',
      activePaneBorder: false,
      dimInactivePanes: false,
      inactivePaneDimStrength: DEFAULT_INACTIVE_PANE_DIM_STRENGTH,
      keybindings: {},
      commandButtons: [],
      showCommandBar: true,
      keywordHighlights: [],
      keywordHighlightProfiles: [],
      sidebarCollapsed: false,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarCollapsedFolders: [],
      sidebarFolderStyles: {},
      sidebarFolderOrder: {},
      sidebarEmptyFolders: [],
      sftpPanelWidth: DEFAULT_SFTP_PANEL_WIDTH,
      debugMode: false,
      set: (patch) => set(patch),
    }),
    {
      name: 'muxus-prefs',
      version: 13,
      migrate: migratePrefsState,
      storage: createJSONStorage(() => muxusStateStorage),
    },
  ),
);
