import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PasswordVaultStatus } from '@muxus/shared';
import { ApiError } from '../../../client/src/api/http.js';
import { sendVaultSecret } from '../../../client/src/api/password-vault.js';
import { useDialogStore } from '../../../client/src/state/dialogs.js';
import { multiExecMirrorTabIds, useMultiExecStore } from '../../../client/src/state/multi-exec.js';
import type { CommandButton } from '../../../client/src/state/prefs.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useToastStore } from '../../../client/src/state/toast.js';
import {
  registerTerminal,
  type TerminalHandle,
} from '../../../client/src/terminal/terminal-registry.js';
import { sendSecretToTab } from '../../../client/src/vault-secret-send.js';
import {
  commandButtonsUsingSecret,
  filterVaultSecrets,
  findVaultSecret,
  runCommandButton,
  secretTerminalIds,
  vaultSecretMissing,
} from '../../../client/src/vault-secrets.js';

vi.mock('../../../client/src/api/password-vault.js', () => ({ sendVaultSecret: vi.fn() }));
const sendMock = vi.mocked(sendVaultSecret);

const secrets = [
  { id: 's1', name: 'Core enable', createdAt: '', updatedAt: '' },
  { id: 's2', name: 'Lab sudo', username: 'admin', createdAt: '', updatedAt: '' },
];
const status = { secrets } as unknown as PasswordVaultStatus;

function handle() {
  const focus = vi.fn();
  const sendInput = vi.fn(() => true);
  return { focus, sendInput, terminal: { focus, sendInput } as unknown as TerminalHandle };
}

/** A connected terminal tab whose backend session has `terminalId`. */
function connectTab(title: string, terminalId: string): string {
  const id = useTabsStore.getState().open({ kind: 'local' }, title);
  useTabsStore.getState().update(id, { status: 'connected', terminalId });
  return id;
}

beforeEach(() => {
  sendMock.mockReset();
  useMultiExecStore.setState({ selectedIds: [], lastMirroredIds: [], groups: [] });
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
  });
  useToastStore.setState({ toast: null });
  useDialogStore.setState({ queue: [] });
});

describe('secret references', () => {
  it('reports a secret as missing only once the vault status is known', () => {
    expect(findVaultSecret(status, 's2')?.name).toBe('Lab sudo');
    expect(vaultSecretMissing(undefined, 's1')).toBeUndefined();
    expect(vaultSecretMissing(status, 's1')).toBe(false);
    expect(vaultSecretMissing(status, 'deleted')).toBe(true);
  });

  it('finds the saved commands that still type a secret', () => {
    const buttons: CommandButton[] = [
      { id: 'a', label: 'Enable', command: '', sendEnter: true, secretId: 's1' },
      { id: 'b', label: 'Status', command: 'show version', sendEnter: true },
      { id: 'c', label: 'Enable again', command: '', sendEnter: false, secretId: 's1' },
    ];
    expect(commandButtonsUsingSecret(buttons, 's1').map((button) => button.id)).toEqual(['a', 'c']);
    expect(commandButtonsUsingSecret(buttons, 's2')).toEqual([]);
  });

  it('searches secrets by name and user name', () => {
    expect(filterVaultSecrets(secrets, 'ADMIN')).toEqual([secrets[1]]);
    expect(filterVaultSecrets(secrets, 'core enable')).toEqual([secrets[0]]);
    expect(filterVaultSecrets(secrets, ' ')).toBe(secrets);
  });
});

describe('where a secret is typed', () => {
  it('goes to the focused session and the connected sessions mirroring it', () => {
    const first = connectTab('one', 'terminal-1');
    const second = connectTab('two', 'terminal-2');
    const third = connectTab('three', 'terminal-3');
    useTabsStore.getState().update(third, { status: 'closed' });
    const tabs = useTabsStore.getState().tabs;

    expect(secretTerminalIds(first, tabs, [])).toEqual(['terminal-1']);
    expect(secretTerminalIds(first, tabs, [second, third, 'gone'])).toEqual([
      'terminal-1',
      'terminal-2',
    ]);
    // Nothing is typed anywhere when the focused session itself is not connected.
    expect(secretTerminalIds(third, tabs, [first, second])).toEqual([]);

    useMultiExecStore.getState().setSelection([first, second]);
    expect(multiExecMirrorTabIds(first)).toEqual([second]);
    expect(multiExecMirrorTabIds(third)).toEqual([]);
  });
});

