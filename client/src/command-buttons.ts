import type { CommandButton, CommandButtonGroup } from './state/prefs.js';
import type { TerminalHandle } from './terminal/terminal-registry.js';

const SEARCH_WORD_SEPARATOR = /\s+/;

/** The built-in group. It cannot be deleted and holds every unfiled button. */
export const DEFAULT_COMMAND_GROUP_ID = 'default';
export const DEFAULT_COMMAND_GROUP: CommandButtonGroup = {
  id: DEFAULT_COMMAND_GROUP_ID,
  name: 'Default',
};
export const MAX_COMMAND_BUTTONS = 500;
export const MAX_COMMAND_BUTTON_GROUPS = 50;
export const MAX_COMMAND_BUTTON_GROUP_NAME = 80;

/**
 * Accents a button can wear. Each has a darker ink for light mode and a
 * lighter one for dark mode, so labels stay readable on either bar.
 */
export const COMMAND_BUTTON_COLORS = [
  { id: 'red', name: 'Red', light: '#b91c1c', dark: '#f87171' },
  { id: 'orange', name: 'Orange', light: '#c2410c', dark: '#fb923c' },
  { id: 'amber', name: 'Amber', light: '#a16207', dark: '#fbbf24' },
  { id: 'green', name: 'Green', light: '#15803d', dark: '#4ade80' },
  { id: 'teal', name: 'Teal', light: '#0f766e', dark: '#2dd4bf' },
  { id: 'blue', name: 'Blue', light: '#1d4ed8', dark: '#60a5fa' },
  { id: 'purple', name: 'Purple', light: '#7e22ce', dark: '#c084fc' },
  { id: 'pink', name: 'Pink', light: '#be185d', dark: '#f472b6' },
  { id: 'gray', name: 'Gray', light: '#52525b', dark: '#a1a1aa' },
] as const;

export type CommandButtonColor = (typeof COMMAND_BUTTON_COLORS)[number]['id'];

export function isCommandButtonColor(value: unknown): value is CommandButtonColor {
  return COMMAND_BUTTON_COLORS.some((color) => color.id === value);
}

/** The text color of an accented button in the given theme. */
export function commandButtonInk(
  color: CommandButtonColor,
  mode: 'light' | 'dark',
): string {
  const entry = COMMAND_BUTTON_COLORS.find((candidate) => candidate.id === color)!;
  return mode === 'dark' ? entry.dark : entry.light;
}

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

/** Send a saved command and return keyboard focus to its terminal. */
export function activateCommandButton(
  terminal: Pick<TerminalHandle, 'focus' | 'sendInput'> | undefined,
  button: CommandButton,
): boolean {
  if (!terminal) return false;
  const sent = terminal.sendInput(commandButtonInput(button));
  terminal.focus();
  return sent;
}

/** What a button shows: its label, else its command, never nothing. */
export function commandButtonLabel(button: CommandButton): string {
  return button.label.trim() || button.command.trim() || 'Command';
}

export function newPreferenceId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Stored groups, repaired: malformed entries dropped, ids unique, and the
 * default group first and exactly once. Anything but an array is undefined.
 */
export function normalizeCommandButtonGroups(value: unknown): CommandButtonGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const groups: CommandButtonGroup[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !boundedString(entry.id, 200) || ids.has(entry.id)) continue;
    if (typeof entry.name !== 'string') continue;
    ids.add(entry.id);
    const name = entry.name.trim().slice(0, MAX_COMMAND_BUTTON_GROUP_NAME);
    groups.push({
      id: entry.id,
      name: name || (entry.id === DEFAULT_COMMAND_GROUP_ID ? DEFAULT_COMMAND_GROUP.name : 'Untitled group'),
    });
  }
  const defaultGroup =
    groups.find((group) => group.id === DEFAULT_COMMAND_GROUP_ID) ?? DEFAULT_COMMAND_GROUP;
  return [
    defaultGroup,
    ...groups
      .filter((group) => group.id !== DEFAULT_COMMAND_GROUP_ID)
      .slice(0, MAX_COMMAND_BUTTON_GROUPS - 1),
  ];
}

/**
 * Stored buttons, repaired against their groups: malformed entries dropped,
 * unknown colors cleared, and a button whose group is gone (or is the default
 * one) left unfiled. Anything but an array is undefined.
 */
export function normalizeCommandButtons(
  value: unknown,
  groups: readonly CommandButtonGroup[],
): CommandButton[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groupIds = new Set(groups.map((group) => group.id));
  const ids = new Set<string>();
  const buttons: CommandButton[] = [];
  for (const entry of value) {
    if (buttons.length >= MAX_COMMAND_BUTTONS) break;
    if (
      !isRecord(entry) ||
      !boundedString(entry.id, 200) ||
      ids.has(entry.id) ||
      typeof entry.label !== 'string' ||
      entry.label.length > 200 ||
      typeof entry.command !== 'string' ||
      entry.command.length > 100_000
    ) {
      continue;
    }
    ids.add(entry.id);
    const groupId =
      typeof entry.groupId === 'string' &&
      entry.groupId !== DEFAULT_COMMAND_GROUP_ID &&
      groupIds.has(entry.groupId)
        ? entry.groupId
        : undefined;
    buttons.push({
      id: entry.id,
      label: entry.label,
      command: entry.command,
      sendEnter: entry.sendEnter !== false,
      ...(groupId ? { groupId } : {}),
      ...(isCommandButtonColor(entry.color) ? { color: entry.color } : {}),
    });
  }
  return buttons;
}

