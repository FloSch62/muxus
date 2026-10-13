import type { QueryClient } from '@tanstack/react-query';
import { commandsForEvent } from './keymap/bindings.js';
import { isModifierCode } from './keymap/chords.js';
import { commandButtonCommands } from './keymap/command-buttons.js';
import { runKeyCommand, type KeyCommand } from './keymap/commands.js';
import { requestClosePane } from './session-actions.js';
import { usePrefsStore, type CommandButton } from './state/prefs.js';
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
 * The keyup of a key the recorder or a button shortcut took still reaches the
 * focused control, and a focused chip deletes itself on a Backspace or Delete
 * keyup. Keep that keyup away from the page. It may never come (macOS sends
 * none for a key released while Cmd is held), so a later press of the key
 * ends the wait rather than leaving its own keyup swallowed.
 */
export function swallowKeyUp(code: string): void {
  const done = () => {
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('keydown', onKeyDown, true);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code !== code) return;
    event.stopImmediatePropagation();
    done();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === code && !event.repeat) done();
  };
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('keydown', onKeyDown, true);
}

/**
 * Text entry always wins: bindings never fire inside inputs or any editable
 * element. The terminal is the exception — its helper textarea is where
 * terminal chords are supposed to work — and Monaco only passes the commands
 * marked `inEditor`.
 */
function typingTarget(target: EventTarget | null): 'text' | 'editor' | undefined {
  if (!(target instanceof Element)) return undefined;
  if (target.closest('.xterm')) return undefined;
  if (target.closest('.monaco-editor')) return 'editor';
  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    ? 'text'
    : undefined;
}

/**
 * One capture-phase listener owns every app shortcut. Running before xterm's
 * own key handling means a bound chord never reaches the shell, while a
 * command that declines (no pane in that direction, no selection to copy)
 * leaves the key untouched for the terminal to encode.
 *
 * Desktop chords the OS claims first (Cmd/Ctrl+W, Ctrl+Tab) arrive over the
 * Electron bridge instead, and run the same commands.
 *
 * Command button shortcuts are tried after the app's commands, and run
 * buttons with the `queryClient` a click would use.
 */
export function installShortcuts(queryClient?: QueryClient): () => void {
  // Rebuilt only when the buttons change, so the binding index stays cached.
  let buttons: readonly CommandButton[] | undefined;
  let buttonCommands: KeyCommand[] = [];
  const shortcutCommands = (current: readonly CommandButton[]) => {
    if (current !== buttons) {
      buttons = current;
      buttonCommands = commandButtonCommands(current, queryClient);
    }
    return buttonCommands;
  };
  // A click never repeats, so a held button chord runs once; its auto-repeats
  // are swallowed rather than typed into the shell.
  let heldButtonId: string | undefined;
  const updateTabNumberReveal = (event: KeyboardEvent) => {
    if (!isModifierCode(event.code)) return;
    document.documentElement.classList.toggle(
      'muxus-tab-number-alt',
      event.altKey,
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    updateTabNumberReveal(event);
    if (!event.repeat) heldButtonId = undefined;
    if (capturing || event.defaultPrevented || event.isComposing) return;
    if (isModifierCode(event.code)) return;
    const typing = typingTarget(event.target);
    if (typing === 'text') return;
    const { keybindings, commandButtons } = usePrefsStore.getState();
    for (const command of commandsForEvent(event, keybindings, shortcutCommands(commandButtons))) {
      if (typing === 'editor' && !command.inEditor) continue;
      const button = command.category === 'buttons';
      const handled = button && event.repeat ? command.id === heldButtonId : command.run();
      if (!handled) continue;
      if (button) {
        heldButtonId = command.id;
        // The page saw no press, so it gets no release either.
        if (!event.repeat) swallowKeyUp(event.code);
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  };
  const hideTabNumbers = () => document.documentElement.classList.remove('muxus-tab-number-alt');
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', updateTabNumberReveal, true);
  window.addEventListener('blur', hideTabNumbers);

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
    window.removeEventListener('keyup', updateTabNumberReveal, true);
    window.removeEventListener('blur', hideTabNumbers);
    hideTabNumbers();
    for (const unsub of unsubscribers) unsub?.();
  };
}
