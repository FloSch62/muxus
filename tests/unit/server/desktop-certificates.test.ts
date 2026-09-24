import { describe, expect, it } from 'vitest';
import {
  certificateChallenge,
  serverName,
  type PresentedCertificate,
} from '../../../server/src/remote-desktop/certificates.js';
import {
  desktopPasswordAccount,
  desktopPasswordLabel,
  sshPasswordAccount,
} from '../../../server/src/security/password-vault.js';

const selfSigned: PresentedCertificate = {
  chain: [Buffer.from('leaf')],
  fingerprint: 'AA:BB',
  subject: 'CN=win-build',
  issuer: 'CN=win-build',
  validFrom: 'Jan  1 00:00:00 2026 GMT',
  validTo: 'Jan  1 00:00:00 2027 GMT',
  verificationError: 'self-signed certificate',
};

describe('RDP certificate trust', () => {
  it('accepts a certificate that verifies without asking', () => {
    expect(certificateChallenge({ ...selfSigned, verificationError: undefined }, 'win-build', 3389, undefined)).toBeUndefined();
  });

  it('asks about an unknown self-signed certificate', () => {
    expect(certificateChallenge(selfSigned, 'win-build', 3389, undefined)).toMatchObject({
      state: 'new',
      fingerprint: 'AA:BB',
      verificationError: 'self-signed certificate',
    });
  });

  it('accepts the pinned certificate and warns when it changed', () => {
    expect(certificateChallenge(selfSigned, 'win-build', 3389, { fingerprint: 'AA:BB' })).toBeUndefined();
    expect(certificateChallenge(selfSigned, 'win-build', 3389, { fingerprint: 'CC:DD' })).toMatchObject({
      state: 'mismatch',
      previous: 'CC:DD',
    });
  });

  it('sends SNI only for host names', () => {
    expect(serverName('win-build.example.com')).toBe('win-build.example.com');
    expect(serverName('192.0.2.10')).toBeUndefined();
    expect(serverName('[2001:db8::1]')).toBeUndefined();
  });
});

describe('desktop passwords in the vault', () => {
  const input = { user: 'admin', host: 'Server.Example', port: 3389, gateway: '', domain: '' };

  it('never share an account with SSH passwords', () => {
    const rdp = desktopPasswordAccount({ protocol: 'rdp', ...input });
    expect(rdp).not.toBe(desktopPasswordAccount({ protocol: 'vnc', ...input }));
    expect(rdp).not.toBe(sshPasswordAccount(input));
    expect(rdp).toBe(desktopPasswordAccount({ protocol: 'rdp', ...input, host: 'server.example' }));
    expect(desktopPasswordLabel({ protocol: 'rdp', ...input })).toBe('RDP admin@Server.Example:3389');
    expect(desktopPasswordLabel({ protocol: 'vnc', ...input, user: '', host: 'lab', port: 5901 })).toBe(
      'VNC lab:5901',
    );
  });

  it('keep the same address behind different gateways apart', () => {
    const local = { protocol: 'vnc' as const, ...input, user: '', host: 'localhost', port: 5900 };
    const direct = desktopPasswordAccount(local);
    const viaAlias = desktopPasswordAccount({ ...local, gateway: 'ssh:bastion' });
    const viaSaved = desktopPasswordAccount({ ...local, gateway: 'profile:host-1' });
    expect(new Set([direct, viaAlias, viaSaved]).size).toBe(3);
    // The label names the gateway the way the host editor shows it.
    expect(
      desktopPasswordLabel({ ...local, gateway: 'profile:host-1', gatewayLabel: 'ops@bastion' }),
    ).toBe('VNC localhost:5900 via ops@bastion');
  });

  it('keep the same RDP user in different domains apart', () => {
    const plain = desktopPasswordAccount({ protocol: 'rdp', ...input });
    const corp = desktopPasswordAccount({ protocol: 'rdp', ...input, domain: 'CORP' });
    const lab = desktopPasswordAccount({ protocol: 'rdp', ...input, domain: 'LAB' });
    expect(new Set([plain, corp, lab]).size).toBe(3);
    // Windows domain names ignore case.
    expect(corp).toBe(desktopPasswordAccount({ protocol: 'rdp', ...input, domain: 'corp' }));
    expect(desktopPasswordLabel({ protocol: 'rdp', ...input, domain: 'CORP' })).toBe(
      'RDP CORP\\admin@Server.Example:3389',
    );
  });
});
