import { usePrefsStore } from '../state/prefs.js';
import { commandChords, type KeybindingOverrides } from './bindings.js';
import { formatChordString } from './chords.js';
import { keyCommand } from './commands.js';

/** Every chord bound to a command, rendered for the current platform. */
export function chordLabels(
  commandId: string,
  overrides: KeybindingOverrides,
): string[] {
  const command = keyCommand(commandId);
  return command ? commandChords(command, overrides).map(formatChordString) : [];
}

/** The chord to show next to a button or menu item, if the command has one. */
export function useChordLabel(commandId: string): string | undefined {
  const overrides = usePrefsStore((state) => state.keybindings);
  return chordLabels(commandId, overrides)[0];
}
