import { describe, expect, it } from 'vitest';
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
      sessions: [
        {
          id: expect.any(String),
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

    expect(parsed.sessions.map(({ alias, port, username }) => ({ alias, port, username }))).toEqual([
      { alias: 'My-host', port: 22, username: undefined },
      { alias: 'My-host-2', port: 22, username: undefined },
    ]);
  });

  it('counts unsupported and malformed bookmark entries', () => {
    const parsed = parseMobaXtermSessions(`
[Bookmarks]
RDP=#91#0%desktop.example.com
Broken SSH=#109#0%%22%root%%
Valid=#109#0%valid.example.com%22%root%%
`);

    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.ignoredCount).toBe(2);
  });

  it('rejects files with no SSH bookmarks', () => {
    expect(() =>
      parseMobaXtermSessions(`
[Bookmarks]
SubRep=
RDP=#91#0%desktop.example.com
`),
    ).toThrow('No SSH sessions were found');
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
});
