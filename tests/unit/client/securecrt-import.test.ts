import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import {
  MAX_SECURECRT_IMPORT_BYTES,
  parseSecureCrtButton,
  parseSecureCrtSessions,
  secureCrtConnections,
  secureCrtSendString,
} from '../../../client/src/securecrt-import.js';

const NativeDomParser = globalThis.DOMParser;

beforeAll(() => {
  class StrictTestDomParser {
    parseFromString(text: string, mimeType: DOMParserSupportedType): Document {
      let failed = false;
      const parser = new XmlDomParser({
        onError: () => {
          failed = true;
        },
      });
      const document = parser.parseFromString(text, mimeType) as unknown as Document;
      if (failed) throw new Error('malformed XML');
      return document;
    }
  }
  globalThis.DOMParser = StrictTestDomParser as unknown as typeof DOMParser;
});

afterAll(() => {
  if (NativeDomParser) globalThis.DOMParser = NativeDomParser;
  else delete (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
});

const EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Security"><string name="Passphrase">encrypted-secret</string></key>
  <key name="Sessions">
    <key name="Customers &amp; labs">
      <key name="Europe">
        <key name="Core router">
          <dword name="Is Session">1</dword>
          <string name="Protocol Name">SSH2</string>
          <string name="Hostname">router.example.test</string>
          <string name="Username">deploy</string>
          <dword name="[SSH2] Port">2222</dword>
          <string name="SSH2 Authentications V2">keyboard-interactive,password,gssapi</string>
          <string name="Password V2">encrypted-password</string>
          <string name="Identity Filename V2">/private/key/that/must/not/import</string>
        </key>
        <key name="Core router">
          <dword name="Is Session">1</dword>
          <string name="Protocol Name">SSH2</string>
          <string name="Hostname">key.example.test</string>
          <string name="Username">root</string>
          <dword name="[SSH2] Port">70000</dword>
          <string name="SSH2 Authentications V2">publickey,password</string>
        </key>
      </key>
      <key name="Bench console">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">Serial</string>
        <string name="Mac Com Port">/dev/cu.usbserial-1234</string>
        <dword name="Mac Baud Rate">9600</dword>
        <dword name="Mac Data Bits">7</dword>
        <dword name="Mac Stop Bits">2</dword>
        <dword name="Mac Parity">2</dword>
        <dword name="Mac CTS Flow">1</dword>
        <dword name="Mac XON Flow">1</dword>
      </key>
      <key name="Empty folder"/>
    </key>
    <key name="Local terminal">
      <dword name="Is Session">1</dword>
      <string name="Protocol Name">Local Shell</string>
    </key>
    <key name="Broken SSH">
      <dword name="Is Session">1</dword>
      <string name="Protocol Name">SSH2</string>
      <string name="Hostname"/>
    </key>
  </key>
  <key name="Files">
    <key name="File 0"><binary name="Contents">private-key-bytes</binary></key>
  </key>
</VanDyke>`;

describe('SecureCRT session parsing', () => {
  it('reads nested SSH and serial sessions while counting unsupported entries', () => {
    const parsed = parseSecureCrtSessions(EXPORT);

    expect(parsed.ignoredCount).toBe(2);
    expect(parsed.skippedSessions).toEqual([
      {
        id: expect.any(String),
        name: 'Local terminal',
        reason: 'Protocol “Local Shell” is not supported',
      },
      {
        id: expect.any(String),
        name: 'Broken SSH',
        reason: 'SSH session has no hostname',
      },
    ]);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions[0]).toMatchObject({
      kind: 'ssh',
      name: 'Core router',
      alias: 'Core-router',
      host: 'router.example.test',
      port: 2222,
      username: 'deploy',
      folder: 'Customers & labs/Europe',
      authMode: 'password',
    });
    expect(parsed.sessions[1]).toMatchObject({
      kind: 'ssh',
      alias: 'Core-router-2',
      host: 'key.example.test',
      port: 22,
      authMode: 'key',
    });
    expect(parsed.sessions[2]).toMatchObject({
      kind: 'serial',
      name: 'Bench console',
      path: '/dev/cu.usbserial-1234',
      baudRate: 9600,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      flowControl: 'hardware',
      folder: 'Customers & labs',
      profileId: expect.stringMatching(/^securecrt-serial-/),
    });
  });

  it('uses unprefixed serial fields and software flow-control fallbacks', () => {
    const parsed = parseSecureCrtSessions(`
      <VanDyke><key name="Sessions"><key name="Console">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">Serial</string>
        <string name="Com Port">COM4</string>
        <dword name="Baud Rate">115200</dword>
        <dword name="Data Bits">8</dword>
        <dword name="Stop Bits">1</dword>
        <dword name="Parity">4</dword>
        <dword name="XON Flow">1</dword>
      </key></key></VanDyke>
    `);

    expect(parsed.sessions[0]).toMatchObject({
      kind: 'serial',
      path: 'COM4',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1.5,
      parity: 'space',
      flowControl: 'software',
    });
  });

  it('produces deterministic serial identities', () => {
    const first = parseSecureCrtSessions(EXPORT).sessions.find((session) => session.kind === 'serial');
    const second = parseSecureCrtSessions(EXPORT).sessions.find((session) => session.kind === 'serial');
    expect(first?.id).toBe(second?.id);
  });

  it('rejects dangerous, oversized and unrelated XML', () => {
    expect(() => parseSecureCrtSessions('<!DOCTYPE x><VanDyke/>')).toThrow(/declarations or entities/);
    expect(() => parseSecureCrtSessions('<Other/>')).toThrow(/valid SecureCRT/);
    expect(() => parseSecureCrtSessions('<VanDyke/>')).toThrow(/Sessions or Button Bars section/);
    expect(() => parseSecureCrtSessions('<VanDyke><key></VanDyke>')).toThrow(/malformed/);
    expect(() => parseSecureCrtSessions('x'.repeat(MAX_SECURECRT_IMPORT_BYTES + 1))).toThrow(/20 MB/);
  });

  it('rejects files without a supported, complete session', () => {
    expect(() =>
      parseSecureCrtSessions(`
        <VanDyke><key name="Sessions"><key name="Shell">
          <dword name="Is Session">1</dword>
          <string name="Protocol Name">Local Shell</string>
        </key></key></VanDyke>
      `),
    ).toThrow(/No supported SSH, Telnet or serial sessions/);
  });
});

describe('SecureCRT connection conversion', () => {
  it('maps reviewed sessions without copying secrets or file paths', () => {
    const portable = secureCrtConnections(parseSecureCrtSessions(EXPORT).sessions);

    expect(portable.sshHosts).toEqual([
      {
        alias: 'Core-router',
        aliases: ['Core-router'],
        description: 'Imported from SecureCRT.',
        options: {
          hostname: 'router.example.test',
          user: 'deploy',
          port: 2222,
          passwordOnly: true,
        },
        metadata: {
          displayName: 'Core router',
          group: 'Customers & labs/Europe',
        },
      },
      {
        alias: 'Core-router-2',
        aliases: ['Core-router-2'],
        description: 'Imported from SecureCRT.',
        options: { hostname: 'key.example.test', user: 'root' },
        metadata: {
          displayName: 'Core router',
          group: 'Customers & labs/Europe',
        },
      },
    ]);
    expect(portable.savedHosts).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^securecrt-serial-/),
        name: 'Bench console',
        profile: {
          kind: 'serial',
          path: '/dev/cu.usbserial-1234',
          baudRate: 9600,
          dataBits: 7,
          stopBits: 2,
          parity: 'even',
          flowControl: 'hardware',
        },
        metadata: { group: 'Customers & labs' },
      }),
    ]);
    expect(JSON.stringify(portable)).not.toContain('encrypted');
    expect(JSON.stringify(portable)).not.toContain('/private/key');
    expect(JSON.stringify(portable)).not.toContain('private-key-bytes');
  });

  it('stores SSH sessions alongside native serial profiles when requested', () => {
    const portable = secureCrtConnections(
      parseSecureCrtSessions(EXPORT).sessions,
      'muxus',
    );

    expect(portable.sshHosts).toEqual([]);
    expect(portable.savedHosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^securecrt-ssh-/),
          name: 'Core router',
          profile: expect.objectContaining({
            kind: 'ssh',
            target: 'router.example.test',
            useConfig: false,
            user: 'deploy',
            port: 2222,
            passwordOnly: true,
          }),
          metadata: { group: 'Customers & labs/Europe' },
        }),
        expect.objectContaining({
          id: expect.stringMatching(/^securecrt-serial-/),
          profile: expect.objectContaining({ kind: 'serial' }),
        }),
      ]),
    );
  });
});

// Shaped like a SecureCRT 9.7 export: templates at the root, Telnet and SSH
// sessions naming their bar, and a ButtonBarV5 key with one array per bar.
const BAR_EXPORT = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="Edge">
      <key name="PE1">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">SSH2</string>
        <string name="Hostname">pe1.example.test</string>
        <dword name="[SSH2] Port">22</dword>
        <string name="User Button Bar Name">Junos</string>
      </key>
      <key name="Looking glass">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">Telnet</string>
        <string name="Hostname">lg.example.test</string>
        <dword name="Port">2323</dword>
        <string name="User Button Bar Name">Deleted bar</string>
        <array name="Login Script V4"><string>03:encrypted-step</string></array>
      </key>
    </key>
    <key name="Default">
      <dword name="Is Session">1</dword>
      <string name="Protocol Name">SSH2</string>
    </key>
    <key name="Default_Serial">
      <dword name="Is Session">1</dword>
      <string name="Protocol Name">Serial</string>
    </key>
  </key>
  <key name="ButtonBarV5">
    <array name="Junos">
      <string>SEND,show config | display set | match ,show config,,,0,1,</string>
      <string>SEND,deactivate term A\\n\r\ndeactivate term B\\n,Disable,,,0,1,Turns both terms off,</string>
      <string>SEND,ena\r\pSECRET\r,enable,,,0,5,</string>
      <string>MENU_TOGGLE_KEYWORD_HIGHLIGHTING,,Highlight on/off,,,0,0,</string>
    </array>
    <array name="Tools">
      <string>SEND,echo a,b\r,echo,,,0,2,</string>
    </array>
  </key>
</VanDyke>`;

describe('SecureCRT Telnet sessions and button bars', () => {
  it('imports Telnet, skips templates silently and links hosts to bars in the file', () => {
    const parsed = parseSecureCrtSessions(BAR_EXPORT);

    expect(parsed.ignoredCount).toBe(0);
    expect(parsed.sessions).toEqual([
      expect.objectContaining({
        kind: 'ssh',
        name: 'PE1',
        folder: 'Edge',
        commandButtonGroup: parsed.commandBars?.[0]?.id,
      }),
      {
        id: expect.stringMatching(/^securecrt-telnet-/),
        kind: 'telnet',
        name: 'Looking glass',
        host: 'lg.example.test',
        port: 2323,
        folder: 'Edge',
      },
    ]);
    expect(parsed.commandBars?.map((bar) => bar.name)).toEqual(['Junos', 'Tools']);
    expect(parsed.commandBars?.[0]?.id).toMatch(/^securecrt-bar-/);
    expect(parseSecureCrtSessions(BAR_EXPORT).commandBars?.[0]?.id).toBe(
      parsed.commandBars?.[0]?.id,
    );
  });

  it('converts Send String buttons and explains what cannot be carried over', () => {
    const [junos, tools] = parseSecureCrtSessions(BAR_EXPORT).commandBars ?? [];

    expect(junos?.buttons).toEqual([
      {
        label: 'show config',
        command: 'show config | display set | match ',
        sendEnter: false,
        warnings: [],
      },
      {
        label: 'Disable',
        command: 'deactivate term A\\n\ndeactivate term B\\n',
        sendEnter: false,
        warnings: [],
      },
      {
        label: 'enable',
        command: 'ena\nSECRET',
        sendEnter: true,
        warnings: ['One-second pauses (\\p) were removed'],
      },
    ]);
    expect(junos?.skipped).toEqual([
      {
        label: 'Highlight on/off',
        reason: 'Menu function MENU_TOGGLE_KEYWORD_HIGHLIGHTING has no Muxus equivalent',
      },
    ]);
    expect(tools?.buttons).toEqual([
      {
        label: 'echo',
        command: 'echo a,b',
        sendEnter: true,
        warnings: ['The command contains commas; check that the label was read correctly'],
      },
    ]);
  });

  it('writes Telnet hosts and bar links into the portable restore format', () => {
    const parsed = parseSecureCrtSessions(BAR_EXPORT);
    const barId = parsed.commandBars?.[0]?.id;
    const portable = secureCrtConnections(parsed.sessions, 'muxus');

    expect(portable.savedHosts).toEqual([
      expect.objectContaining({
        name: 'PE1',
        metadata: { group: 'Edge', commandButtonGroup: barId },
      }),
      {
        id: expect.stringMatching(/^securecrt-telnet-/),
        name: 'Looking glass',
        profile: { kind: 'telnet', host: 'lg.example.test', port: 2323 },
        metadata: { group: 'Edge' },
      },
    ]);
    expect(JSON.stringify(portable)).not.toContain('encrypted-step');
  });

  it('accepts an export that only carries button bars', () => {
    const parsed = parseSecureCrtSessions(
      '<VanDyke><key name="ButtonBarV5"><array name="Only"><string>SEND,uptime\\r,up,,,0,1,</string></array></key></VanDyke>',
    );
    expect(parsed.sessions).toEqual([]);
    expect(parsed.commandBars?.[0]?.buttons).toEqual([
      { label: 'up', command: 'uptime', sendEnter: true, warnings: [] },
    ]);
  });
});

describe('SecureCRT Send String conversion', () => {
  it('expands control escapes, octal codes and literal backslashes', () => {
    expect(secureCrtSendString(String.raw`a\tb\ec\bd\134e\\f\r\n`)).toEqual({
      command: 'a\tb\u001bc\bd\\e\\f',
      sendEnter: true,
      warnings: [],
    });
    expect(secureCrtSendString(String.raw`one\rtwo\r`)).toEqual({
      command: 'one\ntwo',
      sendEnter: true,
      warnings: [],
    });
  });

  it('drops client placeholders, clipboard paste and unknown escapes with a warning', () => {
    expect(secureCrtSendString(String.raw`\u@\c \v\q`)).toEqual({
      command: '@ ',
      sendEnter: false,
      warnings: [
        'The session username placeholder (\\u) was removed',
        'The computer name placeholder (\\c) was removed',
        'Clipboard paste (\\v) was removed',
        'Unknown escape \\q was removed',
      ],
    });
  });

  it('rejects malformed and empty buttons', () => {
    expect(parseSecureCrtButton('SEND,only two')).toEqual({
      label: 'SEND',
      reason: 'Unrecognized button format',
    });
    expect(parseSecureCrtButton('SEND,,blank,,,0,1,')).toEqual({
      label: 'blank',
      reason: 'Button sends nothing',
    });
    expect(parseSecureCrtButton('RUN_SCRIPT,/tmp/x.py,run,,,0,1,')).toEqual({
      label: 'run',
      reason: '“RUN_SCRIPT” buttons are not supported',
    });
  });
});
