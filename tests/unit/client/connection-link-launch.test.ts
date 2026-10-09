import { describe, expect, it } from 'vitest';
import {
  parseConnectionLink,
  type ConnectionLink,
  type SavedHostProfile,
  type SavedHostSessionProfile,
  type SshHostEntry,
} from '@muxus/shared';
import { resolveConnectionLink } from '../../../client/src/command-line-launch.js';

const FINGERPRINT = 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';

function link(url: string): ConnectionLink {
  const result = parseConnectionLink(url);
  if (!result.ok) throw new Error(result.error);
  return result.link;
}

function sshHost(
  aliases: string[],
  hostname: string,
  options: { port?: number; user?: string; displayName?: string } = {},
): SshHostEntry {
  return {
    alias: aliases[0]!,
    aliases,
    file: '/home/test/.ssh/config',
    options: {},
    resolved: {
      hostname,
      port: options.port ?? 22,
      ...(options.user ? { user: options.user } : {}),
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump: [],
      forwards: [],
      passwordOnly: false,
    },
    metadata: options.displayName
      ? { profileId: `ssh-${aliases[0]}`, displayName: options.displayName, connectCount: 0 }
      : undefined,
  };
}

function saved(id: string, name: string, profile: SavedHostSessionProfile): SavedHostProfile {
  return {
    id,
    kind: profile.kind,
    name,
    profile,
    metadata: { profileId: id, connectCount: 0 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const router = sshHost(['edge-router', 'edge'], '10.0.0.1', { user: 'admin', displayName: 'Edge router' });
const routerConsole = sshHost(['edge-console'], '10.0.0.1', { port: 2222, user: 'console' });
const lab = saved('lab-1', 'lab-switch', {
  kind: 'ssh',
  target: '192.0.2.10',
  user: 'netops',
  port: 830,
  useConfig: false,
});
const legacy = saved('telnet-1', 'legacy-switch', { kind: 'telnet', host: '192.0.2.20', port: 2323 });
const sshHosts = [router, routerConsole];
const profiles = [lab, legacy];

describe('ssh:// links against saved hosts', () => {
  it('uses an ssh_config host named by its alias, with the link’s user and port winning', () => {
    expect(resolveConnectionLink(link('ssh://edge-router'), sshHosts, profiles)).toEqual({
      kind: 'host',
      host: { kind: 'ssh', entry: router },
      profile: { kind: 'ssh', target: 'edge-router' },
    });
    expect(resolveConnectionLink(link('ssh://root@EDGE:2200'), sshHosts, profiles)).toMatchObject({
      kind: 'host',
      host: { kind: 'ssh', entry: router },
      profile: { kind: 'ssh', target: 'root@edge:2200' },
    });
  });

  it('matches an ssh_config host by host name and port', () => {
    expect(resolveConnectionLink(link('ssh://admin@10.0.0.1'), sshHosts, profiles)).toMatchObject({
      kind: 'host',
      host: { entry: router },
      profile: { target: 'edge-router' },
    });
    expect(resolveConnectionLink(link('ssh://10.0.0.1:2222'), sshHosts, profiles)).toMatchObject({
      kind: 'host',
      host: { entry: routerConsole },
      profile: { target: 'edge-console' },
    });
  });

  it('uses a saved Muxus host by name or address when user and port fit', () => {
    const expected = {
      kind: 'host',
      host: { kind: 'profile', entry: lab },
      profile: { ...lab.profile, profileId: 'lab-1' },
    };
    expect(resolveConnectionLink(link('ssh://lab-switch'), sshHosts, profiles)).toEqual(expected);
    expect(resolveConnectionLink(link('ssh://netops@192.0.2.10:830'), sshHosts, profiles)).toEqual(expected);
  });

  it('dials a saved Muxus host’s address ad hoc when the link asks for another user or port', () => {
    expect(resolveConnectionLink(link('ssh://root@192.0.2.10:830'), sshHosts, profiles)).toEqual({
      kind: 'ad-hoc',
      profile: { kind: 'ssh', target: 'root@192.0.2.10:830' },
      title: 'root@192.0.2.10:830',
    });
    expect(resolveConnectionLink(link('ssh://192.0.2.10'), sshHosts, profiles).kind).toBe('ad-hoc');
  });

  it('connects like quick connect when nothing matches', () => {
    expect(resolveConnectionLink(link('ssh://admin@10.9.9.9:2222'), sshHosts, profiles)).toEqual({
      kind: 'ad-hoc',
      profile: { kind: 'ssh', target: 'admin@10.9.9.9:2222' },
      title: 'admin@10.9.9.9:2222',
    });
  });

  it('narrows several address matches by user and otherwise does not guess', () => {
    const second = sshHost(['edge-ro'], '10.0.0.1', { user: 'readonly' });
    const hosts = [router, second];
    expect(resolveConnectionLink(link('ssh://readonly@10.0.0.1'), hosts, [])).toMatchObject({
      kind: 'host',
      host: { entry: second },
      profile: { target: 'edge-ro' },
    });
    expect(resolveConnectionLink(link('ssh://10.0.0.1'), hosts, []).kind).toBe('ad-hoc');
    expect(resolveConnectionLink(link('ssh://bob@10.0.0.1'), hosts, []).kind).toBe('ad-hoc');
  });

  it('prefers an alias over an address match', () => {
    const named = sshHost(['10.0.0.1'], '10.0.0.99');
    expect(resolveConnectionLink(link('ssh://10.0.0.1'), [router, named], [])).toMatchObject({
      host: { entry: named },
    });
  });

  it('carries a fingerprint into every kind of SSH launch', () => {
    const url = (address: string) => `ssh://;fingerprint=${FINGERPRINT}@${address}`;
    expect(resolveConnectionLink(link(url('edge')), sshHosts, profiles)).toMatchObject({
      profile: { target: 'edge', hostKeyFingerprint: FINGERPRINT },
    });
    expect(resolveConnectionLink(link(url('lab-switch')), sshHosts, profiles)).toMatchObject({
      profile: { profileId: 'lab-1', hostKeyFingerprint: FINGERPRINT },
    });
    expect(resolveConnectionLink(link(url('10.9.9.9')), sshHosts, profiles)).toMatchObject({
      kind: 'ad-hoc',
      profile: { target: '10.9.9.9', hostKeyFingerprint: FINGERPRINT },
    });
  });
});

describe('telnet:// links against saved hosts', () => {
  it('uses a saved Telnet host by name or address and port', () => {
    const expected = {
      kind: 'host',
      host: { kind: 'profile', entry: legacy },
      profile: { ...legacy.profile, profileId: 'telnet-1' },
    };
    expect(resolveConnectionLink(link('telnet://legacy-switch'), sshHosts, profiles)).toEqual(expected);
    expect(resolveConnectionLink(link('telnet://192.0.2.20:2323'), sshHosts, profiles)).toEqual(expected);
  });

  it('opens other addresses as a new Telnet session on port 23 by default', () => {
    expect(resolveConnectionLink(link('telnet://192.0.2.20'), sshHosts, profiles)).toEqual({
      kind: 'ad-hoc',
      profile: { kind: 'telnet', host: '192.0.2.20', port: 23 },
      title: '192.0.2.20',
    });
    expect(resolveConnectionLink(link('telnet://[2001:db8::7]:2323'), sshHosts, profiles)).toEqual({
      kind: 'ad-hoc',
      profile: { kind: 'telnet', host: '2001:db8::7', port: 2323 },
      title: '[2001:db8::7]:2323',
    });
  });

  it('never opens an SSH host for a telnet:// link', () => {
    expect(resolveConnectionLink(link('telnet://edge-router'), sshHosts, profiles).kind).toBe('ad-hoc');
    expect(resolveConnectionLink(link('ssh://legacy-switch'), sshHosts, profiles).kind).toBe('ad-hoc');
  });
});
