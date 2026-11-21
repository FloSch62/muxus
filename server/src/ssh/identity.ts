/**
 * A public key or certificate as it is offered to a server: its SSH type
 * name and its wire-format blob. Agents list these; a private half that can
 * sign for one may be a key file, an agent or a security key.
 */
export interface SshIdentity {
  /** e.g. ssh-ed25519, ssh-rsa-cert-v01@openssh.com, sk-ssh-ed25519@openssh.com. */
  type: string;
  blob: Buffer;
  comment?: string;
}

/** The type name a wire-format blob starts with; undefined when it has none. */
export function blobType(blob: Buffer): string | undefined {
  if (blob.length < 4) return undefined;
  const end = 4 + blob.readUInt32BE(0);
  if (end > blob.length || end === 4) return undefined;
  return blob.toString('latin1', 4, end);
}

export function identityFromBlob(blob: Buffer, comment?: string): SshIdentity | undefined {
  const type = blobType(blob);
  return type ? { type, blob, ...(comment ? { comment } : {}) } : undefined;
}

const USABLE_TYPE_RE =
  /^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519|sk-ecdsa-sha2-nistp256)(?:-cert-v01)?(?:@openssh\.com)?$/;

/** Whether the SSH engine can offer an identity of this type to a server. */
export function isUsableIdentityType(type: string): boolean {
  return USABLE_TYPE_RE.test(type);
}

/** How an identity's private half is reached for the login: list what it holds, and sign. */
export interface SshAgent {
  identities(): Promise<SshIdentity[]>;
  /** The SSH signature blob for `data`; `hash` picks the RSA signature variant. */
  sign(identity: SshIdentity, data: Buffer, options?: SigningOptions): Promise<Buffer>;
}

export interface SigningOptions {
  hash?: 'sha256' | 'sha512';
}