/** The group a button is filed under; unfiled buttons are in the default group. */
export function commandButtonGroupOf(
  button: CommandButton,
  groups: readonly CommandButtonGroup[],
): string {
  return button.groupId && groups.some((group) => group.id === button.groupId)
    ? button.groupId
    : DEFAULT_COMMAND_GROUP_ID;
}

export function commandButtonsInGroup(
  buttons: readonly CommandButton[],
  groups: readonly CommandButtonGroup[],
  groupId: string,
): CommandButton[] {
  return buttons.filter((button) => commandButtonGroupOf(button, groups) === groupId);
}

/** Swap a button with its neighbor in its own group; other groups keep their places. */
export function moveCommandButton(
  buttons: readonly CommandButton[],
  groups: readonly CommandButtonGroup[],
  id: string,
  offset: -1 | 1,
): CommandButton[] {
  const index = buttons.findIndex((button) => button.id === id);
  if (index < 0) return [...buttons];
  const groupId = commandButtonGroupOf(buttons[index]!, groups);
  let target = index + offset;
  while (
    target >= 0 &&
    target < buttons.length &&
    commandButtonGroupOf(buttons[target]!, groups) !== groupId
  ) {
    target += offset;
  }
  if (target < 0 || target >= buttons.length) return [...buttons];
  const next = [...buttons];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** File a button under another group, after that group's last button. */
export function moveCommandButtonToGroup(
  buttons: readonly CommandButton[],
  groups: readonly CommandButtonGroup[],
  id: string,
  groupId: string,
): CommandButton[] {
  const button = buttons.find((candidate) => candidate.id === id);
  if (!button || commandButtonGroupOf(button, groups) === groupId) return [...buttons];
  const { groupId: _previous, ...rest } = button;
  const moved: CommandButton =
    groupId === DEFAULT_COMMAND_GROUP_ID ? rest : { ...rest, groupId };
  const remaining = buttons.filter((candidate) => candidate.id !== id);
  const last = remaining.findLastIndex(
    (candidate) => commandButtonGroupOf(candidate, groups) === groupId,
  );
  const at = last < 0 ? remaining.length : last + 1;
  return [...remaining.slice(0, at), moved, ...remaining.slice(at)];
}

/** A copy of a button right below the original, as a start for a similar command. */
export function duplicateCommandButton(
  buttons: readonly CommandButton[],
  id: string,
  newId: string,
): CommandButton[] {
  const index = buttons.findIndex((button) => button.id === id);
  if (index < 0) return [...buttons];
  const original = buttons[index]!;
  const copy: CommandButton = {
    ...original,
    id: newId,
    label: original.label.trim() ? `${original.label.trim()} copy`.slice(0, 80) : '',
  };
  return [...buttons.slice(0, index + 1), copy, ...buttons.slice(index + 1)];
}

/** Move a group one step; the default group always stays first. */
export function moveCommandButtonGroup(
  groups: readonly CommandButtonGroup[],
  id: string,
  offset: -1 | 1,
): CommandButtonGroup[] {
  const index = groups.findIndex((group) => group.id === id);
  const target = index + offset;
  if (index < 1 || target < 1 || target >= groups.length) return [...groups];
  const next = [...groups];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Remove a group and every button filed under it. The default group stays. */
export function withoutCommandButtonGroup(
  buttons: readonly CommandButton[],
  groups: readonly CommandButtonGroup[],
  id: string,
): { commandButtons: CommandButton[]; commandButtonGroups: CommandButtonGroup[] } {
  if (id === DEFAULT_COMMAND_GROUP_ID) {
    return { commandButtons: [...buttons], commandButtonGroups: [...groups] };
  }
  return {
    commandButtons: buttons.filter((button) => commandButtonGroupOf(button, groups) !== id),
    commandButtonGroups: groups.filter((group) => group.id !== id),
  };
}

/** "New group", or the first numbered variant no group is called yet. */
export function unusedCommandButtonGroupName(groups: readonly CommandButtonGroup[]): string {
  const names = new Set(groups.map((group) => group.name.trim().toLocaleLowerCase()));
  if (!names.has('new group')) return 'New group';
  let suffix = 2;
  while (names.has(`new group ${suffix}`)) suffix++;
  return `New group ${suffix}`;
}

/**
 * The group the command bar and the keyboard menu show. A group picked while
 * a session was active wins for that session, then the group its host opens,
 * then the group last picked for sessions without one. Groups that no longer
 * exist are skipped.
 */
export function shownCommandButtonGroup(
  groups: readonly CommandButtonGroup[],
  choice: {
    session?: string;
    host?: string;
    selected?: string;
  },
): string {
  for (const id of [choice.session, choice.host, choice.selected]) {
    if (id && groups.some((group) => group.id === id)) return id;
  }
  return DEFAULT_COMMAND_GROUP_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
