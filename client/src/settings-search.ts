import type { SettingsSection } from './state/ui.js';

/**
 * One searchable setting: a row in a Settings section, or a group whose
 * content is a list or a form rather than rows. The labels match what the
 * section shows, so choosing a result can scroll to it and outline it;
 * tests/unit/client/settings-search.test.ts checks that every row and group
 * title in the settings sources is listed here.
 */
export interface SettingsSearchEntry {
  section: SettingsSection;
  /** The row's label, or the group's title (without its "· count" suffix). */
  label: string;
  /** The group the row sits in, shown beside the result. */
  group?: string;
  /** The result is the group itself. */
  kind?: 'group';
  /** The row's own label where the result needs more context than it gives, e.g. "Items". */
  row?: string;
  /** Other words people look for it by. */
  keywords?: readonly string[];
  /** Settings that only exist in the desktop app or on Windows. */
  only?: 'desktop' | 'windows';
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  // Appearance
  { section: 'appearance', group: 'Window', label: 'Theme', keywords: ['dark mode', 'light mode', 'system', 'appearance'] },
  { section: 'appearance', group: 'Window', label: 'Interface scale', keywords: ['zoom', 'ui size', 'scaling', 'bigger', 'smaller'] },
  { section: 'appearance', group: 'Layout', label: 'Hosts sidebar', keywords: ['left', 'right', 'position', 'dock'] },
  { section: 'appearance', group: 'Layout', label: 'File browser', keywords: ['sftp', 'position', 'dock', 'sidebar'] },
  { section: 'appearance', group: 'Layout', label: 'Command bar', keywords: ['command buttons', 'top', 'bottom', 'position'] },
  { section: 'appearance', group: 'Status bar', label: 'Show status bar', keywords: ['cpu', 'memory', 'disk', 'uptime', 'statistics'] },
  { section: 'appearance', group: 'Status bar', label: 'Status bar items', row: 'Items', keywords: ['cpu', 'memory', 'disk', 'load', 'network', 'uptime', 'users'] },
  { section: 'appearance', group: 'Terminal colors', label: 'Light terminal theme', keywords: ['color scheme', 'palette', 'colours'] },
  { section: 'appearance', group: 'Terminal colors', label: 'Dark terminal theme', keywords: ['color scheme', 'palette', 'colours'] },
  { section: 'appearance', group: 'Terminal colors', label: 'Text color', keywords: ['foreground', 'font color', 'colour'] },
  { section: 'appearance', group: 'Terminal colors', label: 'Background color', keywords: ['colour'] },
  { section: 'appearance', kind: 'group', label: 'Custom color schemes', keywords: ['import', 'iterm2', 'itermcolors', 'windows terminal', 'palette', 'colours'] },
  { section: 'appearance', group: 'Terminal font', label: 'Font family', keywords: ['typeface', 'monospace', 'jetbrains mono'] },
  { section: 'appearance', group: 'Terminal font', label: 'Font size', keywords: ['text size', 'zoom', 'bigger', 'smaller'] },
  { section: 'appearance', group: 'Terminal font', label: 'Line height', keywords: ['spacing', 'line spacing'] },
  { section: 'appearance', group: 'Split panes', label: 'Dim inactive panes', keywords: ['fade', 'focus', 'unfocused'] },
  { section: 'appearance', group: 'Split panes', label: 'Dimming strength', keywords: ['fade', 'opacity'] },
  { section: 'appearance', group: 'Split panes', label: 'Outline the focused pane', keywords: ['border', 'highlight', 'active pane'] },

  // Terminal
  { section: 'terminal', group: 'Cursor', label: 'Cursor style', keywords: ['block', 'underline', 'bar', 'caret'] },
  { section: 'terminal', group: 'Cursor', label: 'Blinking cursor', keywords: ['blink', 'caret'] },
  { section: 'terminal', group: 'Clipboard & mouse', label: 'Right-click', keywords: ['paste', 'context menu', 'mouse'] },
  { section: 'terminal', group: 'Clipboard & mouse', label: 'Open terminal links', keywords: ['url', 'hyperlink', 'click', 'file paths'] },
  { section: 'terminal', group: 'Clipboard & mouse', label: 'Copy on select', keywords: ['selection', 'clipboard', 'putty'] },
  { section: 'terminal', group: 'Clipboard & mouse', label: 'Allow terminal clipboard writes (OSC 52)', keywords: ['tmux', 'zellij', 'clipboard'] },
  { section: 'terminal', group: 'Clipboard & mouse', label: 'Confirm multiline pastes', keywords: ['paste warning', 'paste preview'] },
  { section: 'terminal', group: 'Clipboard & mouse', label: 'Confirm pastes with look-alike characters', keywords: ['smart quotes', 'no-break space', 'unicode', 'paste warning'] },
  { section: 'terminal', group: 'Paste pacing', label: 'Delay after each line', keywords: ['paste delay', 'slow paste', 'console', 'network device'] },
  { section: 'terminal', group: 'Paste pacing', label: 'Delay after each character', keywords: ['paste delay', 'slow paste', 'typing speed'] },
  { section: 'terminal', group: 'Buffer & rendering', label: 'Scrollback lines', keywords: ['history', 'buffer', 'lines kept'] },
  { section: 'terminal', group: 'Buffer & rendering', label: 'GPU renderer (WebGL)', keywords: ['performance', 'hardware acceleration', 'rendering'] },

