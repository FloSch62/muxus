import { commandsForEvent } from './keymap/bindings.js';
import { isModifierCode } from './keymap/chords.js';
import { runKeyCommand } from './keymap/commands.js';
import { requestClosePane } from './session-actions.js';
import { usePrefsStore } from './state/prefs.js';
import { useTabsStore } from './state/tabs.js';

let capturing = false;

/**
 * Suspend dispatch while the shortcut editor records a chord, so the keys
 * being captured cannot also fire the command they are about to replace.
 */
export function setChordCaptureActive(active: boolean): void {
  capturing = active;
}

/**
 * Text entry always wins: bindings never fire inside inputs, Monaco, or any
 * editable element. The terminal is the exception — its helper textarea is
 * where terminal chords are supposed to work.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('.xterm')) return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor',
  );
}

/**
 * One capture-phase listener owns every app shortcut. Running before xterm's
 * own key handling means a bound chord never reaches the shell, while a
 * command that declines (no pane in that direction, no selection to copy)
 * leaves the key untouched for the terminal to encode.
 *
 * Desktop chords the OS claims first (Cmd/Ctrl+W, Ctrl+Tab) arrive over the
 * Electron bridge instead, and run the same commands.
 */
export function installShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (capturing || event.defaultPrevented || event.isComposing) return;
    if (isModifierCode(event.code) || isTypingTarget(event.target)) return;
    for (const command of commandsForEvent(event, usePrefsStore.getState().keybindings)) {
      if (!command.run()) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  };
  window.addEventListener('keydown', onKeyDown, true);

  const unsubscribers = [
    window.muxusDesktop?.onCloseTab(() => {
      if (runKeyCommand('tab.close')) return;
      const { root, activePaneId } = useTabsStore.getState();
      if (root.type === 'split') void requestClosePane(activePaneId);
      else window.muxusDesktop?.closeWindow();
    }),
    window.muxusDesktop?.onCycleTab((backwards) => {
      runKeyCommand(backwards ? 'tab.previous' : 'tab.next');
    }),
  ];

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    for (const unsub of unsubscribers) unsub?.();
  };
}
