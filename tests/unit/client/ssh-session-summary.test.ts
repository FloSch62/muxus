import { describe, expect, it } from 'vitest';
import type { SshSessionSummary } from '@muxus/shared';
import { formatSshSessionSummary } from '../../../client/src/terminal/ssh-session-summary.js';

const summary: SshSessionSummary = {
  user: 'admin',
  host: '100.124.182.28',
  port: 22,
  jumpHosts: [],
  proxyCommand: false,
  shared: false,
  serverSoftware: 'OpenSSH_9.6p1',
  authMethods: ['agent'],
  cipher: 'chacha20-poly1305@openssh.com',
  kex: 'curve25519-sha256',
  compression: 'off',
  sftp: true,
  x11: 'off',
  agentForwarding: 'off',
  forwards: [],
};

/** The summary as it reads on screen, one entry per line. */
function lines(value: SshSessionSummary): string[] {
  const text = formatSshSessionSummary(value);
  expect(text.endsWith('\r\n')).toBe(true);
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').split('\r\n').slice(0, -1);
}

describe('SSH session summary', () => {
  it('lists the route, server, login, encryption and feature state', () => {
    expect(lines(summary)).toEqual([
      '➤ SSH session to admin@100.124.182.28',
      '  • Route            : direct',
      '  • Server           : OpenSSH_9.6p1',
      '  • Authentication   : public key (SSH agent)',
      '  • Encryption       : chacha20-poly1305@openssh.com  (curve25519-sha256)',
      '  • Compression      : ✘  (disabled)',
      '  • SFTP browser     : ✔',
      '  • X11 forwarding   : ✘  (disabled)',
      '  • Agent forwarding : ✘  (disabled)',
    ]);
  });

  it('marks active features and colors the marks', () => {
    const active: SshSessionSummary = {
      ...summary,
      compression: 'on',
      x11: 'on',
      agentForwarding: 'on',
    };
    expect(lines(active)).toEqual(
      expect.arrayContaining([
        '  • Compression      : ✔',
        '  • X11 forwarding   : ✔',
        '  • Agent forwarding : ✔',
      ]),
    );
    expect(formatSshSessionSummary(active)).toContain('\x1b[32m✔\x1b[0m');
    expect(formatSshSessionSummary(summary)).toContain('\x1b[31m✘\x1b[0m');
  });

  it('explains why a requested feature is off', () => {
    const text = lines({
      ...summary,
      compression: 'unsupported',
      sftp: false,
      x11: 'refused',
      agentForwarding: 'no-agent',
    });
    expect(text).toEqual(
      expect.arrayContaining([
        '  • Compression      : ✘  (not supported by the server)',
        '  • SFTP browser     : ✘  (disabled for this host)',
        '  • X11 forwarding   : ✘  (refused by the server)',
        '  • Agent forwarding : ✘  (no SSH agent available)',
      ]),
    );
    expect(lines({ ...summary, x11: 'no-server' })).toContain(
      '  • X11 forwarding   : ✘  (no local X server)',
    );
  });

  it('shows jump hosts, ProxyCommand and a reused connection on the route', () => {
    expect(lines({ ...summary, jumpHosts: ['bastion', 'inner'] })[1]).toBe(
      '  • Route            : via bastion → inner',
    );
    expect(lines({ ...summary, jumpHosts: ['bastion'], proxyCommand: true })[1]).toBe(
      '  • Route            : via bastion (ProxyCommand)',
    );
    expect(lines({ ...summary, proxyCommand: true, shared: true })[1]).toBe(
      '  • Route            : via ProxyCommand  (reusing an open connection)',
    );
  });

  it('adds a non-default port to the target, bracketing IPv6 addresses', () => {
    expect(lines({ ...summary, port: 2222 })[0]).toBe('➤ SSH session to admin@100.124.182.28:2222');
    expect(lines({ ...summary, host: 'fd00::5', port: 2222 })[0]).toBe(
      '➤ SSH session to admin@[fd00::5]:2222',
    );
    expect(lines({ ...summary, host: 'fd00::5' })[0]).toBe('➤ SSH session to admin@fd00::5');
  });

  it('joins the methods of a multi-factor login', () => {
    expect(lines({ ...summary, authMethods: ['publickey', 'keyboard-interactive'] })).toContain(
      '  • Authentication   : public key + keyboard-interactive',
    );
  });

  it('leaves out what the server did not report', () => {
    const text = lines({
      ...summary,
      serverSoftware: undefined,
      authMethods: [],
      cipher: undefined,
      kex: undefined,
    });
    expect(text.some((line) => /Server|Authentication|Encryption/.test(line))).toBe(false);
  });

  it('lists running port forwards in ssh option form and counts the rest', () => {
    expect(
      lines({
        ...summary,
        forwards: [
          { type: 'local', bindPort: 8080, targetHost: 'db', targetPort: 5432 },
          { type: 'remote', bindPort: 9000, targetHost: '::1', targetPort: 3000 },
          { type: 'dynamic', bindPort: 1080 },
        ],
      }).at(-1),
    ).toBe('  • Port forwards    : -L 8080:db:5432, -R 9000:[::1]:3000, -D 1080');

    const many = Array.from({ length: 6 }, (_, index) => ({
      type: 'dynamic' as const,
      bindPort: 1080 + index,
    }));
    expect(lines({ ...summary, forwards: many }).at(-1)).toBe(
      '  • Port forwards    : -D 1080, -D 1081, -D 1082, -D 1083  (+2 more)',
    );
  });
});