  // Local shells
  { section: 'local-shells', group: 'Default', label: 'Default profile', keywords: ['local terminal', 'shell'] },
  { section: 'local-shells', group: 'Default', label: 'Automatic shell', keywords: ['bash', 'zsh', 'powershell', 'cmd', 'shell'] },
  { section: 'local-shells', kind: 'group', label: 'Saved profiles', keywords: ['shell profile', 'powershell', 'command prompt', 'wsl', 'startup commands', 'arguments'] },
  { section: 'local-shells', kind: 'group', label: 'WSL distributions', keywords: ['ubuntu', 'debian', 'linux'], only: 'windows' },
  { section: 'local-shells', group: 'WSL distributions', label: 'List installed distributions', keywords: ['wsl', 'ubuntu'], only: 'windows' },

  // Session logging
  { section: 'logging', kind: 'group', label: 'Default policy', keywords: ['record', 'log sessions', 'session history', 'input', 'rotate', 'retain'] },
  { section: 'logging', kind: 'group', label: 'Local terminals', keywords: ['local logging', 'record'] },
  { section: 'logging', kind: 'group', label: 'Log files', keywords: ['log folder', 'file name', 'text log', 'directory'] },
  { section: 'logging', group: 'Log files', label: 'Show timestamps (UTC)', keywords: ['time', 'log file'] },
  { section: 'logging', kind: 'group', label: 'Storage & retention', keywords: ['history location', 'quota', 'disk space', 'maximum age', 'cleanup'] },
  { section: 'logging', group: 'Storage & retention', label: 'Current usage', keywords: ['disk space', 'history size'] },

  // Highlighting
  { section: 'highlighting', kind: 'group', label: 'Global rules', keywords: ['keyword', 'regex', 'color', 'highlight'] },
  { section: 'highlighting', kind: 'group', label: 'Reusable profiles', keywords: ['nokia', 'sr os', 'sr linux', 'keyword', 'highlight'] },

  // Behavior
  { section: 'behavior', group: 'Tabs', label: 'Confirm before closing a live session', keywords: ['close tab', 'warning', 'prompt'] },
  { section: 'behavior', group: 'Tabs', label: 'Close the tab when its shell exits', keywords: ['exit', 'logout', 'ctrl+d', 'close tab', 'session ended'] },
  { section: 'behavior', group: 'Hosts sidebar', label: 'Open hosts with', keywords: ['single click', 'double-click', 'sidebar'] },
  { section: 'behavior', group: 'New hosts', label: 'Save new SSH hosts in', keywords: ['openssh', 'ssh config', 'storage'] },
  { section: 'behavior', group: 'Connecting', label: 'Show a summary when an SSH session connects', keywords: ['cipher', 'encryption', 'connection info'] },
  { section: 'behavior', group: 'Restore & reconnect', label: 'SSH keepalive interval', keywords: ['serveraliveinterval', 'timeout', 'idle', 'firewall', 'nat'] },
  { section: 'behavior', group: 'Restore & reconnect', label: 'Automatically reconnect remote sessions', keywords: ['auto reconnect', 'redial', 'workspace restore'] },
  { section: 'behavior', group: 'Restore & reconnect', label: 'Restore terminal history', keywords: ['scrollback', 'restore', 'output'] },
  { section: 'behavior', group: 'Links', label: 'SSH links', keywords: ['ssh://', 'url handler', 'default app', 'protocol'], only: 'desktop' },
  { section: 'behavior', group: 'Links', label: 'Telnet links', keywords: ['telnet://', 'url handler', 'default app', 'protocol'], only: 'desktop' },

  // X11 forwarding
  { section: 'x11', label: 'Enable X11 forwarding', keywords: ['x server', 'xquartz', 'vcxsrv', 'display'] },
  { section: 'x11', group: 'Defaults', label: 'Forward X11 by default', keywords: ['forwardx11', 'display'] },
  // Only the X server bundled with the Windows app shares the clipboard.
  { section: 'x11', group: 'Defaults', label: 'Share the clipboard with X11 apps', keywords: ['clipboard', 'copy', 'paste'], only: 'windows' },

  // Keyboard
  { section: 'keyboard', group: 'Panes & tabs', label: 'New splits continue the current session', keywords: ['split', 'pane', 'same host'] },
  { section: 'keyboard', group: 'Panes & tabs', label: 'Show tab numbers', keywords: ['numbered tabs', 'alt'] },
  { section: 'keyboard', kind: 'group', label: 'Layout keys', keywords: ['keyboard shortcuts', 'keybindings', 'hotkeys', 'rebind', 'chords'] },

