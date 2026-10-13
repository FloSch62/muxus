import { describe, expect, it } from 'vitest';
import {
  importedCommandBarGroup,
  importedCommandButtonId,
  mergeImportedCommandBars,
} from '../../../client/src/command-button-import.js';
import {
  DEFAULT_COMMAND_GROUP,
  MAX_COMMAND_BUTTON_GROUPS,
  MAX_COMMAND_BUTTONS,
} from '../../../client/src/command-buttons.js';
import type { ImportedCommandBar } from '../../../client/src/session-import.js';
import type { CommandButton, CommandButtonGroup } from '../../../client/src/state/prefs.js';

const bar = (
  id: string,
  name: string,
  commands: string[],
  isDefault = false,
): ImportedCommandBar => ({
  id,
  name,
  ...(isDefault ? { isDefault: true } : {}),
  buttons: commands.map((command) => ({ label: command, command, sendEnter: true, warnings: [] })),
  skipped: [],
});

const imported = (barId: string, index: number, command: string, groupId?: string) => ({
  id: `${barId}/button-${index}`,
  label: command,
  command,
  sendEnter: true,
  ...(groupId ? { groupId } : {}),
});

const mine: CommandButton = { id: 'mine', label: 'Mine', command: 'uptime', sendEnter: true };
const onlyDefault = [DEFAULT_COMMAND_GROUP];

