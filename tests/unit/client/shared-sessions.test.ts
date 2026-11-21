import { describe, expect, it } from 'vitest';
import { savedHostHop } from '@muxus/shared';
import { parseSharedSessions } from '../../../client/src/shared-sessions.js';

const SOURCE = { id: 'lab-link', folder: 'Lab' };

// One entry as a lab portal publishes it for MobaXterm's shared sessions.
const PORTAL_FILE = `[Bookmarks_1]
SubRep=clab
ImgNum=41
node0 [sudo]=#196#0%node0.lab.example.net%22%alice%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# clab, sudo #-1
`;

describe('shared sessions from a MobaXterm file', () => {
  it('reads a portal entry into the link folder with the user filled in', () => {
    const list = parseSharedSessions(PORTAL_FILE, SOURCE);

    expect(list).toEqual({
      format: 'mobaxterm',
      skipped: 0,
      hosts: [
        {
          id: expect.stringMatching(/^shared-/),
          name: 'node0 [sudo]',
          group: 'Lab/clab',
          profile: {
            kind: 'ssh',
            target: 'node0.lab.example.net',
            useConfig: false,
            user: 'alice',
            passwordOnly: true,
          },
        },
      ],
    });
  });

  it('keeps an entry on the same host across checks and apart between links', () => {
    const first = parseSharedSessions(PORTAL_FILE, SOURCE).hosts[0]!.id;
    // The portal filled in more settings; it is still the same entry.
    const again = parseSharedSessions(PORTAL_FILE.replace('%22%alice', '%2222%bob'), SOURCE).hosts[0]!.id;
    const otherLink = parseSharedSessions(PORTAL_FILE, { id: 'other-link', folder: 'Lab' }).hosts[0]!.id;

    expect(again).toBe(first);
    expect(otherLink).not.toBe(first);
  });

  it('brings SSH gateways along as jump hosts inside the link folder', () => {
    const list = parseSharedSessions(
      `[Bookmarks]
SubRep=
Inner=#109#0%10.0.1.5%22%root%%-1%-1%%bastion.example.com%2222%jump%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10
Desk=#91#4%10.0.1.9%3389%admin%0%-1%-1%0%0%0%0%0%-1%bastion.example.com%2222%jump%0%0%%-1
`,
      SOURCE,
    );

    const jump = list.hosts.find((host) => host.name === 'jump@bastion.example.com:2222');
    expect(jump).toMatchObject({
      group: 'Lab/Jump hosts',
      profile: { kind: 'ssh', target: 'bastion.example.com', port: 2222, user: 'jump', useConfig: false },
    });
    expect(list.hosts.find((host) => host.name === 'Inner')).toMatchObject({
      group: 'Lab',
      profile: { proxyJump: [savedHostHop(jump!.id)] },
    });
    expect(list.hosts.find((host) => host.name === 'Desk')).toMatchObject({
      profile: { kind: 'rdp', sshGateway: { target: 'bastion.example.com', profileId: jump!.id } },
    });
    // Every host is one of this link's: nothing keeps an ID a plain import would also use.
    expect(list.hosts.every((host) => host.id.startsWith('shared-'))).toBe(true);
  });

  it('counts sessions Muxus does not import', () => {
    const list = parseSharedSessions(
      `[Bookmarks]
SubRep=
Box=#109#0%box.example.com%22%root%%rest
Files=#130#6%ftp.example.com%21%anonymous%rest
`,
      SOURCE,
    );

    expect(list.hosts.map((host) => host.name)).toEqual(['Box']);
    expect(list.skipped).toBe(1);
  });
});

