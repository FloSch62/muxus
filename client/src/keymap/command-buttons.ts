import type { QueryClient } from '@tanstack/react-query';
import type { PasswordVaultStatus } from '@muxus/shared';
import { commandButtonLabel } from '../command-buttons.js';
import type { CommandButton, PrefsState } from '../state/prefs.js';
import { isMultiExecTarget, useTabsStore } from '../state/tabs.js';
import { findVaultSecret, runCommandButton, vaultSecretMissing } from '../vault-secrets.js';
import { commandsForChord } from './bindings.js';
import { formatChordString, parseChord, sendsControlCharacter } from './chords.js';
import type { KeyCommand } from './commands.js';

/** The keyboard command id a button's shortcut is registered under. */
export function commandButtonCommandId(buttonId: string): string {
  return `command-button:${buttonId}`;
}

/**
 * Buttons that carry a shortcut, as keyboard commands: they share the
 * dispatcher, the conflict checks and the keyboard sheet with the app's own.
 * `queryClient` is what a click hands a secret button.
 */
export function commandButtonCommands(
  buttons: readonly CommandButton[],
  queryClient?: QueryClient,
): KeyCommand[] {
  return buttons.flatMap((button) => {
    const shortcut = commandButtonShortcut(button);
    return shortcut
      ? [
          {
            id: commandButtonCommandId(button.id),
            title: commandButtonLabel(button),
            category: 'buttons' as const,
            defaultChords: [shortcut],
            palette: false,
            run: () => runCommandButtonShortcut(button, queryClient),
          },
        ]
      : [];
  });
}

/**
 * The chord that runs `button`, and so the one the bar and the Ctrl+Space
 * menu show. Persisted prefs are normalized only on a version change, so a
 * saved chord the shell owns is left out here too, whatever saved it.
 */
export function commandButtonShortcut(button: CommandButton): string | undefined {
  return button.shortcut && !shellOwns(button.shortcut) ? button.shortcut : undefined;
}

/**
 * Run a button from its shortcut the way a click does. False, so the key
 * reaches the shell, unless a connected terminal has focus and the button has
 * something to send.
 */
export function runCommandButtonShortcut(
  button: CommandButton,
  queryClient?: QueryClient,
): boolean {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((candidate) => candidate.id === activeId);
  if (!tab || !isMultiExecTarget(tab)) return false;
  const vault = queryClient?.getQueryData<PasswordVaultStatus>(['password-vault']);
  // Nothing to send, as the Ctrl+Space menu judges it: blank text, or no secret.
  if (button.secretId === undefined) {
    if (!button.command.trim()) return false;
  } else if (!button.secretId || vaultSecretMissing(vault, button.secretId) === true) {
    return false;
  }
  return runCommandButton(tab.id, button, {
    secretName: button.secretId ? findVaultSecret(vault, button.secretId)?.name : undefined,
    queryClient,
  });
}

/**
 * Why a button cannot take `chord`: the shell owns it, or a command or another
 * button already answers to it, named. Undefined when the chord is free.
 */
export function commandButtonShortcutConflict(
  chord: string,
  buttonId: string,
  prefs: Pick<PrefsState, 'keybindings' | 'commandButtons'>,
): string | undefined {
  if (shellOwns(chord)) {
    return `${formatChordString(chord)} is kept for the shell.`;
  }
  const others = prefs.commandButtons.filter((button) => button.id !== buttonId);
  const [taken] = commandsForChord(chord, prefs.keybindings, commandButtonCommands(others));
  if (!taken) return undefined;
  const name =
    taken.category === 'buttons' ? `the command button “${taken.title}”` : `“${taken.title}”`;
  return `${formatChordString(chord)} already runs ${name}.`;
}

/** A stored chord the shell keeps, which no button runs from. */
export function shellOwns(text: string): boolean {
  const chord = parseChord(text);
  return !!chord && sendsControlCharacter(chord);
}
