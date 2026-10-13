import {
  commandButtonGroupOf,
  DEFAULT_COMMAND_GROUP_ID,
  MAX_COMMAND_BUTTON_GROUPS,
  MAX_COMMAND_BUTTONS,
} from './command-buttons.js';
import type { TransferConflictStrategy } from './data-transfer.js';
import type { ImportedCommandBar } from './session-import.js';
import type { CommandButton, CommandButtonGroup } from './state/prefs.js';

export interface CommandButtonState {
  commandButtonGroups: readonly CommandButtonGroup[];
  commandButtons: readonly CommandButton[];
}

export interface CommandBarMergeResult {
  commandButtonGroups: CommandButtonGroup[];
  commandButtons: CommandButton[];
  /** Bars imported, replaced or left as they were. */
  added: number;
  replaced: number;
  kept: number;
  /** Bars or buttons dropped because the group or button limit was reached. */
  droppedBars: number;
  droppedButtons: number;
}

/**
 * Imported buttons get ids derived from their bar, so a later import can find
 * them again, even when they were filed under the Default group.
 */
export function importedCommandButtonId(bar: ImportedCommandBar, index: number): string {
  return `${bar.id}/button-${index}`;
}

function isFromBar(button: CommandButton, bar: ImportedCommandBar): boolean {
  return button.id.startsWith(`${bar.id}/`);
}

/**
 * The group an earlier import of this bar lives in: its own group, or the
 * Default group when it was imported there. Undefined if it was never imported.
 */
export function importedCommandBarGroup(
  bar: ImportedCommandBar,
  state: CommandButtonState,
): string | undefined {
  if (state.commandButtonGroups.some((group) => group.id === bar.id)) return bar.id;
  const inDefault = state.commandButtons.some(
    (button) =>
      isFromBar(button, bar) &&
      commandButtonGroupOf(button, state.commandButtonGroups) === DEFAULT_COMMAND_GROUP_ID,
  );
  return inDefault ? DEFAULT_COMMAND_GROUP_ID : undefined;
}

/**
 * Add imported button bars as command button groups.
 *
 * The source's default bar fills Muxus's Default group when that group holds
 * none of the user's own buttons; otherwise every bar becomes a group of its
 * own. A bar imported before is kept or replaced as a whole, and replacing
 * removes only the buttons that came from it. A new group whose name is taken
 * gets the source name appended.
 */
export function mergeImportedCommandBars(
  current: CommandButtonState,
  bars: readonly ImportedCommandBar[],
  conflicts: TransferConflictStrategy,
  sourceName: string,
): CommandBarMergeResult {
  const groups = [...current.commandButtonGroups];
  let buttons = [...current.commandButtons];
  const result = { added: 0, replaced: 0, kept: 0, droppedBars: 0, droppedButtons: 0 };

  for (const bar of bars) {
    let target = importedCommandBarGroup(bar, { commandButtonGroups: groups, commandButtons: buttons });
    if (target && conflicts === 'keep') {
      result.kept++;
      continue;
    }
    if (target) {
      // A replaced group keeps its place and any name the user gave it.
      buttons = buttons.filter(
        (button) =>
          !isFromBar(button, bar) && (target === DEFAULT_COMMAND_GROUP_ID || button.groupId !== bar.id),
      );
      result.replaced++;
    } else {
      const defaultHasOwnButtons = buttons.some(
        (button) => commandButtonGroupOf(button, groups) === DEFAULT_COMMAND_GROUP_ID,
      );
      if (bar.isDefault && !defaultHasOwnButtons) {
        target = DEFAULT_COMMAND_GROUP_ID;
      } else if (groups.length >= MAX_COMMAND_BUTTON_GROUPS) {
        result.droppedBars++;
        result.droppedButtons += bar.buttons.length;
        continue;
      } else {
        target = bar.id;
        groups.push({ id: bar.id, name: uniqueGroupName(bar.name, sourceName, groups) });
      }
      result.added++;
    }
    // A button moved out of an earlier import of this bar keeps its id, so a
    // new copy gets a suffix; it still starts with the bar id for a later replace.
    const taken = new Set(buttons.map((button) => button.id));
    bar.buttons.forEach((button, index) => {
      if (buttons.length >= MAX_COMMAND_BUTTONS) {
        result.droppedButtons++;
        return;
      }
      const base = importedCommandButtonId(bar, index);
      let id = base;
      for (let copy = 2; taken.has(id); copy++) id = `${base}-${copy}`;
      buttons.push({
        id,
        label: button.label,
        command: button.command,
        sendEnter: button.sendEnter,
        ...(target === DEFAULT_COMMAND_GROUP_ID ? {} : { groupId: target }),
      });
    });
  }
  return { commandButtonGroups: groups, commandButtons: buttons, ...result };
}

function uniqueGroupName(
  name: string,
  sourceName: string,
  groups: readonly CommandButtonGroup[],
): string {
  const taken = new Set(groups.map((group) => group.name.trim().toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const base = `${name} (${sourceName})`.slice(0, 80);
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`.toLowerCase())) suffix++;
  return `${base} ${suffix}`;
}
