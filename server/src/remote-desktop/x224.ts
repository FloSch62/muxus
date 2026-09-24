/**
 * The two X.224 PDUs an RDP proxy must understand before TLS starts: the
 * client's Connection Request (relayed as-is) and the server's Connection
 * Confirm, whose RDP_NEG_RSP/RDP_NEG_FAILURE decides whether TLS follows.
 * Both travel in TPKT frames ([T.123]: version 3, reserved, u16 length).
 */

/** Selected-protocol flags from [MS-RDPBCGR] 2.2.1.2.1. */
export const PROTOCOL_RDP = 0;
export const PROTOCOL_SSL = 0x1;
export const PROTOCOL_HYBRID = 0x2;
export const PROTOCOL_RDSTLS = 0x4;
export const PROTOCOL_HYBRID_EX = 0x8;

/** The confirm is 19 bytes; allow room for servers that append more. */
export const X224_MAX_CONFIRM_BYTES = 512;

const TPKT_VERSION = 3;
const TPKT_HEADER_BYTES = 4;
const X224_CONNECTION_CONFIRM = 0xd0;
const TYPE_RDP_NEG_RSP = 0x02;
const TYPE_RDP_NEG_FAILURE = 0x03;

export type ConnectionConfirm =
  | { kind: 'response'; protocol: number }
  | { kind: 'failure'; code: number }
  /** No negotiation data: a legacy server that only speaks standard RDP security. */
  | { kind: 'legacy' };

/** Full TPKT frame length once the header is in, or undefined while it is not. */
export function tpktLength(buffer: Buffer): number | undefined {
  if (buffer.length < TPKT_HEADER_BYTES) return undefined;
  if (buffer[0] !== TPKT_VERSION) throw new Error('the server did not answer with an RDP (TPKT) frame');
  const length = buffer.readUInt16BE(2);
  if (length < TPKT_HEADER_BYTES + 7) throw new Error('the server sent a truncated X.224 frame');
  return length;
}

export function parseConnectionConfirm(frame: Buffer): ConnectionConfirm {
  // TPKT header, then X.224: length indicator, CC code, dst-ref, src-ref, class.
  const x224 = frame.subarray(TPKT_HEADER_BYTES);
  if ((x224[1]! & 0xf0) !== X224_CONNECTION_CONFIRM) {
    throw new Error('the server did not confirm the RDP connection');
  }
  const negotiation = x224.subarray(7);
  if (negotiation.length < 8) return { kind: 'legacy' };
  const type = negotiation[0];
  const value = negotiation.readUInt32LE(4);
  if (type === TYPE_RDP_NEG_RSP) return { kind: 'response', protocol: value };
  if (type === TYPE_RDP_NEG_FAILURE) return { kind: 'failure', code: value };
  throw new Error(`unknown RDP negotiation response type ${type}`);
}

/** Readable reasons for RDP_NEG_FAILURE codes ([MS-RDPBCGR] 2.2.1.2.2). */
export function negotiationFailureMessage(code: number): string {
  switch (code) {
    case 1:
      return 'The server requires TLS, which it cannot offer (SSL_REQUIRED_BY_SERVER).';
    case 2:
      return 'The server does not allow TLS (SSL_NOT_ALLOWED_BY_SERVER).';
    case 3:
      return 'The server has no certificate for TLS (SSL_CERT_NOT_ON_SERVER).';
    case 4:
      return 'The server rejected the security settings (INCONSISTENT_FLAGS).';
    case 5:
      return 'The server requires Network Level Authentication (HYBRID_REQUIRED_BY_SERVER).';
    case 6:
      return 'The server requires TLS with user authentication (SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER).';
    default:
      return `The server refused the connection (negotiation failure ${code}).`;
  }
}
