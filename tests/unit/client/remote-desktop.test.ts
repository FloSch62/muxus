import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SavedHostProfile } from '@muxus/shared';
import {
  blankDesktopDraft,
  desktopDraftFromProfile,
  desktopDraftMetadataPatch,
  desktopDraftProblem,
  desktopDraftToInput,
} from '../../../client/src/components/host-editor/desktop-draft.js';
import { IronErrorKind } from '../../../client/src/remote-desktop/ironrdp.js';
import {
  describeRdpError,
  rdpDesktopSize,
  rdpLogon,
} from '../../../client/src/remote-desktop/rdp-client.js';
import { scancodeForCode } from '../../../client/src/remote-desktop/scancodes.js';
import { describeVncFailure, vncServerKey } from '../../../client/src/remote-desktop/vnc-client.js';
import { savedHostAddress } from '../../../client/src/saved-hosts.js';
import { managedHostCopyCommand } from '../../../client/src/managed-hosts.js';
import { decodeAppWindowLaunch, encodeAppWindowLaunch } from '../../../client/src/window-management.js';

const metadata = { profileId: 'x', connectCount: 0 };

const rdpHost: SavedHostProfile = {
  id: 'rdp-build',
  kind: 'rdp',
  name: 'Build server',
  profile: {
    kind: 'rdp',
    profileId: 'rdp-build',
    host: 'win-build',
    port: 3389,
    username: 'ci',
    domain: 'CORP',
    sshGateway: { target: 'bastion' },
    shareClipboard: false,
  },
  metadata: { ...metadata, profileId: 'rdp-build', group: 'Windows', color: '#4488ff' },
  createdAt: '',
  updatedAt: '',
};

const vncHost: SavedHostProfile = {
  id: 'vnc-lab',
  kind: 'vnc',
  name: 'Lab console',
  profile: { kind: 'vnc', profileId: 'vnc-lab', host: 'lab-vm', port: 5901, viewOnly: true, resizeRemote: true },
  metadata: { ...metadata, profileId: 'vnc-lab' },
  createdAt: '',
  updatedAt: '',
};

/** Stand-in for IronRDP's error object. */
function ironError(kind: IronErrorKind, trace: string, details?: Record<string, number | undefined>) {
  return {
    kind: () => kind,
    backtrace: () => trace,
    rdcleanpathDetails: () => details,
  };
}

describe('RDP/VNC host editor draft', () => {
  it('prefills from a quick-connect target and follows the protocol default port', () => {
    const draft = blankDesktopDraft('admin@win-01:3390', 'Lab');
    expect(draft).toMatchObject({ host: 'win-01', port: '3390', username: 'admin', group: 'Lab', shareClipboard: true });
    const plain = { ...blankDesktopDraft('win-01'), name: 'Win' };
    expect(desktopDraftToInput(plain, 'rdp').profile).toMatchObject({ port: 3389 });
    expect(desktopDraftToInput(plain, 'vnc').profile).toMatchObject({ port: 5900 });
  });

  it('round-trips a saved RDP host, keeping only set options', () => {
    const draft = desktopDraftFromProfile(rdpHost, false);
    expect(draft).toMatchObject({ port: '', username: 'ci', domain: 'CORP', shareClipboard: false, group: 'Windows' });
    expect(desktopDraftToInput(draft, 'rdp', rdpHost.id)).toEqual({
      id: 'rdp-build',
      name: 'Build server',
      profile: {
        kind: 'rdp',
        host: 'win-build',
        port: 3389,
        username: 'ci',
        domain: 'CORP',
        sshGateway: { target: 'bastion' },
        shareClipboard: false,
      },
    });
    expect(desktopDraftMetadataPatch(draft)).toEqual({ group: 'Windows', color: '#4488ff' });
    expect(desktopDraftFromProfile(rdpHost, true).name).toBe('Build server copy');
  });

  it('keeps VNC-only options off RDP hosts', () => {
    const draft = desktopDraftFromProfile(vncHost, false);
    expect(desktopDraftToInput(draft, 'vnc').profile).toEqual({
      kind: 'vnc',
      host: 'lab-vm',
      port: 5901,
      resizeRemote: true,
      viewOnly: true,
    });
    expect(desktopDraftToInput({ ...draft, domain: 'IGNORED' }, 'rdp').profile).not.toHaveProperty('viewOnly');
  });

  it('validates the fields a connection needs', () => {
    const draft = { ...blankDesktopDraft(), name: 'X', host: 'h' };
    expect(desktopDraftProblem({ ...draft, name: ' ' }, 'rdp')).toMatch(/name/);
    expect(desktopDraftProblem({ ...draft, host: '' }, 'rdp')).toMatch(/hostname/);
    expect(desktopDraftProblem({ ...draft, host: 'a b' }, 'rdp')).toMatch(/spaces/);
    expect(desktopDraftProblem({ ...draft, port: '70000' }, 'vnc')).toMatch(/Port/);
    expect(desktopDraftProblem(draft, 'vnc')).toBeNull();
  });
});

