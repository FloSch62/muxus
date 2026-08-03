import type { CommandButton } from './state/prefs.js';

const SEARCH_WORD_SEPARATOR = /\s+/;

/** Match every search word against a saved command's label or command text. */
export function filterCommandButtons(
  buttons: readonly CommandButton[],
  query: string,
): readonly CommandButton[] {
  const words = query.trim().toLowerCase().split(SEARCH_WORD_SEPARATOR).filter(Boolean);
  if (words.length === 0) return buttons;
  return buttons.filter((button) => {
    const searchable = `${button.label} ${button.command}`.toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}

/** Convert saved, possibly multiline text to terminal Enter characters. */
export function commandButtonInput(button: CommandButton): string {
  const command = button.command.replace(/\r\n|\n/g, '\r');
  if (!button.sendEnter || command.endsWith('\r')) return command;
  return `${command}\r`;
}

export function newPreferenceId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