describe('shared sessions from a Muxus backup', () => {
  it('needs only the format and the hosts', () => {
    const list = parseSharedSessions(
      JSON.stringify({
        format: 'muxus-backup',
        data: {
          savedHosts: [
            {
              name: 'Core router',
              profile: { kind: 'ssh', target: 'core.example.net', user: 'admin' },
              metadata: { group: 'Network/Core', color: '#ff8800', icon: 'router', loginSequence: { steps: [] } },
            },
            { name: 'Console', profile: { kind: 'telnet', host: 'console.example.net', port: 2001 } },
          ],
        },
      }),
      SOURCE,
    );

    expect(list).toEqual({
      format: 'muxus',
      skipped: 0,
      hosts: [
        {
          id: expect.stringMatching(/^shared-/),
          name: 'Core router',
          group: 'Lab/Network/Core',
          color: '#ff8800',
          icon: 'router',
          profile: { kind: 'ssh', target: 'core.example.net', user: 'admin', useConfig: false },
        },
        {
          id: expect.stringMatching(/^shared-/),
          name: 'Console',
          group: 'Lab',
          profile: { kind: 'telnet', host: 'console.example.net', port: 2001 },
        },
      ],
    });
  });

  it('points jump hosts and gateways at the hosts the list brought', () => {
    const list = parseSharedSessions(
      JSON.stringify({
        format: 'muxus-backup',
        version: 2,
        data: {
          savedHosts: [
            { id: 'bastion', name: 'Bastion', profile: { kind: 'ssh', target: 'bastion.example.net', useConfig: false, profileId: 'bastion' }, metadata: {} },
            {
              id: 'inner',
              name: 'Inner',
              profile: {
                kind: 'ssh',
                target: '10.0.0.5',
                useConfig: false,
                proxyJump: [savedHostHop('bastion')],
                proxyJumpFallbacks: [[savedHostHop('bastion'), 'elsewhere']],
              },
              metadata: {},
            },
            { id: 'desk', name: 'Desk', profile: { kind: 'vnc', host: '10.0.0.9', port: 5900, sshGateway: { target: 'bastion.example.net', profileId: 'bastion' } }, metadata: {} },
            { id: 'outside', name: 'Outside', profile: { kind: 'ssh', target: '10.0.0.6', proxyJump: [savedHostHop('not-in-the-list')] }, metadata: {} },
          ],
        },
      }),
      SOURCE,
    );
    const [bastion, inner, desk, outside] = list.hosts;

    expect(bastion!.id).not.toBe('bastion');
    expect(bastion!.profile).toEqual({ kind: 'ssh', target: 'bastion.example.net', useConfig: false });
    expect(inner!.profile).toMatchObject({
      proxyJump: [savedHostHop(bastion!.id)],
      proxyJumpFallbacks: [[savedHostHop(bastion!.id), 'elsewhere']],
    });
    expect(desk!.profile).toMatchObject({
      sshGateway: { target: 'bastion.example.net', profileId: bastion!.id },
    });
    // A hop the list does not bring is left as written and fails when dialed.
    expect(outside!.profile).toMatchObject({ proxyJump: [savedHostHop('not-in-the-list')] });
  });

  it('turns the ssh_config hosts of a backup into hosts of their own', () => {
    const list = parseSharedSessions(
      JSON.stringify({
        format: 'muxus-backup',
        version: 2,
        data: {
          sshHosts: [
            { alias: 'jump', aliases: ['jump', 'gw'], options: { hostname: 'jump.example.net', user: 'ops', port: 2222 } },
            {
              alias: 'db',
              aliases: ['db'],
              options: {
                hostname: '10.1.0.7',
                proxyJump: ['gw', 'user@literal.example.net'],
                identityFiles: ['~/.ssh/lab'],
                extras: [{ keyword: 'Compression', value: 'yes' }],
              },
              metadata: { displayName: 'Database', group: 'Data' },
            },
          ],
          savedHosts: [
            { id: 'ui', name: 'Lab UI', profile: { kind: 'web', url: 'https://ui.lab.example.net', sshGateway: { target: 'jump' } }, metadata: {} },
          ],
        },
      }),
      SOURCE,
    );
    const jump = list.hosts.find((host) => host.name === 'jump')!;

    expect(jump.profile).toEqual({
      kind: 'ssh',
      target: 'jump.example.net',
      useConfig: false,
      user: 'ops',
      port: 2222,
    });
    expect(list.hosts.find((host) => host.name === 'Database')).toEqual({
      id: expect.stringMatching(/^shared-/),
      name: 'Database',
      group: 'Lab/Data',
      profile: {
        kind: 'ssh',
        target: '10.1.0.7',
        useConfig: false,
        identityFiles: ['~/.ssh/lab'],
        proxyJump: [savedHostHop(jump.id), 'user@literal.example.net'],
      },
    });
    expect(list.hosts.find((host) => host.name === 'Lab UI')!.profile).toMatchObject({
      sshGateway: { target: 'jump.example.net', profileId: jump.id },
    });
  });

  it('leaves out entries that are not hosts and tells same-named ones apart', () => {
    const list = parseSharedSessions(
      JSON.stringify({
        format: 'muxus-backup',
        data: {
          savedHosts: [
            { name: 'Twin', profile: { kind: 'telnet', host: 'a.example.net' } },
            { name: 'Twin', profile: { kind: 'telnet', host: 'b.example.net' } },
            { name: 'Shell', profile: { kind: 'local' } },
            { profile: { kind: 'telnet', host: 'nameless.example.net' } },
            'nonsense',
          ],
        },
      }),
      SOURCE,
    );

    expect(list.hosts.map((host) => host.name)).toEqual(['Twin', 'Twin']);
    expect(new Set(list.hosts.map((host) => host.id)).size).toBe(2);
    expect(list.skipped).toBe(3);
  });
});

describe('shared sessions that cannot be used', () => {
  it.each([
    ['', 'The link returned nothing.'],
    ['<!DOCTYPE html><html><body>Sign in</body></html>', 'The link returned a web page instead of a session list. It may need a sign-in.'],
    ['not found', 'The link returned neither a MobaXterm session file nor a Muxus session list.'],
    ['{"format":"something-else","data":{}}', 'The link returned JSON that is neither a Muxus session list nor a Muxus backup.'],
    ['{"format":', 'The link returned JSON that cannot be read.'],
    ['{"format":"muxus-backup","data":{"savedHosts":[]}}', 'The shared sessions list has no hosts.'],
    ['[Bookmarks]\nSubRep=\n', 'No SSH, RDP or VNC sessions were found in this MobaXterm file.'],
  ])('refuses %j', (content, message) => {
    expect(() => parseSharedSessions(content, SOURCE)).toThrow(message);
  });
});
