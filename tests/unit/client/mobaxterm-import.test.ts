import { describe, expect, it } from 'vitest';
import { savedHostHop } from '@muxus/shared';
import {
  mobaXtermConnections,
  parseMobaXtermSessions,
} from '../../../client/src/mobaxterm-import.js';

describe('MobaXterm session parsing', () => {
  it('reads SSH fields, nested folders and authentication intent', () => {
    const parsed = parseMobaXtermSessions(`
[Misc]
LastSession=Do not import|#109#0%ignored.example.com%22%root%%rest

[Bookmarks]
SubRep=Production\\Europe
Prod SSH=#109#0%prod.example.com%2222%deploy%%rest

[Bookmarks_1]
SubRep=Lab
Key box=#109#0%key.example.com%22%root%3%rest
`);

    expect(parsed).toEqual({
      ignoredCount: 0,
      skippedSessions: [],
      sessions: [
        {
          id: expect.any(String),
          kind: 'ssh',
          name: 'Prod SSH',
          alias: 'Prod-SSH',
          host: 'prod.example.com',
          port: 2222,
          username: 'deploy',
          folder: 'Production/Europe',
          authMode: 'password',
        },
        {
          id: expect.any(String),
          kind: 'ssh',
          name: 'Key box',
          alias: 'Key-box',
          host: 'key.example.com',
          port: 22,
          username: 'root',
          folder: 'Lab',
          authMode: 'key',
        },
      ],
    });
  });

  it('makes duplicate and OpenSSH-invalid names safe without losing display names', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
SubRep=
My host!=#109#0%one.example.com%not-a-port%%%rest
My host!=#109#0%two.example.com%22%%%rest
`);

    expect(
      parsed.sessions.map((session) => ({
        alias: session.kind === 'ssh' ? session.alias : undefined,
        port: session.port,
        username: session.username,
      })),
    ).toEqual([
      { alias: 'My-host', port: 22, username: undefined },
      { alias: 'My-host-2', port: 22, username: undefined },
    ]);
  });

  it('uses the protocol field instead of the leading metadata identifier', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
SubRep=
Custom icon SSH=#114#0%airframe.example.com%2222%root%%rest
`);

    expect(parsed.sessions).toEqual([
      {
        id: expect.any(String),
        kind: 'ssh',
        name: 'Custom icon SSH',
        alias: 'Custom-icon-SSH',
        host: 'airframe.example.com',
        port: 2222,
        username: 'root',
        authMode: 'password',
      },
    ]);
  });

  it('counts unsupported and malformed bookmark entries', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
Telnet=#98#1%switch.example.com%23%%%2%%22%%%0#MobaFont%10
WSL=#105#14%Ubuntu%
Broken SSH=#109#0%%22%root%%
Broken RDP=#91#4%%3389%admin%0
Valid=#109#0%valid.example.com%22%root%%
`);

    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.ignoredCount).toBe(4);
    expect(parsed.skippedSessions).toEqual([
      {
        id: expect.any(String),
        name: 'Telnet',
        reason: 'Only SSH, RDP and VNC sessions can be imported',
      },
      {
        id: expect.any(String),
        name: 'WSL',
        reason: 'Only SSH, RDP and VNC sessions can be imported',
      },
      {
        id: expect.any(String),
        name: 'Broken SSH',
        reason: 'SSH session has no hostname',
      },
      {
        id: expect.any(String),
        name: 'Broken RDP',
        reason: 'RDP session has no hostname',
      },
    ]);
  });

  it('rejects files with nothing it can import', () => {
    expect(() =>
      parseMobaXtermSessions(`
[Bookmarks]
SubRep=
Telnet=#98#1%switch.example.com%23%%%2%%22%%%0
`),
    ).toThrow('No SSH, RDP or VNC sessions were found');
  });

  it('reads private keys and SSH gateways without reading terminal settings', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
SubRep=Lab
Direct key=#109#0%direct.example.com%22%admin%%-1%-1%%%%%0%0%0%_ProfileDir_\\ssh_keys\\id_ecdsa%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236
Via bastion=#109#0%10.0.0.5%22%root%%-1%-1%%bastion.example.com%2222%jump%0%0%0%%_CurrentDrive_:\\keys\\bastion.ppk%-1%0%0%0%%1080%%0%0%1#MobaFont%10
Two hops=#109#0%10.0.1.5%22%root%%-1%-1%%bastion.example.com__PIPE__inner.example.com%2222__PIPE__22%jump__PIPE__ops%0%0%0%%_CurrentDrive_:\\keys\\bastion.ppk__PIPE__%-1%0%0%0%%1080%%0%0%1#MobaFont%10
`);

    const [direct, viaBastion, twoHops] = parsed.sessions;
    expect(direct).toMatchObject({
      kind: 'ssh',
      host: 'direct.example.com',
      authMode: 'key',
      identityFile: '~/ssh_keys/id_ecdsa',
    });
    expect(direct).not.toHaveProperty('jumpHost');

    const bastion = {
      id: expect.any(String),
      alias: 'jump-jump-bastion.example.com-2222',
      name: 'jump@bastion.example.com:2222',
      host: 'bastion.example.com',
      port: 2222,
      username: 'jump',
      identityFile: 'C:/keys/bastion.ppk',
    };
    expect(viaBastion).toMatchObject({ authMode: 'password', jumpHost: bastion });
    expect(viaBastion).not.toHaveProperty('identityFile');
    expect(twoHops).toMatchObject({
      jumpHost: {
        alias: 'jump-ops-inner.example.com',
        name: 'ops@inner.example.com via jump@bastion.example.com:2222',
        host: 'inner.example.com',
        port: 22,
        username: 'ops',
        via: bastion,
      },
    });
    expect(twoHops?.kind === 'ssh' && twoHops.jumpHost).not.toHaveProperty('identityFile');
    // One shared object per distinct hop, so the bastion is imported once.
    expect(twoHops?.kind === 'ssh' && twoHops.jumpHost?.via).toBe(
      viaBastion?.kind === 'ssh' ? viaBastion.jumpHost : undefined,
    );
  });

  it('keeps the execute command as the startup command', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
Root=#109#0%a.example.com%22%admin%%-1%-1%sudo su -__PTVIRG__ echo done__PTVIRG__%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10
Nested=#109#0%b.example.com%22%root%%-1%-1%echo pw __PIPE__ sshpass -p pw ssh -oHostKeyAlgorithms__EQUAL__+ssh-rsa admin@10.0.0.1%%%%-1%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10
Plain=#109#0%c.example.com%22%root%%-1%-1%%%%%-1%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10
`);

    expect(parsed.sessions.map((session) => session.kind === 'ssh' && session.remoteCommand)).toEqual([
      'sudo su -; echo done',
      'echo pw | sshpass -p pw ssh -oHostKeyAlgorithms=+ssh-rsa admin@10.0.0.1; exec "$SHELL" -l',
      undefined,
    ]);

    const [root] = mobaXtermConnections(parsed.sessions, 'muxus').savedHosts;
    expect(root?.profile).toMatchObject({
      remoteCommand: 'sudo su -; echo done',
      requestTty: 'yes',
    });
    const [, , plain] = mobaXtermConnections(parsed.sessions, 'openssh').sshHosts;
    expect(plain?.options).not.toHaveProperty('remoteCommand');
    expect(plain?.options).not.toHaveProperty('requestTty');
  });

  it('reads RDP and VNC sessions with their SSH gateways', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
SubRep=Desktops
Windows=#91#4%win.example.com%3390%Administrator%0%-1%-1%-1%-1%0%0%-1%%bastion.example.com%22%root%0%0%_ProfileDir_\\keys\\id_ed25519%-1%%-1%-1%0%-1%0%-1#MobaFont%10%0
Console=#128#5%127.0.0.1%5901%-1%0%bastion.example.com%22%root%%-1#MobaFont%10%0%0%-1%15%236,236,236
Plain VNC=#128#5%vnc.example.com%%-1%0%%22%%%-1#MobaFont%10
`);

    expect(parsed.sessions).toEqual([
      {
        id: expect.stringMatching(/^mobaxterm-rdp-/),
        kind: 'rdp',
        name: 'Windows',
        host: 'win.example.com',
        port: 3390,
        username: 'Administrator',
        folder: 'Desktops',
        jumpHost: expect.objectContaining({
          name: 'root@bastion.example.com',
          identityFile: '~/keys/id_ed25519',
        }),
      },
      {
        id: expect.stringMatching(/^mobaxterm-vnc-/),
        kind: 'vnc',
        name: 'Console',
        host: '127.0.0.1',
        port: 5901,
        username: undefined,
        folder: 'Desktops',
        jumpHost: expect.objectContaining({ name: 'root@bastion.example.com (2)' }),
      },
      {
        id: expect.stringMatching(/^mobaxterm-vnc-/),
        kind: 'vnc',
        name: 'Plain VNC',
        host: 'vnc.example.com',
        port: 5900,
        username: undefined,
        folder: 'Desktops',
      },
    ]);
  });
});

