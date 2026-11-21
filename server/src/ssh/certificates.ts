import { parsePrivateKey, type SshPrivateKey } from './engine.js';

const CERT_TYPE_RE =
  /^(ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521))-cert-v0[01]@openssh\.com$/;

export interface OpenSshCertificate {
  source: Buffer;
  type: string;
  baseType: string;
  /** The certificate in SSH wire format, as it is offered to the server. */
  publicBlob: Buffer;
  keyFields: Buffer[];
}

/**
 * Parse a private key file (OpenSSH, PEM or PuTTY). A key that needs its
 * passphrase comes back as an error {@link isEncryptedKeyError} recognizes.
 */
export function parseSshKey(source: Buffer | string, passphrase?: string): SshPrivateKey | Error {
  try {
    return parsePrivateKey(Buffer.isBuffer(source) ? source : Buffer.from(source), passphrase);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** The key file is protected and was read without its passphrase. */
export function isEncryptedKeyError(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === 'KEY_ENCRYPTED';
}

interface SshField {
  value: Buffer;
  next: number;
}

function readSshField(data: Buffer, offset: number): SshField | undefined {
  if (offset < 0 || offset + 4 > data.length) return undefined;
  const length = data.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) return undefined;
  return { value: data.subarray(start, end), next: end };
}

function fieldCount(type: string): number | undefined {
  if (type === 'ssh-rsa') return 2;
  if (type === 'ssh-dss') return 4;
  if (type === 'ssh-ed25519') return 1;
  if (type.startsWith('ecdsa-sha2-')) return 2;
  return undefined;
}

function readKeyFields(
  blob: Buffer,
  expectedType: string,
  certificate: boolean,
): Buffer[] | undefined {
  const type = readSshField(blob, 0);
  if (!type || type.value.toString() !== expectedType) return undefined;
  let offset = type.next;
  if (certificate) {
    const nonce = readSshField(blob, offset);
    if (!nonce) return undefined;
    offset = nonce.next;
  }
  const count = fieldCount(
    certificate ? expectedType.replace(/-cert-v0[01]@openssh\.com$/, '') : expectedType,
  );
  if (count === undefined) return undefined;
  const fields: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const field = readSshField(blob, offset);
    if (!field) return undefined;
    fields.push(field.value);
    offset = field.next;
  }
  return fields;
}

/** Parse the public line written by ssh-keygen for an OpenSSH user certificate. */
export function parseOpenSshCertificate(
  source: Buffer | string,
): OpenSshCertificate | Error {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const line = bytes.toString('utf8').trim();
  const match = /^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(line);
  if (!match) return new Error('unsupported certificate format');
  const type = match[1] ?? '';
  const typeMatch = CERT_TYPE_RE.exec(type);
  if (!typeMatch) return new Error(`unsupported certificate type: ${type || 'unknown'}`);
  const publicBlob = Buffer.from(match[2] ?? '', 'base64');
  const keyFields = readKeyFields(publicBlob, type, true);
  if (!keyFields) return new Error('malformed OpenSSH certificate');

  return {
    source: bytes,
    type,
    baseType: typeMatch[1] ?? '',
    publicBlob,
    keyFields,
  };
}

/** True when a certificate contains the public half of this private key. */
export function certificateMatchesKey(
  certificate: OpenSshCertificate,
  privateKey: SshPrivateKey,
): boolean {
  const fields = readKeyFields(
    privateKey.publicBlob(),
    certificate.baseType,
    false,
  );
  return (
    fields?.length === certificate.keyFields.length
    && fields.every((field, i) => field.equals(certificate.keyFields[i]!))
  );
}

/** Authentication algorithm variants to try for this certificate. */
export function certificateAlgorithms(certificate: OpenSshCertificate): string[] {
  if (certificate.baseType !== 'ssh-rsa') return [certificate.type];
  const suffix = certificate.type.slice('ssh-rsa'.length);
  // Prefer SHA-2, as current OpenSSH disables ssh-rsa/SHA-1 by default, while
  // retaining the SHA-1 variant for older servers.
  return [
    `rsa-sha2-512${suffix}`,
    `rsa-sha2-256${suffix}`,
    certificate.type,
  ];
}

/**
 * The RSA signature hash an authentication algorithm of a certificate asks
 * for; undefined for every other key type, which has just the one.
 */
export function certificateRsaHash(algorithm: string): 'sha512' | 'sha256' | 'sha1' | undefined {
  if (algorithm.startsWith('rsa-sha2-512')) return 'sha512';
  if (algorithm.startsWith('rsa-sha2-256')) return 'sha256';
  if (algorithm.startsWith('ssh-rsa-')) return 'sha1';
  return undefined;
}
