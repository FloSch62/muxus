import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import {
  MAX_SECURECRT_IMPORT_BYTES,
  parseSecureCrtSessions,
  secureCrtConnections,
} from '../../../client/src/securecrt-import.js';

const NativeDomParser = globalThis.DOMParser;

beforeAll(() => {
  class StrictTestDomParser {
    parseFromString(text: string, mimeType: DOMParserSupportedType): Document {
      let failed = false;
      const parser = new XmlDomParser({
        errorHandler: {
          warning: () => {
            failed = true;
          },
          error: () => {
            failed = true;
          },
          fatalError: () => {
            failed = true;
          },
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
    expect(() => parseSecureCrtSessions('<VanDyke/>')).toThrow(/Sessions section/);
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
    ).toThrow(/No supported SSH or serial sessions/);
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