describe('MobaXterm connection conversion', () => {
  it('maps sessions into Muxus hosts without copying secrets', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
SubRep=Customers\\Acme
Password host=#109#0%pw.example.com%2200%alice%%rest
Key host=#109#0%key.example.com%22%bob%3%rest
`);
    const portable = mobaXtermConnections(parsed.sessions);

    expect(portable.savedHosts).toEqual([]);
    expect(portable.hostOrder).toEqual([]);
    expect(portable.sshHosts).toEqual([
      {
        alias: 'Password-host',
        aliases: ['Password-host'],
        description: 'Imported from MobaXterm.',
        options: {
          hostname: 'pw.example.com',
          user: 'alice',
          port: 2200,
          passwordOnly: true,
        },
        metadata: {
          displayName: 'Password host',
          group: 'Customers/Acme',
        },
      },
      {
        alias: 'Key-host',
        aliases: ['Key-host'],
        description: 'Imported from MobaXterm.',
        options: {
          hostname: 'key.example.com',
          user: 'bob',
        },
        metadata: {
          displayName: 'Key host',
          group: 'Customers/Acme',
        },
      },
    ]);
  });

  it('can keep imported SSH sessions in Muxus app data', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
SubRep=Customers\\Acme
Password host=#109#0%pw.example.com%2200%alice%%rest
`);
    const portable = mobaXtermConnections(parsed.sessions, 'muxus');

    expect(portable.sshHosts).toEqual([]);
    expect(portable.savedHosts).toEqual([
      {
        id: expect.stringMatching(/^mobaxterm-ssh-/),
        name: 'Password host',
        profile: {
          kind: 'ssh',
          target: 'pw.example.com',
          useConfig: false,
          user: 'alice',
          port: 2200,
          passwordOnly: true,
        },
        metadata: { group: 'Customers/Acme' },
      },
    ]);
  });

  const GATEWAY_FILE = `
[Bookmarks]
SubRep=Lab
Inner=#109#0%10.0.1.5%22%root%%-1%-1%%bastion.example.com__PIPE__inner.example.com%2222__PIPE__22%jump__PIPE__ops%0%0%0%_ProfileDir_\\keys\\lab%_ProfileDir_\\keys\\bastion__PIPE__%-1%0%0%0%%1080%%0%0%1#MobaFont%10
Windows=#91#4%win.example.com%3389%admin%0%-1%-1%-1%-1%0%0%-1%%bastion.example.com%2222%jump%0%0%_ProfileDir_\\keys\\bastion%-1%%-1%-1%0%-1%0%-1#MobaFont%10
`;

  it('keeps keys and jump hosts as saved Muxus hosts', () => {
    const portable = mobaXtermConnections(parseMobaXtermSessions(GATEWAY_FILE).sessions, 'muxus');

    expect(portable.sshHosts).toEqual([]);
    const [inner, windows, innerHop, bastion] = portable.savedHosts;
    expect(portable.savedHosts).toHaveLength(4);
    expect(bastion).toEqual({
      id: expect.stringMatching(/^mobaxterm-jump-/),
      name: 'jump@bastion.example.com:2222',
      profile: {
        kind: 'ssh',
        target: 'bastion.example.com',
        useConfig: false,
        user: 'jump',
        port: 2222,
        identityFiles: ['~/keys/bastion'],
      },
      metadata: { group: 'MobaXterm jump hosts' },
    });
    expect(innerHop).toEqual({
      id: expect.stringMatching(/^mobaxterm-jump-/),
      name: 'ops@inner.example.com via jump@bastion.example.com:2222',
      profile: {
        kind: 'ssh',
        target: 'inner.example.com',
        useConfig: false,
        user: 'ops',
        passwordOnly: true,
        proxyJump: [savedHostHop(bastion!.id)],
      },
      metadata: { group: 'MobaXterm jump hosts' },
    });
    expect(inner).toEqual({
      id: expect.stringMatching(/^mobaxterm-ssh-/),
      name: 'Inner',
      profile: {
        kind: 'ssh',
        target: '10.0.1.5',
        useConfig: false,
        user: 'root',
        identityFiles: ['~/keys/lab'],
        proxyJump: [savedHostHop(innerHop!.id)],
      },
      metadata: { group: 'Lab' },
    });
    expect(windows).toEqual({
      id: expect.stringMatching(/^mobaxterm-rdp-/),
      name: 'Windows',
      profile: {
        kind: 'rdp',
        host: 'win.example.com',
        port: 3389,
        username: 'admin',
        sshGateway: { target: 'bastion.example.com', profileId: bastion!.id },
      },
      metadata: { group: 'Lab' },
    });
  });

  it('writes jump hosts as chained Host blocks for OpenSSH config', () => {
    const portable = mobaXtermConnections(parseMobaXtermSessions(GATEWAY_FILE).sessions, 'openssh');

    expect(portable.sshHosts.map(({ alias, options }) => ({ alias, options }))).toEqual([
      {
        alias: 'Inner',
        options: {
          hostname: '10.0.1.5',
          user: 'root',
          identityFiles: ['~/keys/lab'],
          proxyJump: ['jump-ops-inner.example.com'],
        },
      },
      {
        alias: 'jump-ops-inner.example.com',
        options: {
          hostname: 'inner.example.com',
          user: 'ops',
          passwordOnly: true,
          proxyJump: ['jump-jump-bastion.example.com-2222'],
        },
      },
      {
        alias: 'jump-jump-bastion.example.com-2222',
        options: {
          hostname: 'bastion.example.com',
          user: 'jump',
          port: 2222,
          identityFiles: ['~/keys/bastion'],
        },
      },
    ]);
    expect(portable.sshHosts[2]?.metadata).toEqual({
      displayName: 'jump@bastion.example.com:2222',
      group: 'MobaXterm jump hosts',
    });
    expect(portable.savedHosts).toEqual([
      expect.objectContaining({
        name: 'Windows',
        profile: expect.objectContaining({
          sshGateway: { target: 'jump-jump-bastion.example.com-2222' },
        }),
      }),
    ]);
  });
});
