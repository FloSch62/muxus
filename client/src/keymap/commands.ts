import { copyToClipboard } from '../clipboard.js';
import { IS_MAC } from '../platform.js';
import { requestCloseRemoteEditor } from '../editor/remote-editor-registry.js';
import {
  duplicateTab,
  openEmptyTab,
  requestCloseActivePane,
  requestCloseTabs,
  splitActivePane,
  toggleMultiExec,
} from '../session-actions.js';
import { usePrefsStore } from '../state/prefs.js';
import { PANE_RESIZE_STEP, useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { terminalHandle } from '../terminal/terminal-registry.js';
import type { PaneDirection } from '../state/workspace-layout.js';

export type CommandCategory = 'panes' | 'tabs' | 'terminal' | 'app';

export interface KeyCommand {
  id: string;
  title: string;
  category: CommandCategory;
  /** Chords applied when the user has not rebound the command. */
  defaultChords: string[];
  /** Extra words the command palette should match on. */
  keywords?: string[];
  /** Commands too numerous or too situational to list in the palette. */
  palette?: boolean;
  /**
   * Runs the command. Returning `false` means "not applicable right now" and
   * leaves the key to whatever would have received it — the terminal keeps
   * Alt+← for word motion until a pane actually sits to the left.
   */
  run: () => boolean;
}

export const COMMAND_CATEGORY_LABELS: Record<CommandCategory, string> = {
  panes: 'Panes',
  tabs: 'Tabs',
  terminal: 'Terminal',
  app: 'Application',
};

/** Chords only offered where Command is the modifier — Ctrl belongs to the shell. */
const macOnly = (chord: string): string[] => (IS_MAC ? [chord] : []);

const tabs = () => useTabsStore.getState();
const activeTerminal = () => terminalHandle(useTabsStore.getState().activeId);

const DIRECTION_LABELS: Record<PaneDirection, string> = {
  left: 'left',
  right: 'right',
  up: 'up',
  down: 'down',
};

const DIRECTION_ARROWS: Record<PaneDirection, string> = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
};

function splitCommand(direction: PaneDirection, extraChords: string[] = []): KeyCommand {
  return {
    id: `pane.split.${direction}`,
    title: `Split pane ${DIRECTION_LABELS[direction]}`,
    category: 'panes',
    defaultChords: [`Mod+Shift+${DIRECTION_ARROWS[direction]}`, ...extraChords],
    keywords: ['split', 'divide', 'new pane', direction],
    run: () => splitActivePane(direction),
  };
}

function focusCommand(direction: PaneDirection): KeyCommand {
  return {
    id: `pane.focus.${direction}`,
    title: `Focus pane ${DIRECTION_LABELS[direction]}`,
    category: 'panes',
    defaultChords: [`Alt+${DIRECTION_ARROWS[direction]}`],
    keywords: ['focus', 'move', 'navigate', direction],
    run: () => tabs().focusPaneDirection(direction),
  };
}

function moveTabCommand(direction: PaneDirection): KeyCommand {
  return {
    id: `tab.to-pane.${direction}`,
    title: `Move tab to pane ${DIRECTION_LABELS[direction]}`,
    category: 'tabs',
    defaultChords: [`Alt+Shift+${DIRECTION_ARROWS[direction]}`],
    keywords: ['move', 'send', 'detach', 'split off', direction],
    run: () => tabs().moveTabToDirection(direction),
  };
}

function selectTabCommand(position: number, id = String(position)): KeyCommand {
  return {
    id: `tab.select.${id}`,
    title: `Go to tab ${position}`,
    category: 'tabs',
    // Ctrl+2…Ctrl+8 are control characters (Ctrl+3 is Escape); leave them
    // to the terminal and take the Alt row that every terminal app uses.
    defaultChords: [`Alt+Digit${position}`, ...macOnly(`Mod+Digit${position}`)],
    keywords: ['switch', 'jump', 'numbered tab', `tab ${position}`],
    palette: false,
    run: () => tabs().activateTabIndex(position - 1),
  };
}