describe('mergeImportedCommandBars', () => {
  it('fills an empty Default group with the source default bar', () => {
    const defaultBar = bar('bar-d', 'Default', ['show version'], true);
    const merged = mergeImportedCommandBars(
      { commandButtonGroups: onlyDefault, commandButtons: [] },
      [defaultBar, bar('bar-j', 'Junos', ['show bgp summary'])],
      'keep',
      'SecureCRT',
    );

    expect(merged.commandButtonGroups).toEqual([
      DEFAULT_COMMAND_GROUP,
      { id: 'bar-j', name: 'Junos' },
    ]);
    expect(merged.commandButtons).toEqual([
      imported('bar-d', 0, 'show version'),
      imported('bar-j', 0, 'show bgp summary', 'bar-j'),
    ]);
    expect(merged).toMatchObject({ added: 2, replaced: 0, kept: 0 });
    expect(importedCommandBarGroup(defaultBar, merged)).toBe('default');
    expect(importedCommandButtonId(defaultBar, 3)).toBe('bar-d/button-3');
  });

  it('gives the default bar its own renamed group when Default has the user’s buttons', () => {
    const merged = mergeImportedCommandBars(
      { commandButtonGroups: onlyDefault, commandButtons: [mine] },
      [bar('bar-d', 'Default', ['show version'], true)],
      'keep',
      'SecureCRT',
    );

    expect(merged.commandButtonGroups).toEqual([
      DEFAULT_COMMAND_GROUP,
      { id: 'bar-d', name: 'Default (SecureCRT)' },
    ]);
    expect(merged.commandButtons).toEqual([mine, imported('bar-d', 0, 'show version', 'bar-d')]);
  });

  it('keeps or replaces a default bar imported before, leaving buttons added since', () => {
    const defaultBar = bar('bar-d', 'Default', ['new'], true);
    const buttons = [imported('bar-d', 0, 'old'), mine];
    const state = { commandButtonGroups: onlyDefault, commandButtons: buttons };

    const kept = mergeImportedCommandBars(state, [defaultBar], 'keep', 'SecureCRT');
    expect(kept.commandButtons).toEqual(buttons);
    expect(kept.kept).toBe(1);

    const replaced = mergeImportedCommandBars(state, [defaultBar], 'replace', 'SecureCRT');
    expect(replaced.commandButtonGroups).toEqual(onlyDefault);
    expect(replaced.commandButtons).toEqual([mine, imported('bar-d', 0, 'new')]);
    expect(replaced.replaced).toBe(1);
  });

  it('keeps or replaces a bar imported as its own group, without touching other groups', () => {
    const groups: CommandButtonGroup[] = [
      DEFAULT_COMMAND_GROUP,
      { id: 'bar-a', name: 'Renamed by user' },
    ];
    const buttons: CommandButton[] = [
      mine,
      { id: 'legacy', label: 'old', command: 'old', sendEnter: true, groupId: 'bar-a' },
    ];
    const incoming = [bar('bar-a', 'Junos', ['new'])];

    const kept = mergeImportedCommandBars(
      { commandButtonGroups: groups, commandButtons: buttons },
      incoming,
      'keep',
      'SecureCRT',
    );
    expect(kept.commandButtonGroups).toEqual(groups);
    expect(kept.commandButtons).toEqual(buttons);
    expect(kept.kept).toBe(1);

    const replaced = mergeImportedCommandBars(
      { commandButtonGroups: groups, commandButtons: buttons },
      incoming,
      'replace',
      'SecureCRT',
    );
    expect(replaced.commandButtonGroups).toEqual(groups);
    expect(replaced.commandButtons).toEqual([mine, imported('bar-a', 0, 'new', 'bar-a')]);
    expect(replaced.replaced).toBe(1);
  });

  it('gives a re-imported bar new ids when a button of the earlier import was moved away', () => {
    const groups: CommandButtonGroup[] = [DEFAULT_COMMAND_GROUP, { id: 'ops', name: 'Ops' }];
    // The bar's group was deleted after its first button was moved to Ops.
    const moved = imported('bar-j', 0, 'show bgp summary', 'ops');
    const merged = mergeImportedCommandBars(
      { commandButtonGroups: groups, commandButtons: [moved] },
      [bar('bar-j', 'Junos', ['show bgp summary', 'show route'])],
      'keep',
      'SecureCRT',
    );

    expect(merged.commandButtons).toEqual([
      moved,
      { ...imported('bar-j', 0, 'show bgp summary', 'bar-j'), id: 'bar-j/button-0-2' },
      imported('bar-j', 1, 'show route', 'bar-j'),
    ]);
    expect(merged).toMatchObject({ added: 1, kept: 0 });

    const replaced = mergeImportedCommandBars(
      merged,
      [bar('bar-j', 'Junos', ['show version'])],
      'replace',
      'SecureCRT',
    );
    expect(replaced.commandButtons).toEqual([imported('bar-j', 0, 'show version', 'bar-j')]);
  });

  it('renames other clashing groups and reports bars that were never imported', () => {
    const merged = mergeImportedCommandBars(
      { commandButtonGroups: [...onlyDefault, { id: 'g', name: 'Junos' }], commandButtons: [] },
      [bar('bar-j', 'Junos', ['a'])],
      'keep',
      'SecureCRT',
    );
    expect(merged.commandButtonGroups.at(-1)).toEqual({ id: 'bar-j', name: 'Junos (SecureCRT)' });
    expect(
      importedCommandBarGroup(bar('bar-x', 'X', []), { commandButtonGroups: onlyDefault, commandButtons: [] }),
    ).toBeUndefined();
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
    );
    expect(noRoom).toMatchObject({ added: 0, droppedBars: 1, droppedButtons: 2 });

    const almostFull = Array.from({ length: MAX_COMMAND_BUTTONS - 1 }, (_, index) => ({
      id: `b${index}`,
      label: '',
      command: 'x',
      sendEnter: true,
      groupId: 'g1',
    }));
    const oneSlot = mergeImportedCommandBars(
      { commandButtonGroups: [...onlyDefault, { id: 'g1', name: 'G' }], commandButtons: almostFull },
      [bar('bar-y', 'Y', ['a', 'b', 'c'])],
      'keep',
      'SecureCRT',
    );
    expect(oneSlot.commandButtons).toHaveLength(MAX_COMMAND_BUTTONS);
    expect(oneSlot.droppedButtons).toBe(2);
  });
});
