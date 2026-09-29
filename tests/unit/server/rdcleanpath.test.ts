import { describe, expect, it } from 'vitest';
import {
  RDCLEANPATH_GENERAL_ERROR,
  RDCLEANPATH_NEGOTIATION_ERROR,
  RDCleanPathDecodeError,
  decodeRDCleanPathRequest,
  encodeRDCleanPathError,
  encodeRDCleanPathNegotiationError,
  encodeRDCleanPathResponse,
  rdCleanPathPduLength,
} from '../../../server/src/remote-desktop/rdcleanpath.js';
import {
  negotiationFailureMessage,
  parseConnectionConfirm,
  tpktLength,
} from '../../../server/src/remote-desktop/x224.js';

/** A request exactly as IronRDP's web client (ironrdp-rdcleanpath) encodes it. */
const IRONRDP_REQUEST = Buffer.from(
  '3056a00402020d3ea2110c0f3132372e302e302e313a3133333930a30c0c0a7469636b65742d313233' +
    'a62d042b0300002b26e00000000000436f6f6b69653a206d737473686173683d6d757875730d0a010008000b000000',
  'hex',
);
const X224_REQUEST = IRONRDP_REQUEST.subarray(IRONRDP_REQUEST.length - 43);

/** Just enough DER to walk a response in the tests without trusting the encoder. */
function tlv(buffer: Buffer, offset = 0): { tag: number; value: Buffer; end: number } {
  const tag = buffer[offset]!;
  let length = buffer[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[start + i]!;
    start += count;
  }
  return { tag, value: buffer.subarray(start, start + length), end: start + length };
}

/** Explicitly tagged fields of a SEQUENCE's contents: tag number → inner value. */
function explicitFields(contents: Buffer): Map<number, Buffer> {
  const result = new Map<number, Buffer>();
  for (let offset = 0; offset < contents.length; ) {
    const field = tlv(contents, offset);
    result.set(field.tag & 0x1f, tlv(field.value).value);
    offset = field.end;
  }
  return result;
}

function fields(pdu: Buffer): Map<number, Buffer> {
  const outer = tlv(pdu);
  expect(outer.tag).toBe(0x30);
  expect(outer.end).toBe(pdu.length);
  return explicitFields(outer.value);
}

describe('RDCleanPath', () => {
  it('decodes the request IronRDP sends', () => {
    expect(rdCleanPathPduLength(IRONRDP_REQUEST)).toBe(IRONRDP_REQUEST.length);
    expect(decodeRDCleanPathRequest(IRONRDP_REQUEST)).toEqual({
      destination: '127.0.0.1:13390',
      proxyAuth: 'ticket-123',
      serverAuth: undefined,
      preconnectionBlob: undefined,
      x224ConnectionPdu: X224_REQUEST,
    });
  });

  it('knows the full length once the header has arrived', () => {
    expect(rdCleanPathPduLength(IRONRDP_REQUEST.subarray(0, 1))).toBeUndefined();
    expect(rdCleanPathPduLength(IRONRDP_REQUEST.subarray(0, 2))).toBe(IRONRDP_REQUEST.length);
    expect(() => rdCleanPathPduLength(Buffer.from([0x04, 0x01]))).toThrow(RDCleanPathDecodeError);
  });

  it('rejects truncated, unversioned or proxy-only fields', () => {
    expect(() => decodeRDCleanPathRequest(IRONRDP_REQUEST.subarray(0, 40))).toThrow(RDCleanPathDecodeError);
    const wrongVersion = Buffer.from(IRONRDP_REQUEST);
    wrongVersion[7] = 0x3f; // 3391
    expect(() => decodeRDCleanPathRequest(wrongVersion)).toThrow(/version 3391/);
    // A response (server address field [9]) is never a valid request.
    expect(() =>
      decodeRDCleanPathRequest(encodeRDCleanPathResponse('10.0.0.1:3389', Buffer.from([3, 0, 0, 11]), [])),
    ).toThrow(RDCleanPathDecodeError);
  });

  it('encodes a response with the X.224 confirm and leaf-first certificate chain', () => {
    const confirm = Buffer.from('030000130ed000001234000201080001000000', 'hex');
    const leaf = Buffer.alloc(300, 0xaa);
    const issuer = Buffer.alloc(20, 0xbb);
    const pdu = encodeRDCleanPathResponse('192.0.2.7:3389', confirm, [leaf, issuer]);
    const decoded = fields(pdu);
    expect(decoded.get(0)).toEqual(Buffer.from([0x0d, 0x3e]));
    expect(decoded.get(6)).toEqual(confirm);
    expect(decoded.get(9)?.toString('utf8')).toBe('192.0.2.7:3389');
    const chain = decoded.get(7)!;
    const first = tlv(chain);
    const second = tlv(chain, first.end);
    expect([first.value, second.value]).toEqual([leaf, issuer]);
  });

  it('encodes proxy errors and negotiation failures', () => {
    const http = explicitFields(
      fields(encodeRDCleanPathError({ errorCode: RDCLEANPATH_GENERAL_ERROR, httpStatusCode: 403 })).get(1)!,
    );
    expect(http.get(0)).toEqual(Buffer.from([RDCLEANPATH_GENERAL_ERROR]));
    expect(http.get(1)).toEqual(Buffer.from([0x01, 0x93]));
    // Unsigned integers with the top bit set keep a leading zero byte.
    const wsa = explicitFields(
      fields(encodeRDCleanPathError({ errorCode: RDCLEANPATH_GENERAL_ERROR, wsaLastError: 0x8000 })).get(1)!,
    );
    expect(wsa.get(2)).toEqual(Buffer.from([0x00, 0x80, 0x00]));
    const failure = Buffer.from('030000130ed000000000000300080005000000', 'hex');
    const negotiation = fields(encodeRDCleanPathNegotiationError(failure));
    expect(negotiation.get(6)).toEqual(failure);
    expect(explicitFields(negotiation.get(1)!).get(0)).toEqual(Buffer.from([RDCLEANPATH_NEGOTIATION_ERROR]));
  });
});

describe('X.224 connection confirm', () => {
  it('reads the protocol xrdp and FreeRDP select', () => {
    const xrdp = Buffer.from('030000130ed000001234000201080001000000', 'hex');
    const nla = Buffer.from('030000130ed000000000000203080002000000', 'hex');
    expect(tpktLength(xrdp)).toBe(19);
    expect(parseConnectionConfirm(xrdp)).toEqual({ kind: 'response', protocol: 1 });
    expect(parseConnectionConfirm(nla)).toEqual({ kind: 'response', protocol: 2 });
  });

  it('reports refusals and legacy servers', () => {
    const failure = Buffer.from('030000130ed000000000000300080005000000', 'hex');
    expect(parseConnectionConfirm(failure)).toEqual({ kind: 'failure', code: 5 });
    expect(negotiationFailureMessage(5)).toMatch(/Network Level Authentication/);
    const legacy = Buffer.from('0300000b06d00000123400', 'hex');
    expect(parseConnectionConfirm(legacy)).toEqual({ kind: 'legacy' });
  });

  it('refuses anything that is not a TPKT frame', () => {
    expect(tpktLength(Buffer.from('03000013', 'hex'))).toBe(19);
    expect(tpktLength(Buffer.from('0300', 'hex'))).toBeUndefined();
    expect(() => tpktLength(Buffer.from('16030100', 'hex'))).toThrow(/TPKT/);
  });
});