describe('RDP client helpers', () => {
  it('asks the server for sizes display control accepts', () => {
    expect(rdpDesktopSize(1153.7, 807.2)).toEqual({ width: 1152, height: 807 });
    expect(rdpDesktopSize(120, 90)).toEqual({ width: 200, height: 200 });
    expect(rdpDesktopSize(9000, 9000)).toEqual({ width: 8192, height: 8192 });
  });

  it('splits DOMAIN\\user unless a domain is configured', () => {
    expect(rdpLogon('CORP\\alice', undefined)).toEqual({ username: 'alice', domain: 'CORP' });
    expect(rdpLogon('CORP\\alice', 'OTHER')).toEqual({ username: 'CORP\\alice', domain: 'OTHER' });
    expect(rdpLogon('alice@corp.example', undefined)).toEqual({ username: 'alice@corp.example', domain: '' });
  });

  it('turns IronRDP errors into messages and retry decisions', () => {
    expect(describeRdpError(ironError(IronErrorKind.WrongPassword, 'x'))).toMatchObject({ kind: 'credentials' });
    expect(describeRdpError(ironError(IronErrorKind.LogonFailure, 'x')).kind).toBe('credentials');
    // FreeRDP and GNOME Remote Desktop reject NLA with a bare CredSSP status.
    expect(
      describeRdpError(ironError(IronErrorKind.General, '[CredSSP] CredSSP: InvalidToken: status 0xc00700ea')).kind,
    ).toBe('credentials');
    expect(describeRdpError(ironError(IronErrorKind.RDCleanPath, '', { wsaErrorCode: 10061 })).message).toMatch(
      /refused the connection/,
    );
    expect(describeRdpError(ironError(IronErrorKind.RDCleanPath, '', { httpStatusCode: 403 }))).toMatchObject({
      kind: 'refused',
      message: 'The server certificate was not trusted.',
    });
    expect(
      describeRdpError(ironError(IronErrorKind.NegotiationFailure, 'negotiation: HYBRID_REQUIRED_BY_SERVER')).message,
    ).toMatch(/Network Level Authentication/);
    expect(
      describeRdpError(ironError(IronErrorKind.General, 'read frame: WebSocket Closed: code: 1005')).message,
    ).toBe('The connection to the remote computer was lost.');
    expect(describeRdpError(new Error('plain failure'))).toMatchObject({ kind: 'failed', message: 'plain failure' });
  });

  it('maps physical keys to set-1 scancodes', () => {
    expect(scancodeForCode('KeyA')).toBe(0x1e);
    expect(scancodeForCode('ControlRight')).toBe(0xe01d);
    expect(scancodeForCode('NumLock')).toBe(0xe045);
    expect(scancodeForCode('Unidentified')).toBeUndefined();
  });
});

describe('VNC failures', () => {
  it('explains what noVNC only logs', () => {
    expect(describeVncFailure('RFB failure: Unsupported security types (types: 19)')).toMatch(/no sign-in method/);
    expect(
      describeVncFailure('Failed when connecting: Connection closed (code: 1011, reason: The host name could not be resolved.)'),
    ).toBe('The host name could not be resolved.');
    expect(describeVncFailure(undefined)).toBeUndefined();
  });
});

describe('VNC server keys', () => {
  it('fingerprint the key the way it was sent, with the signature VNC servers show', async () => {
    // RSA-AES sends the key length in bits, then modulus and exponent padded to the key size.
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const n = Buffer.from(jwk.n!, 'base64url');
    const e = Buffer.alloc(n.length);
    Buffer.from(jwk.e!, 'base64url').copy(e, n.length - 3);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(2048);
    const sent = Buffer.concat([length, n, e]);

    const key = await vncServerKey(new Uint8Array(sent));
    const sha1 = createHash('sha1').update(sent).digest('hex');
    expect(key).toEqual({
      bits: 2048,
      fingerprint: createHash('sha256').update(sent).digest('hex').toUpperCase().match(/../g)!.join(':'),
      signature: sha1.slice(0, 16).match(/../g)!.join('-'),
    });
    // The same shape the backend accepts.
    expect(key.fingerprint).toMatch(/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/);
    expect(key.signature).toMatch(/^[0-9a-f]{2}(?:-[0-9a-f]{2}){7}$/);
  });

  it('read the key length from a view into a larger buffer', async () => {
    const backing = new Uint8Array(16).fill(0xff);
    backing.set([0, 0, 4, 0], 4);
    expect((await vncServerKey(backing.subarray(4, 12))).bits).toBe(1024);
  });
});

describe('RDP and VNC hosts in lists and windows', () => {
  it('shows the logon, address and gateway', () => {
    expect(savedHostAddress(rdpHost)).toBe('ci@win-build:3389 via bastion');
    expect(savedHostAddress(vncHost)).toBe('lab-vm:5901');
    expect(managedHostCopyCommand({ kind: 'profile', entry: vncHost })).toEqual({
      label: 'Copy address',
      text: 'lab-vm:5901',
    });
  });

  it('opens desktop sessions in new windows', () => {
    const launch = { kind: 'session' as const, title: 'Build server', profile: rdpHost.profile };
    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(launch))).toEqual(launch);
    expect(
      decodeAppWindowLaunch(
        encodeAppWindowLaunch({ ...launch, profile: { ...rdpHost.profile, port: 0 } as never }),
      ),
    ).toBeUndefined();
  });
});
