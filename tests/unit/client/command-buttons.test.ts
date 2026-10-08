import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_GROUP,
  DEFAULT_COMMAND_GROUP_ID,
  activateCommandButton,
  commandButtonGroupOf,
  commandButtonInk,
  commandButtonInput,
  commandButtonsInGroup,
  duplicateCommandButton,
  filterCommandButtons,
  isCommandButtonColor,
  moveCommandButton,
  moveCommandButtonGroup,
  moveCommandButtonToGroup,
  normalizeCommandButtonGroups,
  normalizeCommandButtons,
  shownCommandButtonGroup,
  unusedCommandButtonGroupName,
  withoutCommandButtonGroup,
} from '../../../client/src/command-buttons.js';

const buttons = [
  { id: 'status', label: 'Service status', command: 'systemctl status nginx', sendEnter: true },
  { id: 'disk', label: 'Disk usage', command: 'df -h', sendEnter: true },
  { id: 'restart', label: 'Restart edge', command: 'sudo systemctl restart edge', sendEnter: false },
];

describe('filterCommandButtons', () => {
  it('matches labels and command text case-insensitively', () => {
    expect(filterCommandButtons(buttons, 'DISK')).toEqual([buttons[1]]);
    expect(filterCommandButtons(buttons, 'systemctl')).toEqual([buttons[0], buttons[2]]);
  });

  it('requires every search word and preserves the saved order', () => {
    expect(filterCommandButtons(buttons, 'systemctl edge')).toEqual([buttons[2]]);
    expect(filterCommandButtons(buttons, '   ')).toBe(buttons);
  });
});

describe('commandButtonInput', () => {
  it('appends Enter to commands configured to run immediately', () => {
    expect(
      commandButtonInput({
        id: 'uptime',
        label: 'Uptime',
        command: 'uptime',
        sendEnter: true,
      }),
    ).toBe('uptime\r');
  });

  it('inserts commands without Enter when requested', () => {
    expect(
      commandButtonInput({
        id: 'danger',
        label: 'Review',
        command: 'systemctl restart app',
        sendEnter: false,
      }),
    ).toBe('systemctl restart app');
  });

  it('normalizes multiline commands and does not append a duplicate Enter', () => {
    expect(
      commandButtonInput({
        id: 'multi',
        label: 'Multi',
        command: 'one\ntwo\n',
        sendEnter: true,
      }),
    ).toBe('one\rtwo\r');
  });
});

describe('activateCommandButton', () => {
  it('returns focus to the terminal after sending the command', () => {
    const events: string[] = [];

    const sent = activateCommandButton(
      {
        sendInput: (input) => {
          expect(input).toBe('uptime\r');
          events.push('send');
          return true;
        },
        focus: () => events.push('focus'),
      },
      {
        id: 'uptime',
        label: 'Uptime',
        command: 'uptime',
        sendEnter: true,
      },
    );

    expect(sent).toBe(true);
    expect(events).toEqual(['send', 'focus']);
  });
});

const juniper = { id: 'juniper', name: 'Juniper' };
const huawei = { id: 'huawei', name: 'Huawei' };
const groups = [DEFAULT_COMMAND_GROUP, juniper, huawei];
const filed = [
  { id: 'uptime', label: 'Uptime', command: 'uptime', sendEnter: true },
  { id: 'j-bgp', label: 'BGP', command: 'show bgp summary', sendEnter: true, groupId: 'juniper' },
  { id: 'h-cur', label: 'Config', command: 'display current-configuration', sendEnter: true, groupId: 'huawei' },
  { id: 'j-int', label: 'Interfaces', command: 'show interfaces terse', sendEnter: true, groupId: 'juniper' },
  { id: 'disk', label: 'Disk', command: 'df -h', sendEnter: true },
];
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

describe('normalizeCommandButtonGroups', () => {
  it('keeps the default group first and exactly once', () => {
    expect(normalizeCommandButtonGroups([juniper, { id: 'default', name: 'General' }, huawei])).toEqual([
      { id: 'default', name: 'General' },
      juniper,
      huawei,
    ]);
    expect(normalizeCommandButtonGroups([juniper])).toEqual([DEFAULT_COMMAND_GROUP, juniper]);
    expect(normalizeCommandButtonGroups([])).toEqual([DEFAULT_COMMAND_GROUP]);
  });

  it('drops malformed and duplicate groups and names blank ones', () => {
    expect(
      normalizeCommandButtonGroups([
        juniper,
        { id: 'juniper', name: 'Again' },
        { id: '', name: 'No id' },
        { id: 'nameless' },
        'Cisco',
        { id: 'blank', name: '   ' },
      ]),
    ).toEqual([DEFAULT_COMMAND_GROUP, juniper, { id: 'blank', name: 'Untitled group' }]);
    expect(normalizeCommandButtonGroups({ default: 'Default' })).toBeUndefined();
  });
});

describe('normalizeCommandButtons', () => {
  it('keeps buttons saved before groups and colors existed unchanged', () => {
    expect(normalizeCommandButtons(buttons, [DEFAULT_COMMAND_GROUP])).toEqual(buttons);
  });

  it('clears unknown colors and groups that no longer exist', () => {
    expect(
      normalizeCommandButtons(
        [
          { ...buttons[0], color: 'red', groupId: 'juniper' },
          { ...buttons[1], color: 'chartreuse', groupId: 'deleted' },
          { ...buttons[2], groupId: 'default' },
        ],
        groups,
      ),
    ).toEqual([
      { ...buttons[0], color: 'red', groupId: 'juniper' },
      buttons[1],
      buttons[2],
    ]);
  });

  it('drops malformed and duplicate entries rather than every button', () => {
    expect(
      normalizeCommandButtons(
        [buttons[0], buttons[0], { id: 'x', label: 1, command: '' }, null, { ...buttons[1], sendEnter: undefined }],
        groups,
      ),
    ).toEqual([buttons[0], buttons[1]]);
    expect(normalizeCommandButtons('uptime', groups)).toBeUndefined();
  });
});

