import { describe, expect, it } from 'vitest';
import { commandButtonInput } from '../../../client/src/command-buttons.js';

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
