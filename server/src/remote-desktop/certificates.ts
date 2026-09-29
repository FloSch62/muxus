import { isIP } from 'node:net';
import tls, { type DetailedPeerCertificate, type TLSSocket } from 'node:tls';
import type { DesktopCertificateChallenge } from '@muxus/shared';

/**
 * RDP servers almost always present self-signed certificates, so Muxus treats
 * them like SSH host keys: a certificate that chains to a trusted authority
 * and names the host is accepted silently; anything else is shown once and
 * pinned by fingerprint (trust on first use), and a later change is flagged.
 */

export interface PresentedCertificate {
  /** Leaf first, as DER, for the RDCleanPath response. */
  chain: Buffer[];
  /** Colon-separated SHA-256 of the leaf, the fingerprint that is pinned. */
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Set when the chain or the host name does not verify. */
  verificationError?: string;
}

let trustedAuthorities: string[] | undefined;

/** Bundled Mozilla roots plus the operating system's store (for AD CS-issued RDP certificates). */
export function trustedCertificateAuthorities(): string[] {
  if (!trustedAuthorities) {
    const roots = new Set<string>(tls.rootCertificates);
    try {
      for (const certificate of tls.getCACertificates('system')) roots.add(certificate);
    } catch {
      /* no readable system store; the bundled roots still apply */
    }
    trustedAuthorities = [...roots];
  }
  return trustedAuthorities;
}

/** SNI must be a DNS name; servers reached by address get none. */
export function serverName(host: string): string | undefined {
  const bare = host.replace(/^\[|\]$/g, '');
  return isIP(bare) ? undefined : bare;
}

function distinguishedName(name: Record<string, string | string[]> | undefined): string {
  if (!name) return '';
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`)
    .join(', ');
}

export function presentedCertificate(socket: TLSSocket, host: string): PresentedCertificate | undefined {
  const leaf = socket.getPeerCertificate(true);
  if (!leaf?.raw) return undefined;
  const chain: Buffer[] = [];
  const seen = new Set<string>();
  for (
    let certificate: DetailedPeerCertificate | undefined = leaf;
    certificate?.raw && !seen.has(certificate.fingerprint256);
    certificate = certificate.issuerCertificate
  ) {
    seen.add(certificate.fingerprint256);
    chain.push(certificate.raw);
  }
  let verificationError: string | undefined;
  if (!socket.authorized) {
    verificationError = String(socket.authorizationError ?? 'The certificate is not trusted.');
  } else {
    const identity = tls.checkServerIdentity(serverName(host) ?? host, leaf);
    if (identity) verificationError = identity.message;
  }
  return {
    chain,
    fingerprint: leaf.fingerprint256,
    subject: distinguishedName(leaf.subject as unknown as Record<string, string | string[]>),
    issuer: distinguishedName(leaf.issuer as unknown as Record<string, string | string[]>),
    validFrom: leaf.valid_from,
    validTo: leaf.valid_to,
    verificationError,
  };
}

/**
 * What the user must decide about a certificate, or undefined when it can be
 * used without asking: it verifies, or it is the one trusted before.
 */
export function certificateChallenge(
  certificate: PresentedCertificate,
  host: string,
  port: number,
  pinned: { fingerprint: string } | undefined,
): DesktopCertificateChallenge | undefined {
  if (!certificate.verificationError) return undefined;
  if (pinned?.fingerprint === certificate.fingerprint) return undefined;
  return {
    kind: 'certificate',
    host,
    port,
    fingerprint: certificate.fingerprint,
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    verificationError: certificate.verificationError,
    state: pinned ? 'mismatch' : 'new',
    previous: pinned?.fingerprint,
  };
}
