import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../.local/apple-signing/', import.meta.url));
const file = (name) => path.join(directory, name);
const openssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
const save = (name, bytes) => writeFileSync(file(name), bytes, { mode: 0o600, flag: 'wx' });
const password = () => `${randomBytes(32).toString('hex')}\n`;
const [command, certificatePath] = process.argv.slice(2);

switch (command) {
  case 'csr': {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    assert.ok(!existsSync(file('private-key.password')), 'Signing assets already exist; reuse the existing CSR and key.');
    save('private-key.password', password());
    save('developer-id.key.pem', openssl('genrsa', '-aes256', '-passout', `file:${file('private-key.password')}`, '2048'));
    save('Muxus.certSigningRequest', openssl('req', '-new', '-sha256', '-key', file('developer-id.key.pem'),
      '-passin', `file:${file('private-key.password')}`, '-subj', '/CN=Florian Schwarz/emailAddress=schwarz.flori.88@googlemail.com'));
    openssl('req', '-in', file('Muxus.certSigningRequest'), '-verify', '-noout');
    console.log(`Upload this CSR to Apple: ${file('Muxus.certSigningRequest')}`);
    break;
  }
  case 'export': {
    assert.ok(certificatePath, 'Usage: node hack/apple-signing.mjs export /path/to/developerID_application.cer');
    const certificate = new X509Certificate(readFileSync(certificatePath));
    assert.ok(certificate.subject.split('\n').includes('OU=DJY795VD98'), 'Certificate belongs to a different Apple team');
    assert.ok(certificate.subject.split('\n').includes('CN=Developer ID Application: Florian Schwarz (DJY795VD98)'), 'Expected a Developer ID Application certificate');
    assert.ok(Date.parse(certificate.validFrom) <= Date.now() && Date.now() < Date.parse(certificate.validTo), 'Certificate is not currently valid');
    const privateKey = createPrivateKey({ key: readFileSync(file('developer-id.key.pem')), passphrase: readFileSync(file('private-key.password'), 'utf8').trim() });
    assert.deepEqual(certificate.publicKey.export({ type: 'spki', format: 'der' }), createPublicKey(privateKey).export({ type: 'spki', format: 'der' }), 'Certificate does not match the CSR private key');
    assert.ok(!existsSync(file('developer-id.p12')), 'The exported identity already exists');
    save('developer-id.certificate.pem', certificate.toString());
    save('certificate.password', password());
    // Explicit algorithms keep OpenSSL 3 exports compatible with macOS Keychain.
    save('developer-id.p12', openssl('pkcs12', '-export', '-inkey', file('developer-id.key.pem'),
      '-passin', `file:${file('private-key.password')}`, '-in', file('developer-id.certificate.pem'),
      '-passout', `file:${file('certificate.password')}`, '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'));
    console.log(`Exported encrypted signing identity: ${file('developer-id.p12')}`);
    break;
  }
  case 'upload': {
    // Pass secret values over stdin, never through shell arguments or logs.
    const p12 = readFileSync(file('developer-id.p12')).toString('base64');
    const passphrase = readFileSync(file('certificate.password'), 'utf8').trim();
    for (const [name, input] of [['APPLE_CERTIFICATE_P12_BASE64', p12], ['APPLE_CERTIFICATE_PASSWORD', passphrase]]) {
      execFileSync('gh', ['secret', 'set', name, '--repo', 'FloSch62/muxus'], { input, stdio: ['pipe', 'inherit', 'inherit'] });
    }
    console.log('Uploaded both certificate secrets to FloSch62/muxus.');
    break;
  }
  default:
    throw new Error('Usage: node hack/apple-signing.mjs csr | export <certificate.cer> | upload');
}
