import type { CommandButton } from './state/prefs.js';

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
