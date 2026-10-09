import os from 'node:os';
import ssh2, { type ParsedKey } from 'ssh2';
import { fingerprintSha256 } from './known-hosts.js';

const { utils } = ssh2;

/**
 * FIDO2/U2F security keys (`ssh-keygen -t ed25519-sk`/`ecdsa-sk`): the
 * private key never leaves the authenticator, so every signature comes from
 * OpenSSH code that can talk to it — the user's ssh-agent, or for a key file
 * a private ssh-agent that Muxus runs just for the login.
 */
const SECURITY_KEY_TYPE_RE = /^(sk-ssh-ed25519|sk-ecdsa-sha2-nistp256)(-cert-v01)?@openssh\.com$/;

export function isSecurityKeyType(type: string): boolean {
  return SECURITY_KEY_TYPE_RE.test(type);
}

/** OpenSSH's short name for the key type, e.g. ED25519-SK or ECDSA-SK-CERT. */
export function securityKeyTypeName(type: string): string {
  const match = SECURITY_KEY_TYPE_RE.exec(type);
  if (!match) return type;
  return `${match[1] === 'sk-ssh-ed25519' ? 'ED25519-SK' : 'ECDSA-SK'}${match[2] ? '-CERT' : ''}`;
}

interface SshField {
  value: Buffer;
  next: number;
}

function readField(data: Buffer, offset: number): SshField | undefined {
  if (offset < 0 || offset + 4 > data.length) return undefined;
  const end = offset + 4 + data.readUInt32BE(offset);
  if (end > data.length) return undefined;
  return { value: data.subarray(offset + 4, end), next: end };
}

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const out = Buffer.allocUnsafe(4 + bytes.length);
  out.writeUInt32BE(bytes.length, 0);
  bytes.copy(out, 4);
  return out;
}

/** The plain key blob of a security key or of its certificate, as ssh-add -l fingerprints it. */
export function plainKeyBlob(blob: Buffer): Buffer {
  const type = readField(blob, 0);
  const match = type && SECURITY_KEY_TYPE_RE.exec(type.value.toString('latin1'));
  if (!type || !match?.[2]) return blob;
  const nonce = readField(blob, type.next);
  const count = match[1] === 'sk-ssh-ed25519' ? 2 : 3;
  const fields: Buffer[] = [];
  let offset = nonce?.next ?? -1;
  for (let i = 0; i < count; i++) {
    const field = readField(blob, offset);
    if (!field) return blob;
    fields.push(sshString(field.value));
    offset = field.next;
  }
  return Buffer.concat([sshString(`${match[1]}@openssh.com`), ...fields]);
}

/** "ED25519-SK SHA256:…", the way OpenSSH names a key when it asks for a touch. */
export function securityKeyLabel(key: ParsedKey): string {
  return `${securityKeyTypeName(key.type)} ${fingerprintSha256(plainKeyBlob(key.getPublicSSH()))}`;
}

/** The algorithm a signature was made with, as the server sees it. */
export function signatureAlgorithm(type: string, hash?: string): string {
  if (type !== 'ssh-rsa') return type;
  if (hash === 'sha256') return 'rsa-sha2-256';
  if (hash === 'sha512') return 'rsa-sha2-512';
  return type;
}

export interface OpenSshKeyFile {
  /** Key type of the public half, e.g. sk-ssh-ed25519@openssh.com. */
  type: string;
  publicBlob: Buffer;
  encrypted: boolean;
}

const OPENSSH_KEY_RE = /-----BEGIN OPENSSH PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END OPENSSH PRIVATE KEY-----/;
const OPENSSH_KEY_MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');

/**
 * The unencrypted header of an OpenSSH private key file: its public key and
 * whether a passphrase protects the private part. Readable without the
 * passphrase, which is how a security key file is recognized up front.
 */
