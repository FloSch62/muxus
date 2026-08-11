import { describe, expect, it } from 'vitest';
import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';
import {
  editableManagedHostForProfile,
  groupManagedHosts,
  managedHostCopyCommand,
  managedHostKey,
  managedHostRef,
} from '../../../client/src/managed-hosts.js';
import { managedHostSupportsSftp } from '../../../client/src/components/sidebar/host-sftp-action.js';

const ROOT = '/home/test/.ssh/config';

function sshHost(alias: string, group?: string): SshHostEntry {
  return {
    alias,
    aliases: [alias],
    file: ROOT,
    options: {},
    resolved: {
      hostname: `${alias}.example.test`,
      port: 22,
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump: [],
      forwards: [],
      passwordOnly: false,
    },
    metadata: group
      ? {
          profileId: `ssh-${alias}`,
          group,
          connectCount: 0,
        }
      : undefined,
  };
}

function telnetHost(name: string, group?: string): SavedHostProfile {
  return {
    id: `telnet-${name}`,
    kind: 'telnet',
    name,
    profile: {
      kind: 'telnet',
      profileId: `telnet-${name}`,
      host: `${name}.example.test`,
      port: 23,
    },
    metadata: {
      profileId: `telnet-${name}`,
      group,
      connectCount: 0,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function serialHost(name: string): SavedHostProfile {
  return {
    id: `serial-${name}`,
    kind: 'serial',
    name,
    profile: {
      kind: 'serial',
      profileId: `serial-${name}`,
      path: 'COM3',
      baudRate: 115_200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    },
    metadata: {
      profileId: `serial-${name}`,
      connectCount: 0,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function nativeSshHost(name: string): SavedHostProfile {
  return {
    id: `native-ssh-${name}`,
    kind: 'ssh',
    name,
    profile: {
      kind: 'ssh',
      profileId: `native-ssh-${name}`,
      target: `${name}.example.test`,
      useConfig: false,
      user: 'admin',
      port: 2222,
    },
    metadata: {
      profileId: `native-ssh-${name}`,
      connectCount: 0,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('managed host groups', () => {
  it('places ungrouped SSH, Telnet, and serial profiles in one Hosts group', () => {
    const groups = groupManagedHosts(
      [sshHost('router')],
      [telnetHost('console'), serialHost('rack console')],
      [ROOT],
      ROOT,
    );

    expect(groups.map((group) => group.label)).toEqual(['Hosts']);
    expect(
      groups[0]?.hosts.map((host) =>
        host.kind === 'profile' ? `profile:${host.entry.kind}` : 'ssh:ssh',
      ),
    ).toEqual(['profile:telnet', 'profile:serial', 'ssh:ssh']);
  });

  it('merges profiles and SSH entries that use the same custom group', () => {
    const groups = groupManagedHosts(
      [sshHost('router', 'Production'), sshHost('lab')],
      [telnetHost('console', 'production')],
      [ROOT],
      ROOT,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Production',
      'Ungrouped',
    ]);
    expect(groups[0]?.hosts.map((host) => host.kind)).toEqual([
      'profile',
      'ssh',
    ]);
  });
});

describe('managed host identity and clipboard actions', () => {
  const ssh = { kind: 'ssh' as const, entry: sshHost('router') };
  const nativeSsh = { kind: 'profile' as const, entry: nativeSshHost('core') };
  const telnet = { kind: 'profile' as const, entry: telnetHost('console') };
  const serial = { kind: 'profile' as const, entry: serialHost('rack') };

  it('resolves the persisted host behind a session profile for editing', () => {
    expect(
      editableManagedHostForProfile(
        { kind: 'ssh', target: 'router' },
        [ssh.entry],
        [nativeSsh.entry, telnet.entry],
      ),
    ).toEqual(ssh);
    expect(
      editableManagedHostForProfile(
        { ...telnet.entry.profile, profileId: telnet.entry.id },
        [ssh.entry],
        [nativeSsh.entry, telnet.entry],
      ),
    ).toEqual(telnet);
    expect(
      editableManagedHostForProfile(
        { kind: 'ssh', target: 'unlisted.example.test' },
        [ssh.entry],
        [nativeSsh.entry],
      ),
    ).toBeUndefined();
    expect(
      editableManagedHostForProfile(
        { kind: 'ssh', target: 'router', useConfig: false },
        [ssh.entry],
        [],
      ),
    ).toBeUndefined();
    expect(
      editableManagedHostForProfile({ kind: 'local' }, [ssh.entry], [nativeSsh.entry]),
    ).toBeUndefined();
  });

  it('derives stable keys matching the reorder refs', () => {
    expect(managedHostKey(ssh)).toBe('ssh:router');
    expect(managedHostKey(telnet)).toBe('profile:telnet-console');
    expect(managedHostRef(ssh)).toEqual({ kind: 'ssh', alias: 'router' });
    expect(managedHostRef(serial)).toEqual({ kind: 'profile', id: 'serial-rack' });
  });

  it('offers a per-kind copy command', () => {
    expect(managedHostCopyCommand(ssh)).toEqual({
      label: 'Copy ssh command',
      text: 'ssh router',
    });
    expect(managedHostCopyCommand(telnet)).toEqual({
      label: 'Copy telnet command',
      text: 'telnet console.example.test 23',
    });
    expect(managedHostCopyCommand(serial)).toEqual({
      label: 'Copy device path',
      text: 'COM3',
    });
    expect(managedHostCopyCommand(nativeSsh)).toEqual({
      label: 'Copy ssh command',
      text: 'ssh -p 2222 admin@core.example.test',
    });

    const routed = {
      ...nativeSsh,
      entry: {
        ...nativeSsh.entry,
        profile: {
          ...nativeSsh.entry.profile,
          identityFiles: ['~/.ssh/core key'],
          certificateFiles: ['~/.ssh/core-cert.pub'],
          identitiesOnly: true,
          identityAgent: 'none',
          forwardAgent: true,
          proxyJump: ['bastion', 'ops@jump.example.test:2200'],
          passwordOnly: true,
          forwards: [
            {
              type: 'local' as const,
              bindPort: 8080,
              targetHost: '127.0.0.1',
              targetPort: 80,
            },
          ],
          requestTty: 'force' as const,
          strictHostKeyChecking: 'accept-new' as const,
          remoteCommand: 'tmux new -A -s main',
        },
      },
    };
    expect(managedHostCopyCommand(routed).text).toBe(
      "ssh -p 2222 -i '~/.ssh/core key' -o CertificateFile=~/.ssh/core-cert.pub " +
        '-o IdentitiesOnly=yes -o IdentityAgent=none -A ' +
        '-J bastion,ops@jump.example.test:2200 -o PubkeyAuthentication=no ' +
        '-o PreferredAuthentications=keyboard-interactive,password ' +
        '-L 8080:127.0.0.1:80 -tt -o StrictHostKeyChecking=accept-new ' +
        "admin@core.example.test 'tmux new -A -s main'",
    );

    const proxied = {
      ...nativeSsh,
      entry: {
        ...nativeSsh.entry,
        profile: {
          ...nativeSsh.entry.profile,
          proxyCommand: 'cloudflared access ssh --hostname %h',
        },
      },
    };
    expect(managedHostCopyCommand(proxied).text).toBe(
      "ssh -p 2222 -o 'ProxyCommand=cloudflared access ssh --hostname %h' " +
        'admin@core.example.test',
    );
  });

  it('offers SFTP only for SSH hosts where it is not explicitly disabled', () => {
    const disabled = sshHost('console');
    disabled.metadata = {
      profileId: 'ssh-console',
      connectCount: 0,
      disableSftp: true,
    };

    expect(managedHostSupportsSftp(ssh)).toBe(true);
    expect(managedHostSupportsSftp(nativeSsh)).toBe(true);
    expect(managedHostSupportsSftp({ kind: 'ssh', entry: disabled })).toBe(false);

    const consoleCompatible = sshHost('console-compatible');
    consoleCompatible.metadata = {
      profileId: 'ssh-console-compatible',
      connectCount: 0,
      consoleCompatibility: true,
    };
    expect(managedHostSupportsSftp({ kind: 'ssh', entry: consoleCompatible })).toBe(false);
    expect(
      managedHostSupportsSftp({
        ...nativeSsh,
        entry: {
          ...nativeSsh.entry,
          metadata: { ...nativeSsh.entry.metadata, disableSftp: true },
        },
      }),
    ).toBe(false);
    expect(managedHostSupportsSftp(telnet)).toBe(false);
    expect(managedHostSupportsSftp(serial)).toBe(false);
  });
});