describe('sending a secret', () => {
  it('sends only the reference, mirrored like typed input', async () => {
    const first = connectTab('one', 'terminal-1');
    const second = connectTab('two', 'terminal-2');
    useMultiExecStore.getState().setSelection([first, second]);
    sendMock.mockResolvedValue({ sent: 2 });

    await expect(sendSecretToTab(first, { id: 's1', name: 'Core enable' }, true)).resolves.toBe(true);
    expect(sendMock).toHaveBeenCalledExactlyOnceWith('s1', {
      terminalIds: ['terminal-1', 'terminal-2'],
      enter: true,
    });
  });

  it('asks for the master password while the vault is locked, again when it is wrong', async () => {
    const tab = connectTab('one', 'terminal-1');
    sendMock
      .mockRejectedValueOnce(new ApiError(423, 'locked', { message: 'locked', code: 'vault-locked' }))
      .mockRejectedValueOnce(
        new ApiError(401, 'wrong', { message: 'wrong', code: 'invalid-master-password' }),
      )
      .mockResolvedValueOnce({ sent: 1 });

    const sending = sendSecretToTab(tab, { id: 's1', name: 'Core enable' }, false);
    await vi.waitFor(() => expect(useDialogStore.getState().queue).toHaveLength(1));
    expect(useDialogStore.getState().queue[0]).toMatchObject({
      kind: 'prompt',
      masked: true,
      description: 'Enter the master password to send “Core enable”.',
    });
    useDialogStore.getState().resolveHead(' wrong ');
    await vi.waitFor(() => expect(useDialogStore.getState().queue).toHaveLength(1));
    expect(useDialogStore.getState().queue[0]).toMatchObject({
      description: 'The master password is incorrect.',
    });
    useDialogStore.getState().resolveHead('master-pass-12');

    await expect(sending).resolves.toBe(true);
    expect(sendMock.mock.calls.map(([, request]) => request.masterPassword)).toEqual([
      undefined,
      ' wrong ',
      'master-pass-12',
    ]);
  });

  it('stops when the prompt is dismissed and reports a deleted secret', async () => {
    const tab = connectTab('one', 'terminal-1');
    sendMock.mockRejectedValueOnce(
      new ApiError(423, 'locked', { message: 'locked', code: 'vault-locked' }),
    );
    const cancelled = sendSecretToTab(tab, { id: 's1', name: 'Core enable' }, true);
    await vi.waitFor(() => expect(useDialogStore.getState().queue).toHaveLength(1));
    useDialogStore.getState().resolveHead(null);
    await expect(cancelled).resolves.toBe(false);
    expect(sendMock).toHaveBeenCalledOnce();

    sendMock.mockRejectedValueOnce(
      new ApiError(404, 'gone', { message: 'gone', code: 'vault-secret-missing' }),
    );
    await expect(sendSecretToTab(tab, { id: 's1', name: 'Core enable' }, true)).resolves.toBe(false);
    expect(useToastStore.getState().toast).toMatchObject({
      severity: 'error',
      message: '“Core enable” is no longer in the password vault.',
    });
  });

  it('runs a secret button through the backend and a text button through the terminal', async () => {
    const tab = connectTab('one', 'terminal-1');
    const { focus, sendInput, terminal } = handle();
    const unregister = registerTerminal(tab, terminal);
    sendMock.mockResolvedValue({ sent: 1 });
    try {
      const text: CommandButton = { id: 't', label: 'Version', command: 'show version', sendEnter: true };
      const secret: CommandButton = { id: 's', label: 'Enable', command: '', sendEnter: true, secretId: 's1' };

      expect(runCommandButton(tab, text)).toBe(true);
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('show version\r');

      expect(runCommandButton(tab, secret, { secretName: 'Core enable' })).toBe(true);
      await vi.waitFor(() =>
        expect(sendMock).toHaveBeenCalledWith('s1', { terminalIds: ['terminal-1'], enter: true }),
      );
      expect(sendInput).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(2));

      useTabsStore.getState().update(tab, { status: 'closed' });
      expect(runCommandButton(tab, secret)).toBe(false);
    } finally {
      unregister();
    }
  });
});
