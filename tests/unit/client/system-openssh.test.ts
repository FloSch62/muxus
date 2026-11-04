import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import { managedHostSupportsSftp } from '../../../client/src/components/sidebar/host-sftp-action.js';
import { environmentHostForManaged, tabRunsCommands } from '../../../client/src/environments.js';
import { fileBrowserUnavailableReason } from '../../../client/src/file-browser.js';
import type { ManagedHost } from '../../../client/src/managed-hosts.js';
import type { TerminalTab } from '../../../client/src/state/tabs.js';
import {
  managedHostUsesSystemOpenSsh,
  tunnelUsesSystemOpenSsh,
} from '../../../client/src/system-openssh.js';
import { canSendBreak, sessionAttached } from '../../../client/src/terminal/send-break.js';
import { canSendTextFile } from '../../../client/src/terminal/send-text-file.js';

const entry = (metadata: Record<string, unknown>) =>
  ({ alias: 'krb', aliases: ['krb', 'krb2'], metadata }) as unknown as SshHostEntry;
const openssh = (metadata: Record<string, unknown>) =>
  ({ kind: 'ssh', entry: entry(metadata) }) as unknown as ManagedHost;
const saved = (metadata: Record<string, unknown>) =>
  ({
    kind: 'saved',
    entry: { id: 'p1', profile: { kind: 'ssh', target: 'krb' }, metadata },
  }) as unknown as ManagedHost;
const tab = (fields: Partial<TerminalTab>) =>
  ({ profile: { kind: 'ssh', target: 'krb' }, status: 'connected', connId: 'c', ...fields }) as TerminalTab;

describe('what a system OpenSSH host cannot do', () => {
  it('recognizes hosts of both kinds', () => {
    expect(managedHostUsesSystemOpenSsh(openssh({ systemOpenSsh: true }))).toBe(true);
    expect(managedHostUsesSystemOpenSsh(saved({ systemOpenSsh: true }))).toBe(true);
    expect(managedHostUsesSystemOpenSsh(openssh({}))).toBe(false);
    expect(managedHostUsesSystemOpenSsh(saved({}))).toBe(false);
  });

  it('cannot send BREAK, but can still type a text file', () => {
    const system = tab({ systemOpenSsh: true });
    expect(canSendBreak(system)).toBe(false);
    expect(sessionAttached(system)).toBe(true);
    expect(canSendTextFile(system)).toBe(true);
    expect(canSendBreak(tab({}))).toBe(true);
  });

  it('greys a tunnel only when it dials the host through its config', () => {
    const hosts = [entry({ systemOpenSsh: true })];
    expect(tunnelUsesSystemOpenSsh({ target: 'krb' }, hosts)).toBe(true);
    expect(tunnelUsesSystemOpenSsh({ target: 'krb2' }, hosts)).toBe(true);
    expect(tunnelUsesSystemOpenSsh({ target: 'other' }, hosts)).toBe(false);
    // A tunnel with its own connection settings does not touch the host's mode.
    expect(tunnelUsesSystemOpenSsh({ target: 'krb', sshOptions: {} }, hosts)).toBe(false);
  });

  it('ignores console compatibility, which only shapes the built-in client', () => {
    const compat = { consoleCompatibility: true };
    expect(managedHostSupportsSftp(openssh(compat))).toBe(false);
    expect(managedHostSupportsSftp(openssh({ ...compat, systemOpenSsh: true }))).toBe(true);
    expect(managedHostSupportsSftp(saved(compat))).toBe(false);
    expect(managedHostSupportsSftp(saved({ ...compat, systemOpenSsh: true }))).toBe(true);
    expect(managedHostSupportsSftp(openssh({ disableSftp: true, systemOpenSsh: true }))).toBe(false);
  });

  it('runs commands only where the login is shared', () => {
    expect(tabRunsCommands({ systemOpenSsh: true, sftpAvailable: true })).toBe(true);
    expect(tabRunsCommands({ systemOpenSsh: true, sftpAvailable: false })).toBe(false);
    // Plain SSH tabs keep their own reasons for having no SFTP.
    expect(tabRunsCommands({ sftpAvailable: false })).toBe(true);
  });

  it('passes the mode on to the containers panel', () => {
    expect(environmentHostForManaged(openssh({ systemOpenSsh: true }))?.systemOpenSsh).toBe(true);
    expect(environmentHostForManaged(saved({ systemOpenSsh: true }))?.systemOpenSsh).toBe(true);
  });

  it('explains the missing file browser', () => {
    expect(fileBrowserUnavailableReason(tab({ sftpAvailable: false, systemOpenSsh: true }))).toContain(
      'system OpenSSH',
    );
    expect(fileBrowserUnavailableReason(tab({ sftpAvailable: false }))).toBe(
      'SFTP is turned off for this host.',
    );
  });
});
