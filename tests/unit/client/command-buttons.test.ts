import { describe, expect, it } from 'vitest';
import {
  commandButtonInput,
  filterCommandButtons,
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