export function readOpenSshKeyFile(content: Buffer | string): OpenSshKeyFile | undefined {
  const match = OPENSSH_KEY_RE.exec(content.toString());
  if (!match) return undefined;
  const data = Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'base64');
  if (!data.subarray(0, OPENSSH_KEY_MAGIC.length).equals(OPENSSH_KEY_MAGIC)) return undefined;
  const cipher = readField(data, OPENSSH_KEY_MAGIC.length);
  const kdf = cipher && readField(data, cipher.next);
  const kdfOptions = kdf && readField(data, kdf.next);
  if (!kdfOptions || kdfOptions.next + 4 > data.length) return undefined;
  if (data.readUInt32BE(kdfOptions.next) < 1) return undefined;
  const publicBlob = readField(data, kdfOptions.next + 4)?.value;
  const type = publicBlob && readField(publicBlob, 0)?.value.toString('latin1');
  if (!publicBlob || !type) return undefined;
  return { type, publicBlob, encrypted: cipher.value.toString('latin1') !== 'none' };
}

/** The public key of a security key file, or undefined for any other file. */
export function securityKeyFile(content: Buffer | string): ParsedKey | undefined {
  const header = readOpenSshKeyFile(content);
  if (!header || !isSecurityKeyType(header.type)) return undefined;
  const parsed = utils.parseKey(header.publicBlob);
  return parsed instanceof Error ? undefined : parsed;
}

/** A CertificateFile for a security key, or undefined for any other file. */
export function securityKeyCertificate(content: Buffer | string): ParsedKey | undefined {
  const [type] = content.toString().trim().split(/\s+/, 1);
  if (!type || !isSecurityKeyType(type) || !type.includes('-cert-')) return undefined;
  const parsed = utils.parseKey(content);
  return parsed instanceof Error ? undefined : parsed;
}

/**
 * A security key that could not sign. With `key` set, the message is the
 * agent's own reason; otherwise it already tells the user what to do.
 */
export class SecurityKeyError extends Error {
  constructor(
    message: string,
    readonly key?: ParsedKey,
  ) {
    super(message);
    this.name = 'SecurityKeyError';
  }
}

/** What went wrong with a security key during the login to `hop`, for the user. */
export function describeSecurityKeyError(err: SecurityKeyError, hop: string): string {
  if (!err.key) return err.message;
  const reason =
    err.message === 'Agent responded with failure'
      ? 'it was not touched in time, its PIN was not accepted, or it is not plugged in'
      : /did not respond/.test(err.message)
        ? 'the SSH agent did not answer in time'
        : err.message;
  return `the security key ${securityKeyLabel(err.key)} did not sign the login to ${hop}: ${reason}`;
}

/**
 * SecurityKeyProvider the way ssh(1) resolves it: the configured value, else
 * $SSH_SK_PROVIDER, else OpenSSH's built-in FIDO support (undefined).
 */
export function securityKeyProvider(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let value = configured ?? '$SSH_SK_PROVIDER';
  if (value.startsWith('$')) value = env[value.slice(1)] ?? '';
  value = value.replace(/^~(?=$|[\\/])/, os.homedir());
  return value && value.toLowerCase() !== 'internal' ? value : undefined;
}

export interface SecurityKeyQuestion {
  kind: 'passphrase' | 'pin' | 'other';
  /** OpenSSH rejected the previous passphrase. */
  retry: boolean;
  /** The authenticator also needs a touch once the PIN is in. */
  presence: boolean;
  /** OpenSSH's own prompt. */
  text: string;
}

const PIN_PROMPT_RE = /^Enter PIN( and confirm user presence)? for /;
const PASSPHRASE_PROMPT_RE = /^(Enter passphrase|Bad passphrase, try again) for /;

export function classifyAskpassPrompt(text: string): SecurityKeyQuestion {
  const trimmed = text.replace(/:\s*$/, '');
  const pin = PIN_PROMPT_RE.exec(trimmed);
  if (pin) return { kind: 'pin', retry: false, presence: !!pin[1], text: trimmed };
  const passphrase = PASSPHRASE_PROMPT_RE.exec(trimmed);
  if (passphrase) {
    return { kind: 'passphrase', retry: passphrase[1] !== 'Enter passphrase', presence: false, text: trimmed };
  }
  return { kind: 'other', retry: false, presence: false, text: trimmed };
}