export const KEY_COMMANDS: readonly KeyCommand[] = [
  // Panes
  splitCommand('right', ['Alt+Shift+Equal']),
  splitCommand('down', ['Alt+Shift+Minus']),
  splitCommand('left'),
  splitCommand('up'),
  focusCommand('left'),
  focusCommand('right'),
  focusCommand('up'),
  focusCommand('down'),
  {
    id: 'pane.focus.next',
    title: 'Focus next pane',
    category: 'panes',
    defaultChords: ['Mod+Shift+O'],
    keywords: ['cycle', 'rotate', 'other pane'],
    run: () => tabs().cyclePane(false),
  },
  {
    id: 'pane.focus.previous',
    title: 'Focus previous pane',
    category: 'panes',
    defaultChords: [],
    keywords: ['cycle', 'rotate'],
    run: () => tabs().cyclePane(true),
  },
  {
    id: 'pane.zoom',
    title: 'Zoom pane / restore layout',
    category: 'panes',
    defaultChords: ['Mod+Shift+Z'],
    keywords: ['maximize', 'fullscreen', 'expand', 'tmux'],
    run: () => tabs().toggleZoom(),
  },
  {
    id: 'pane.grow',
    title: 'Grow pane',
    category: 'panes',
    defaultChords: ['Mod+Shift+Period'],
    keywords: ['resize', 'wider', 'taller'],
    run: () => tabs().resizeActivePane(PANE_RESIZE_STEP),
  },
  {
    id: 'pane.shrink',
    title: 'Shrink pane',
    category: 'panes',
    defaultChords: ['Mod+Shift+Comma'],
    keywords: ['resize', 'narrower', 'shorter'],
    run: () => tabs().resizeActivePane(-PANE_RESIZE_STEP),
  },
  {
    id: 'pane.equalize',
    title: 'Even out panes',
    category: 'panes',
    defaultChords: [],
    keywords: ['balance', 'reset', 'equal', 'layout'],
    run: () => tabs().equalizePanes(),
  },
  {
    id: 'pane.close',
    title: 'Close pane',
    category: 'panes',
    defaultChords: ['Mod+Shift+X'],
    keywords: ['remove', 'kill'],
    run: () => requestCloseActivePane(),
  },

  // Tabs
  {
    id: 'tab.new',
    title: 'New tab',
    category: 'tabs',
    defaultChords: ['Mod+Shift+T'],
    keywords: ['open', 'session'],
    run: () => {
      openEmptyTab();
      return true;
    },
  },
  {
    id: 'tab.duplicate',
    title: 'Duplicate tab',
    category: 'tabs',
    defaultChords: ['Mod+Shift+D'],
    keywords: ['clone', 'second session'],
    run: () => duplicateTab(useTabsStore.getState().activeId ?? ''),
  },
  {
    id: 'tab.close',
    title: 'Close tab',
    category: 'tabs',
    // Ctrl+W deletes a word in every shell, so only Command takes it.
    defaultChords: ['Mod+Shift+W', ...macOnly('Mod+W')],
    keywords: ['end session'],
    run: () => {
      const { activeId } = tabs();
      if (!activeId) return false;
      if (requestCloseRemoteEditor(activeId)) return true;
      void requestCloseTabs([activeId]);
      return true;
    },
  },
  {
    id: 'tab.next',
    title: 'Next tab',
    category: 'tabs',
    defaultChords: ['Ctrl+PageDown', 'Mod+Shift+BracketRight'],
    keywords: ['cycle', 'switch'],
    run: () => {
      tabs().cycle(false);
      return true;
    },
  },
  {
    id: 'tab.previous',
    title: 'Previous tab',
    category: 'tabs',
    defaultChords: ['Ctrl+PageUp', 'Mod+Shift+BracketLeft'],
    keywords: ['cycle', 'switch'],
    run: () => {
      tabs().cycle(true);
      return true;
    },
  },
  {
    id: 'tab.move.previous',
    title: 'Move tab left in the strip',
    category: 'tabs',
    defaultChords: ['Ctrl+Shift+PageUp'],
    keywords: ['reorder', 'rearrange'],
    run: () => tabs().moveTabWithinPane(-1),
  },
  {
    id: 'tab.move.next',
    title: 'Move tab right in the strip',
    category: 'tabs',
    defaultChords: ['Ctrl+Shift+PageDown'],
    keywords: ['reorder', 'rearrange'],
    run: () => tabs().moveTabWithinPane(1),
  },
  moveTabCommand('left'),
  moveTabCommand('right'),
  moveTabCommand('up'),
  moveTabCommand('down'),
  selectTabCommand(1),
  selectTabCommand(2),
  selectTabCommand(3),
  selectTabCommand(4),
  selectTabCommand(5),
  selectTabCommand(6),
  selectTabCommand(7),
  selectTabCommand(8),
  // Keep the legacy command id so existing custom bindings survive, while
  // making 9 select the tab visibly labelled 9 instead of an unrelated last tab.
  selectTabCommand(9, 'last'),

  // Terminal
  {
    id: 'terminal.copy',
    title: 'Copy selection',
    category: 'terminal',
    defaultChords: ['Mod+Shift+C'],
    palette: false,
    run: () => {
      const handle = activeTerminal();
      if (!handle?.hasSelection()) return false;
      void copyToClipboard(handle.getSelection());
      return true;
    },
  },
  {
    id: 'terminal.paste',
    title: 'Paste into terminal',
    category: 'terminal',
    defaultChords: ['Mod+Shift+V'],
    palette: false,
    run: () => {
      const handle = activeTerminal();
      if (!handle) return false;
      handle.pasteClipboard();
      return true;
    },
  },
  {
    id: 'terminal.command-menu',
    title: 'Show saved command menu',
    category: 'terminal',
    // Ctrl+Space deliberately takes NUL from the shell: it matches the
    // MobaXterm macro picker and remains Control (not Command) on macOS.
    defaultChords: ['Ctrl+Space'],
    keywords: ['command buttons', 'commands', 'macros', 'MobaXterm'],
    run: () => {
      useUiStore.getState().setCommandButtonMenuOpen(true);
      return true;
    },
  },
  {
    id: 'terminal.find',
    title: 'Find in terminal',
    category: 'terminal',
    defaultChords: ['Mod+Shift+F'],
    keywords: ['search', 'scrollback'],
    run: () => {
      const state = tabs();
      if (!state.activeId) return false;
      state.requestSearch();
      return true;
    },
  },
  {
    id: 'terminal.select-all',
    title: 'Select all terminal output',
    category: 'terminal',
    defaultChords: ['Mod+Shift+A'],
    palette: false,
    run: () => {
      const handle = activeTerminal();
      if (!handle) return false;
      handle.selectAll();
      return true;
    },
  },
  {
    id: 'terminal.clear',
    title: 'Clear scrollback',
    category: 'terminal',
    defaultChords: ['Mod+Shift+K'],
    keywords: ['erase', 'reset'],
    run: () => {
      const handle = activeTerminal();
      if (!handle) return false;
      handle.clear();
      return true;
    },
  },
  {
    id: 'terminal.multi-exec',
    title: 'Toggle multi-execution',
    category: 'terminal',
    defaultChords: ['Mod+Shift+M'],
    keywords: ['multi-exec', 'mirror', 'broadcast', 'sync input', 'all sessions'],
    run: () => toggleMultiExec(),
  },
  {
    id: 'terminal.zoom-in',
    title: 'Increase terminal font size',
    category: 'terminal',
    defaultChords: ['Mod+Shift+Equal', 'Mod+Equal'],
    keywords: ['zoom', 'bigger'],
    run: () => {
      const handle = activeTerminal();
      if (!handle) return false;
      handle.zoomIn();
      return true;
    },
  },
  {
    id: 'terminal.zoom-out',
    title: 'Decrease terminal font size',
    category: 'terminal',
    defaultChords: ['Mod+Shift+Minus', 'Mod+Minus'],
    keywords: ['zoom', 'smaller'],
    run: () => {
      const handle = activeTerminal();
      if (!handle) return false;
      handle.zoomOut();
      return true;
    },
  },
  {
    id: 'terminal.zoom-reset',
    title: 'Reset terminal font size',
    category: 'terminal',
    defaultChords: ['Mod+Shift+Digit0', 'Mod+Digit0'],
    keywords: ['zoom', 'default'],
    run: () => {
      const handle = activeTerminal();
      if (!handle) return false;
      handle.zoomReset();
      return true;
    },
  },

  // Application
  {
    id: 'app.quick-launcher',
    title: 'Open quick launcher',
    category: 'app',
    defaultChords: ['Mod+K'],
    palette: false,
    run: () => {
      useUiStore.getState().setQuickLauncherOpen(true);
      return true;
    },
  },
  {
    id: 'app.sidebar',
    title: 'Toggle hosts sidebar',
    category: 'app',
    defaultChords: ['Mod+B'],
    keywords: ['hosts', 'sessions', 'sidebar', 'hide', 'show'],
    run: () => {
      const prefs = usePrefsStore.getState();
      prefs.set({ sidebarCollapsed: !prefs.sidebarCollapsed });
      return true;
    },
  },
  {
    id: 'app.focus-mode',
    title: 'Toggle focus mode',
    category: 'app',
    defaultChords: ['Mod+Shift+B'],
    keywords: ['distraction free', 'zen', 'fullscreen', 'hide chrome'],
    run: () => {
      const ui = useUiStore.getState();
      ui.setFocusMode(!ui.focusMode);
      return true;
    },
  },
  {
    id: 'app.settings',
    title: 'Open settings',
    category: 'app',
    defaultChords: ['Mod+Comma'],
    palette: false,
    run: () => {
      useUiStore.getState().setSettingsOpen(true);
      return true;
    },
  },
  {
    id: 'app.shortcuts',
    title: 'Show keyboard shortcuts',
    category: 'app',
    defaultChords: ['Mod+Shift+Slash'],
    keywords: ['keys', 'bindings', 'help', 'cheat sheet'],
    run: () => {
      useUiStore.getState().setShortcutsOpen(true);
      return true;
    },
  },
];

const BY_ID = new Map(KEY_COMMANDS.map((command) => [command.id, command]));

export function keyCommand(id: string): KeyCommand | undefined {
  return BY_ID.get(id);
}

/** Run a command by id, e.g. from a desktop menu accelerator. */
export function runKeyCommand(id: string): boolean {
  return keyCommand(id)?.run() ?? false;
}
