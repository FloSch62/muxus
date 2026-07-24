import ssh2, { type ParsedKey } from 'ssh2';

const { utils } = ssh2;

const CERT_TYPE_RE =
  /^(ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521))-cert-v0[01]@openssh\.com$/;

export interface OpenSshCertificate {
  source: Buffer;
  type: string;
  baseType: string;
  publicBlob: Buffer;
  keyFields: Buffer[];
}

/** Parse an SSH public/private key with ssh2's supported key formats. */
export function parseSshKey(
  source: Buffer | string | ParsedKey,
  passphrase?: Buffer | string,
): ParsedKey | Error {
  return utils.parseKey(source, passphrase);
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

  // ssh2 recognizes certificate objects internally, which lets them flow
  // through authHandler. Its public parser does not retain the complete
  // certificate blob, so the wrapper below replaces that accessor.
  const parsed = parseSshKey(bytes);
  if (parsed instanceof Error) return parsed;

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
  privateKey: ParsedKey,
): boolean {
  const fields = readKeyFields(
    privateKey.getPublicSSH(),
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

interface DerValue {
  value: Buffer;
  next: number;
}

function readDerValue(data: Buffer, offset: number, tag: number): DerValue | undefined {
  if (data[offset] !== tag || offset + 2 > data.length) return undefined;
  let length = data[offset + 1] ?? 0;
  let start = offset + 2;
  if ((length & 0x80) !== 0) {
    const width = length & 0x7f;
    if (width === 0 || width > 4 || start + width > data.length) return undefined;
    length = 0;
    for (let i = 0; i < width; i++) length = (length * 256) + (data[start + i] ?? 0);
    start += width;
  }
  const end = start + length;
  if (end > data.length) return undefined;
  return { value: data.subarray(start, end), next: end };
}

function sshField(value: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + value.length);
  out.writeUInt32BE(value.length, 0);
  value.copy(out, 4);
  return out;
}

/** Convert OpenSSL's DER ECDSA signature into SSH's pair of mpints. */
function ecdsaSignature(signature: Buffer): Buffer | Error {
  const sequence = readDerValue(signature, 0, 0x30);
  if (!sequence) return new Error('invalid ECDSA signature');
  const r = readDerValue(sequence.value, 0, 0x02);
  const s = r && readDerValue(sequence.value, r.next, 0x02);
  if (!r || !s || s.next !== sequence.value.length) {
    return new Error('invalid ECDSA signature');
  }
  return Buffer.concat([sshField(r.value), sshField(s.value)]);
}

function dsaSignature(signature: Buffer): Buffer | Error {
  if (signature.length === 40) return signature;
  const sequence = readDerValue(signature, 0, 0x30);
  if (!sequence) return new Error('invalid DSA signature');
  const r = readDerValue(sequence.value, 0, 0x02);
  const s = r && readDerValue(sequence.value, r.next, 0x02);
  if (!r || !s) return new Error('invalid DSA signature');
  const out = Buffer.alloc(40);
  r.value.subarray(Math.max(0, r.value.length - 20)).copy(
    out,
    Math.max(0, 20 - r.value.length),
  );
  s.value.subarray(Math.max(0, s.value.length - 20)).copy(
    out,
    20 + Math.max(0, 20 - s.value.length),
  );
  return out;
}

/**
 * Combine a public OpenSSH certificate with its private IdentityFile key.
 * ssh2 has no CertificateFile option, but its auth handler accepts a parsed
 * key object. Keeping ssh2's internal parsed-key marker while replacing the
 * public blob and signer gives it the exact certificate authentication shape.
 */
export function certifiedKey(
  privateKey: ParsedKey,
  certificate: OpenSshCertificate,
  algorithm: string,
): ParsedKey | Error {
  if (!certificateMatchesKey(certificate, privateKey)) {
    return new Error('certificate does not match private key');
  }
  if (!certificateAlgorithms(certificate).includes(algorithm)) {
    return new Error(`unsupported certificate algorithm: ${algorithm}`);
  }
  const parsed = parseSshKey(certificate.source);
  if (parsed instanceof Error) return parsed;

  const hash =
    algorithm.startsWith('rsa-sha2-512') ? 'sha512'
    : algorithm.startsWith('rsa-sha2-256') ? 'sha256'
    : algorithm.startsWith('ssh-rsa-') ? 'sha1'
    : undefined;
  const mutable = parsed as unknown as {
    type: string;
    sign(data: Buffer | string): Buffer | Error;
    verify: ParsedKey['verify'];
    isPrivateKey(): boolean;
    getPrivatePEM: ParsedKey['getPrivatePEM'];
    getPublicPEM: ParsedKey['getPublicPEM'];
    getPublicSSH(): Buffer;
    equals: ParsedKey['equals'];
  };
  mutable.type = algorithm;
  mutable.sign = (data) => {
    const signature = privateKey.sign(data, hash);
    if (certificate.baseType.startsWith('ecdsa-sha2-')) {
      return ecdsaSignature(signature);
    }
    if (certificate.baseType === 'ssh-dss') return dsaSignature(signature);
    return signature;
  };
  mutable.verify = privateKey.verify.bind(privateKey);
  mutable.isPrivateKey = () => true;
  mutable.getPrivatePEM = privateKey.getPrivatePEM.bind(privateKey);
  mutable.getPublicPEM = privateKey.getPublicPEM.bind(privateKey);
  mutable.getPublicSSH = () => certificate.publicBlob;
  mutable.equals = privateKey.equals.bind(privateKey);
  return parsed;
}
