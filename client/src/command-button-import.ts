import {
  MAX_COMMAND_BUTTON_GROUPS,
  MAX_COMMAND_BUTTONS,
  newPreferenceId,
} from './command-buttons.js';
import type { TransferConflictStrategy } from './data-transfer.js';
import type { ImportedCommandBar } from './session-import.js';
import type { CommandButton, CommandButtonGroup } from './state/prefs.js';

export interface CommandBarMergeResult {
  commandButtonGroups: CommandButtonGroup[];
  commandButtons: CommandButton[];
  /** Groups created, replaced or left as they were. */
  added: number;
  replaced: number;
  kept: number;
  /** Bars or buttons dropped because the group or button limit was reached. */
  droppedBars: number;
  droppedButtons: number;
}

/**
 * Add imported button bars as command button groups. A bar whose group id is
 * already present (an earlier import of the same bar) is kept or replaced as a
 * whole; a new bar whose name is taken by another group gets the source name
 * appended so the two stay distinguishable.
 */
export function mergeImportedCommandBars(
  current: {
    commandButtonGroups: readonly CommandButtonGroup[];
    commandButtons: readonly CommandButton[];
  },
  bars: readonly ImportedCommandBar[],
  conflicts: TransferConflictStrategy,
  sourceName: string,
  newId: (prefix: string) => string = newPreferenceId,
): CommandBarMergeResult {
  const groups = [...current.commandButtonGroups];
  let buttons = [...current.commandButtons];
  const result = { added: 0, replaced: 0, kept: 0, droppedBars: 0, droppedButtons: 0 };

  for (const bar of bars) {
    const existing = groups.findIndex((group) => group.id === bar.id);
    if (existing >= 0 && conflicts === 'keep') {
      result.kept++;
      continue;
    }
    if (existing >= 0) {
      // The group keeps its place and any name the user gave it.
      buttons = buttons.filter((button) => button.groupId !== bar.id);
      result.replaced++;
    } else {
      if (groups.length >= MAX_COMMAND_BUTTON_GROUPS) {
        result.droppedBars++;
        result.droppedButtons += bar.buttons.length;
        continue;
      }
      groups.push({ id: bar.id, name: uniqueGroupName(bar.name, sourceName, groups) });
      result.added++;
    }
    for (const button of bar.buttons) {
      if (buttons.length >= MAX_COMMAND_BUTTONS) {
        result.droppedButtons++;
        continue;
      }
      buttons.push({
        id: newId('command'),
        label: button.label,
        command: button.command,
        sendEnter: button.sendEnter,
        groupId: bar.id,
      });
    }
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