  // Passwords
  { section: 'passwords', group: 'Vault', label: 'Password vault', keywords: ['master password', 'encryption', 'credentials', 'keychain'] },
  { section: 'passwords', group: 'Vault', label: 'Remember passwords by default', keywords: ['save password'] },
  { section: 'passwords', group: 'Vault', label: 'Ask for the master password', keywords: ['unlock', 'startup'] },
  { section: 'passwords', group: 'Vault', label: 'Master password', keywords: ['change password'] },
  { section: 'passwords', group: 'Vault', label: 'Delete the vault', keywords: ['reset', 'forgot password', 'remove'] },
  { section: 'passwords', kind: 'group', label: 'Secrets', keywords: ['enable password', 'sudo', 'pin', 'send secret'] },
  { section: 'passwords', kind: 'group', label: 'Saved SSH passwords', keywords: ['credentials', 'remembered passwords'] },

  // Backup & data
  { section: 'data', group: 'Backup & restore', label: 'Back up your setup', keywords: ['export', 'backup', 'settings file'] },
  { section: 'data', group: 'Backup & restore', label: 'Restore a backup', keywords: ['import', 'backup'] },
  { section: 'data', group: 'Export', label: 'OpenSSH config', keywords: ['ssh_config', 'export hosts'] },
  { section: 'data', group: 'Import from other clients', label: 'MobaXterm', keywords: ['import sessions', 'migrate'] },
  { section: 'data', group: 'Import from other clients', label: 'SecureCRT', keywords: ['import sessions', 'migrate', 'button bar'] },

  // Debug
  { section: 'debug', label: 'Capture verbose diagnostic logs', keywords: ['debug mode', 'logging', 'troubleshoot'] },
  { section: 'debug', label: 'Application log', keywords: ['view logs', 'export logs', 'main.log', 'bug report'] },

  // About
  { section: 'about', group: 'Updates', label: 'Notify me when a new version is available', keywords: ['update', 'upgrade', 'release'] },
  { section: 'about', group: 'Updates', label: 'Update check', keywords: ['update', 'upgrade', 'version'] },
  { section: 'about', kind: 'group', label: 'This installation', keywords: ['version', 'diagnostics', 'platform'] },
  { section: 'about', group: 'Made by', label: 'FloSch', keywords: ['author', 'github', 'source code'] },
  { section: 'about', group: 'Made by', label: 'Support Muxus', keywords: ['donate', 'sponsor', 'coffee'] },
];

/** Where search runs: settings that do not exist there are left out. */
export interface SettingsSearchContext {
  sectionLabel: (section: SettingsSection) => string;
  desktop: boolean;
  /** The backend's platform, e.g. "win32"; unknown until the app info arrives. */
  platform?: string;
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** "OSC 52" and "osc52", "X11" and "x 11" find the same setting. */
function squash(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function contains(field: string, word: string): boolean {
  if (field.includes(word)) return true;
  const squashed = squash(word);
  return squashed !== '' && squash(field).includes(squashed);
}

function startsWord(field: string, word: string): boolean {
  return field.startsWith(word) || field.includes(` ${word}`) || field.includes(`(${word}`);
}

/** Lower is better; undefined when some word of the query matches nowhere. */
function rank(entry: SettingsSearchEntry, query: string, words: string[], section: string): number | undefined {
  const label = normalize(entry.label);
  const fields = [
    label,
    normalize(entry.group ?? ''),
    normalize(entry.row ?? ''),
    normalize(section),
    ...(entry.keywords ?? []).map(normalize),
  ];
  if (!words.every((word) => fields.some((field) => contains(field, word)))) return undefined;
  if (label.startsWith(query)) return 0;
  if (words.every((word) => startsWord(label, word))) return 1;
  if (words.every((word) => contains(label, word))) return 2;
  return 3;
}

/** Settings matching every word of `query`, best match first, then in Settings order. */
export function searchSettings(
  query: string,
  context: SettingsSearchContext,
  entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX,
): SettingsSearchEntry[] {
  const normalized = normalize(query).trim().replace(/\s+/g, ' ');
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  return entries
    .filter((entry) =>
      entry.only === 'desktop'
        ? context.desktop
        : entry.only === 'windows'
          ? context.platform === 'win32'
          : true,
    )
    .map((entry) => ({ entry, rank: rank(entry, normalized, words, context.sectionLabel(entry.section)) }))
    .filter((match): match is { entry: SettingsSearchEntry; rank: number } => match.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .map((match) => match.entry);
}

/** The label a search result outlines: a group title drops its "· count" suffix. */
export function settingsTitleKey(title: string): string {
  const separator = title.indexOf(' · ');
  return separator < 0 ? title : title.slice(0, separator);
}
