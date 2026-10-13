import { describe, expect, it } from 'vitest';
import { mergeImportedCommandBars } from '../../../client/src/command-button-import.js';
import {
  DEFAULT_COMMAND_GROUP,
  MAX_COMMAND_BUTTON_GROUPS,
  MAX_COMMAND_BUTTONS,
} from '../../../client/src/command-buttons.js';
import type { ImportedCommandBar } from '../../../client/src/session-import.js';
import type { CommandButton, CommandButtonGroup } from '../../../client/src/state/prefs.js';

function sequentialIds(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}-${++next}`;
}

const bar = (id: string, name: string, commands: string[]): ImportedCommandBar => ({
  id,
  name,
  buttons: commands.map((command) => ({ label: command, command, sendEnter: true, warnings: [] })),
  skipped: [],
});

const existingButton: CommandButton = {
  id: 'mine',
  label: 'Mine',
  command: 'uptime',
  sendEnter: true,
};

describe('mergeImportedCommandBars', () => {
  it('adds each bar as a group of its own and renames clashing names', () => {
    const merged = mergeImportedCommandBars(
      { commandButtonGroups: [DEFAULT_COMMAND_GROUP], commandButtons: [existingButton] },
      [bar('bar-a', 'Default', ['show version']), bar('bar-b', 'Junos', ['show bgp summary'])],
      'keep',
      'SecureCRT',
      sequentialIds(),
    );

    expect(merged.commandButtonGroups).toEqual([
      DEFAULT_COMMAND_GROUP,
      { id: 'bar-a', name: 'Default (SecureCRT)' },
      { id: 'bar-b', name: 'Junos' },
    ]);
    expect(merged.commandButtons).toEqual([
      existingButton,
      { id: 'command-1', label: 'show version', command: 'show version', sendEnter: true, groupId: 'bar-a' },
      { id: 'command-2', label: 'show bgp summary', command: 'show bgp summary', sendEnter: true, groupId: 'bar-b' },
    ]);
    expect(merged).toMatchObject({ added: 2, replaced: 0, kept: 0 });
  });

  it('keeps or replaces a bar imported before, without touching other groups', () => {
    const groups: CommandButtonGroup[] = [
      DEFAULT_COMMAND_GROUP,
      { id: 'bar-a', name: 'Renamed by user' },
    ];
    const buttons: CommandButton[] = [
      existingButton,
      { id: 'old', label: 'old', command: 'old', sendEnter: true, groupId: 'bar-a' },
    ];
    const incoming = [bar('bar-a', 'Junos', ['new'])];

    const kept = mergeImportedCommandBars(
      { commandButtonGroups: groups, commandButtons: buttons },
      incoming,
      'keep',
      'SecureCRT',
      sequentialIds(),
    );
    expect(kept.commandButtonGroups).toEqual(groups);
    expect(kept.commandButtons).toEqual(buttons);
    expect(kept.kept).toBe(1);

    const replaced = mergeImportedCommandBars(
      { commandButtonGroups: groups, commandButtons: buttons },
      incoming,
      'replace',
      'SecureCRT',
      sequentialIds(),
    );
    expect(replaced.commandButtonGroups).toEqual(groups);
    expect(replaced.commandButtons).toEqual([
      existingButton,
      { id: 'command-1', label: 'new', command: 'new', sendEnter: true, groupId: 'bar-a' },
    ]);
    expect(replaced.replaced).toBe(1);
  });

  it('stops at the group and button limits and reports what was dropped', () => {
    const fullGroups = Array.from({ length: MAX_COMMAND_BUTTON_GROUPS }, (_, index) =>
      index === 0 ? DEFAULT_COMMAND_GROUP : { id: `g${index}`, name: `Group ${index}` },
    );
    const noRoom = mergeImportedCommandBars(
      { commandButtonGroups: fullGroups, commandButtons: [] },
      [bar('bar-x', 'X', ['a', 'b'])],
      'keep',
      'SecureCRT',
      sequentialIds(),
    );
    expect(noRoom).toMatchObject({ added: 0, droppedBars: 1, droppedButtons: 2 });

    const almostFull = Array.from({ length: MAX_COMMAND_BUTTONS - 1 }, (_, index) => ({
      id: `b${index}`,
      label: '',
      command: 'x',
      sendEnter: true,
    }));
    const oneSlot = mergeImportedCommandBars(
      { commandButtonGroups: [DEFAULT_COMMAND_GROUP], commandButtons: almostFull },
      [bar('bar-y', 'Y', ['a', 'b', 'c'])],
      'keep',
      'SecureCRT',
      sequentialIds(),
    );
    expect(oneSlot.commandButtons).toHaveLength(MAX_COMMAND_BUTTONS);
    expect(oneSlot.droppedButtons).toBe(2);
  });
});