describe('command button groups', () => {
  it('files unfiled buttons and buttons of deleted groups under the default group', () => {
    expect(commandButtonGroupOf(filed[0]!, groups)).toBe(DEFAULT_COMMAND_GROUP_ID);
    expect(commandButtonGroupOf({ ...filed[0]!, groupId: 'gone' }, groups)).toBe(DEFAULT_COMMAND_GROUP_ID);
    expect(ids(commandButtonsInGroup(filed, groups, 'juniper'))).toEqual(['j-bgp', 'j-int']);
    expect(ids(commandButtonsInGroup(filed, groups, DEFAULT_COMMAND_GROUP_ID))).toEqual(['uptime', 'disk']);
  });

  it('reorders a button among its own group without moving the others', () => {
    expect(ids(moveCommandButton(filed, groups, 'j-int', -1))).toEqual([
      'uptime',
      'j-int',
      'h-cur',
      'j-bgp',
      'disk',
    ]);
    expect(ids(moveCommandButton(filed, groups, 'disk', -1))).toEqual([
      'disk',
      'j-bgp',
      'h-cur',
      'j-int',
      'uptime',
    ]);
    expect(ids(moveCommandButton(filed, groups, 'j-int', 1))).toEqual(ids(filed));
  });

  it('moves a button after the last button of its new group', () => {
    const moved = moveCommandButtonToGroup(filed, groups, 'uptime', 'juniper');
    expect(ids(moved)).toEqual(['j-bgp', 'h-cur', 'j-int', 'uptime', 'disk']);
    expect(moved[3]).toMatchObject({ id: 'uptime', groupId: 'juniper' });
    const back = moveCommandButtonToGroup(moved, groups, 'j-bgp', DEFAULT_COMMAND_GROUP_ID);
    expect(back.find((button) => button.id === 'j-bgp')).not.toHaveProperty('groupId');
    expect(ids(back)).toEqual(['h-cur', 'j-int', 'uptime', 'disk', 'j-bgp']);
  });

  it('duplicates a button right below the original, in the same group and color', () => {
    const copied = duplicateCommandButton(
      filed.map((button) => (button.id === 'j-bgp' ? { ...button, color: 'purple' as const } : button)),
      'j-bgp',
      'copy',
    );
    expect(ids(copied)).toEqual(['uptime', 'j-bgp', 'copy', 'h-cur', 'j-int', 'disk']);
    expect(copied[2]).toEqual({
      id: 'copy',
      label: 'BGP copy',
      command: 'show bgp summary',
      sendEnter: true,
      groupId: 'juniper',
      color: 'purple',
    });
  });

  it('never moves a group above the default group', () => {
    expect(ids(moveCommandButtonGroup(groups, 'huawei', -1))).toEqual(['default', 'huawei', 'juniper']);
    expect(ids(moveCommandButtonGroup(groups, 'juniper', -1))).toEqual(ids(groups));
    expect(ids(moveCommandButtonGroup(groups, 'default', 1))).toEqual(ids(groups));
  });

  it('deletes a group with its buttons and keeps the default group', () => {
    expect(withoutCommandButtonGroup(filed, groups, 'juniper')).toEqual({
      commandButtons: [filed[0], filed[2], filed[4]],
      commandButtonGroups: [DEFAULT_COMMAND_GROUP, huawei],
    });
    expect(withoutCommandButtonGroup(filed, groups, DEFAULT_COMMAND_GROUP_ID)).toEqual({
      commandButtons: filed,
      commandButtonGroups: groups,
    });
  });

  it('names new groups without repeating a name', () => {
    expect(unusedCommandButtonGroupName(groups)).toBe('New group');
    expect(
      unusedCommandButtonGroupName([...groups, { id: 'a', name: 'New group' }, { id: 'b', name: 'new group 2' }]),
    ).toBe('New group 3');
  });
});

describe('shownCommandButtonGroup', () => {
  it('prefers the session choice, then the host group, then the selected group', () => {
    expect(shownCommandButtonGroup(groups, { session: 'huawei', host: 'juniper', selected: 'default' })).toBe('huawei');
    expect(shownCommandButtonGroup(groups, { host: 'juniper', selected: 'huawei' })).toBe('juniper');
    expect(shownCommandButtonGroup(groups, { selected: 'huawei' })).toBe('huawei');
    expect(shownCommandButtonGroup(groups, {})).toBe(DEFAULT_COMMAND_GROUP_ID);
  });

  it('skips groups that were deleted', () => {
    expect(shownCommandButtonGroup(groups, { host: 'cisco', selected: 'huawei' })).toBe('huawei');
    expect(shownCommandButtonGroup(groups, { selected: 'cisco' })).toBe(DEFAULT_COMMAND_GROUP_ID);
  });
});

describe('command button colors', () => {
  it('uses a darker ink on light bars and a lighter one on dark bars', () => {
    expect(commandButtonInk('red', 'light')).toBe('#b91c1c');
    expect(commandButtonInk('red', 'dark')).toBe('#f87171');
    expect(isCommandButtonColor('gray')).toBe(true);
    expect(isCommandButtonColor('#ff0000')).toBe(false);
  });
});
