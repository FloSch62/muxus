import type { AddressInfo } from 'node:net';
import ssh2, { Server } from 'ssh2';
import { describe, expect, it } from 'vitest';
import {
  certificateAlgorithms,
  certificateMatchesKey,
  certificateRsaHash,
  isEncryptedKeyError,
  parseOpenSshCertificate,
  parseSshKey,
} from '../../../server/src/ssh/certificates.js';
import { SshTransport } from '../../../server/src/ssh/engine.js';

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

    expect(privateKey.keyType).toBe('ssh-ed25519');
    expect(certificateMatchesKey(certificate, privateKey)).toBe(true);
    expect(certificateAlgorithms(certificate)).toEqual([
      'ssh-ed25519-cert-v01@openssh.com',
    ]);
  });

  it('logs in with the certificate, signed by the key it certifies', async () => {
    const privateKey = parseSshKey(PRIVATE_KEY);
    const certificate = parseOpenSshCertificate(CERTIFICATE);
    if (privateKey instanceof Error || certificate instanceof Error) throw new Error('fixtures did not parse');

    // The server takes exactly this certificate, first asked about and then
    // signed for. Whether the signature holds is OpenSSH's to judge (see the
    // OpenSSH container tests): this server cannot check one made for a certificate.
    const offered: Array<{ algorithm: string; signed: boolean }> = [];
    const server = new Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, (connection) => {
      connection.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey' || !ctx.key.data.equals(certificate.publicBlob)) {
          return ctx.reject(['publickey']);
        }
        offered.push({ algorithm: ctx.key.algo, signed: !!ctx.signature });
        ctx.accept();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const transport = new SshTransport({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      verifyHostKey: async () => true,
    });
    try {
      await transport.connect();
      const outcome = await transport.authCertificate(
        'test',
        privateKey,
        certificate.publicBlob,
        certificateRsaHash(certificate.type),
      );
      expect(outcome.success).toBe(true);
      expect(offered).toEqual([
        { algorithm: 'ssh-ed25519-cert-v01@openssh.com', signed: false },
        { algorithm: 'ssh-ed25519-cert-v01@openssh.com', signed: true },
      ]);
    } finally {
      transport.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('names the RSA signature hash of each certificate algorithm', () => {
    expect(certificateRsaHash('rsa-sha2-512-cert-v01@openssh.com')).toBe('sha512');
    expect(certificateRsaHash('rsa-sha2-256-cert-v01@openssh.com')).toBe('sha256');
    expect(certificateRsaHash('ssh-rsa-cert-v01@openssh.com')).toBe('sha1');
    expect(certificateRsaHash('ssh-ed25519-cert-v01@openssh.com')).toBeUndefined();
  });

  it('rejects ordinary public keys as CertificateFile content', () => {
    expect(
      parseOpenSshCertificate(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpS4MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY=',
      ),
    ).toBeInstanceOf(Error);
  });
});

describe('private key files', () => {
  it('tells a key that is not one from a key that needs its passphrase', () => {
    const garbage = parseSshKey('not a key');
    expect(garbage).toBeInstanceOf(Error);
    expect(isEncryptedKeyError(garbage)).toBe(false);
    expect(isEncryptedKeyError(parseSshKey(PRIVATE_KEY))).toBe(false);
  });
});
