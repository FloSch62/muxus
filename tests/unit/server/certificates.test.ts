import { describe, expect, it } from 'vitest';
import {
  certificateAlgorithms,
  certificateMatchesKey,
  certifiedKey,
  parseOpenSshCertificate,
  parseSshKey,
} from '../../../server/src/ssh/certificates.js';

// Disposable fixture key and user certificate generated only for this test.
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCWM4w+ETsogYZIPXlSJWnKztCQuB+z4IAOiI2ASlUCDQAAAJiYvo8tmL6P
LQAAAAtzc2gtZWQyNTUxOQAAACCWM4w+ETsogYZIPXlSJWnKztCQuB+z4IAOiI2ASlUCDQ
AAAEB7Cv74aU1Jm9orbp5zddvlnDQYRBBOPf5Y2w9d1uvrbZYzjD4ROyiBhkg9eVIlacrO
0JC4H7PggA6IjYBKVQINAAAAE2Zsc2Nod2FyQEwtUEYzUlgyUEsBAg==
-----END OPENSSH PRIVATE KEY-----`;

const CERTIFICATE =
  'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIMyM6l98PC1DJXz+Dtxy+ONebgpvf/86/nS6ONte+yEXAAAAIJYzjD4ROyiBhkg9eVIlacrO0JC4H7PggA6IjYBKVQINAAAAAAAAAAAAAAABAAAABHRlc3QAAAAIAAAABHRlc3QAAAAAAAAAAP//////////AAAAAAAAAIIAAAAVcGVybWl0LVgxMS1mb3J3YXJkaW5nAAAAAAAAABdwZXJtaXQtYWdlbnQtZm9yd2FyZGluZwAAAAAAAAAWcGVybWl0LXBvcnQtZm9yd2FyZGluZwAAAAAAAAAKcGVybWl0LXB0eQAAAAAAAAAOcGVybWl0LXVzZXItcmMAAAAAAAAAAAAAADMAAAALc3NoLWVkMjU1MTkAAAAgfBX5rZtr934GOp8DZruJhxlEEDuv+RIkW05kWIBoSHcAAABTAAAAC3NzaC1lZDI1NTE5AAAAQO72lXABXCRMOLWJft3FZEg2BzuQ/VF2de09ZPci7i/oE/Z9cOoZj9RjAkfkltBo/aa0S47vjGsU1X+Y9fzEKQc= test';

describe('OpenSSH user certificates', () => {
  it('pairs a CertificateFile with its IdentityFile private key', () => {
    const privateKey = parseSshKey(PRIVATE_KEY);
    const certificate = parseOpenSshCertificate(CERTIFICATE);
    expect(privateKey).not.toBeInstanceOf(Error);
    expect(certificate).not.toBeInstanceOf(Error);
    if (privateKey instanceof Error || certificate instanceof Error) return;

    expect(certificateMatchesKey(certificate, privateKey)).toBe(true);
    expect(certificateAlgorithms(certificate)).toEqual([
      'ssh-ed25519-cert-v01@openssh.com',
    ]);

    const combined = certifiedKey(
      privateKey,
      certificate,
      certificateAlgorithms(certificate)[0]!,
    );
    expect(combined).not.toBeInstanceOf(Error);
    if (combined instanceof Error) return;
    expect(combined.isPrivateKey()).toBe(true);
    expect(combined.getPublicSSH()).toEqual(certificate.publicBlob);
    expect((combined as unknown as { type: string }).type).toBe(certificate.type);

    const payload = Buffer.from('certificate authentication payload');
    expect(privateKey.verify(payload, combined.sign(payload))).toBe(true);
  });

  it('rejects ordinary public keys as CertificateFile content', () => {
    expect(
      parseOpenSshCertificate(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpS4MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY=',
      ),
    ).toBeInstanceOf(Error);
  });
});
