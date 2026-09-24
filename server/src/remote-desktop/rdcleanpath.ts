/**
 * RDCleanPath: the handshake IronRDP's browser client speaks to its proxy.
 *
 * A browser cannot open TCP or run TLS against an RDP server, so the client
 * sends the X.224 connection request inside a DER-encoded RDCleanPath PDU over
 * a WebSocket. The proxy dials the server, exchanges X.224, performs the TLS
 * handshake itself and answers with the server's X.224 confirm and certificate
 * chain. From then on the WebSocket carries the plaintext RDP stream, which the
 * proxy relays through the TLS connection. CredSSP still runs in the client,
 * bound to the certificate's public key, so the password never reaches us.
 *
 * Wire format (explicit context tags, from ironrdp-rdcleanpath):
 *
 *   RDCleanPathPdu ::= SEQUENCE {
 *     version             [0] INTEGER,             -- 3390
 *     error               [1] RDCleanPathErr OPTIONAL,
 *     destination         [2] UTF8String OPTIONAL,
 *     proxy_auth          [3] UTF8String OPTIONAL,
 *     server_auth         [4] UTF8String OPTIONAL,
 *     preconnection_blob  [5] UTF8String OPTIONAL,
 *     x224_connection_pdu [6] OCTET STRING OPTIONAL,
 *     server_cert_chain   [7] SEQUENCE OF OCTET STRING OPTIONAL,
 *     server_addr         [9] UTF8String OPTIONAL }
 *
 *   RDCleanPathErr ::= SEQUENCE {
 *     error_code          [0] INTEGER,
 *     http_status_code    [1] INTEGER OPTIONAL,
 *     wsa_last_error      [2] INTEGER OPTIONAL,
 *     tls_alert_code      [3] INTEGER OPTIONAL }
 */

export const RDCLEANPATH_VERSION = 3390;
export const RDCLEANPATH_GENERAL_ERROR = 1;
export const RDCLEANPATH_NEGOTIATION_ERROR = 2;

/** Requests are a few hundred bytes; anything this large is not a handshake. */
export const RDCLEANPATH_MAX_REQUEST_BYTES = 64 * 1024;

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8_STRING = 0x0c;
const TAG_SEQUENCE = 0x30;
const contextTag = (n: number) => 0xa0 | n;

export interface RDCleanPathError {
  errorCode: number;
  httpStatusCode?: number;
  wsaLastError?: number;
  tlsAlertCode?: number;
}

export interface RDCleanPathRequest {
  destination: string;
  proxyAuth: string;
  serverAuth?: string;
  preconnectionBlob?: string;
  x224ConnectionPdu: Buffer;
}

export class RDCleanPathDecodeError extends Error {}

// --- Encoding ---------------------------------------------------------------

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function encodeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`bad DER integer ${value}`);
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  // Unsigned values keep a leading zero when their top bit is set.
  if (bytes.length === 0 || bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(TAG_INTEGER, Buffer.from(bytes));
}

const explicit = (n: number, inner: Buffer) => tlv(contextTag(n), inner);

function encodeError(error: RDCleanPathError): Buffer {
  const fields = [explicit(0, encodeInteger(error.errorCode))];
  if (error.httpStatusCode !== undefined) fields.push(explicit(1, encodeInteger(error.httpStatusCode)));
  if (error.wsaLastError !== undefined) fields.push(explicit(2, encodeInteger(error.wsaLastError)));
  if (error.tlsAlertCode !== undefined) fields.push(explicit(3, encodeInteger(error.tlsAlertCode)));
  return tlv(TAG_SEQUENCE, Buffer.concat(fields));
}

function encodePdu(fields: Buffer[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat([explicit(0, encodeInteger(RDCLEANPATH_VERSION)), ...fields]));
}

/** Successful handshake: the server's X.224 confirm plus its TLS chain, leaf first. */
export function encodeRDCleanPathResponse(
  serverAddr: string,
  x224ConnectionConfirm: Buffer,
  certificateChain: readonly Buffer[],
): Buffer {
  const chain = tlv(
    TAG_SEQUENCE,
    Buffer.concat(certificateChain.map((certificate) => tlv(TAG_OCTET_STRING, certificate))),
  );
  return encodePdu([
    explicit(6, tlv(TAG_OCTET_STRING, x224ConnectionConfirm)),
    explicit(7, chain),
    explicit(9, tlv(TAG_UTF8_STRING, Buffer.from(serverAddr, 'utf8'))),
  ]);
}

/** Proxy-side failure; the client reports the HTTP, socket or TLS detail. */
export function encodeRDCleanPathError(error: RDCleanPathError): Buffer {
  return encodePdu([explicit(1, encodeError(error))]);
}

/**
 * The server refused the security protocols the client offered; its X.224
 * failure lets the client say why ("the server requires NLA", …).
 */
export function encodeRDCleanPathNegotiationError(x224ConnectionConfirm: Buffer): Buffer {
  return encodePdu([
    explicit(1, encodeError({ errorCode: RDCLEANPATH_NEGOTIATION_ERROR })),
    explicit(6, tlv(TAG_OCTET_STRING, x224ConnectionConfirm)),
  ]);
}

// --- Decoding ---------------------------------------------------------------

interface Element {
  tag: number;
  value: Buffer;
  /** Offset just past this element. */
  end: number;
}

/** Header of the element at `offset`, or undefined when more bytes are needed. */
function readHeader(buffer: Buffer, offset: number): { tag: number; start: number; length: number } | undefined {
  if (buffer.length < offset + 2) return undefined;
  const tag = buffer[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new RDCleanPathDecodeError('multi-byte DER tags are not used by RDCleanPath');
  const first = buffer[offset + 1]!;
  if (first < 0x80) return { tag, start: offset + 2, length: first };
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new RDCleanPathDecodeError('unsupported DER length');
  if (buffer.length < offset + 2 + count) return undefined;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + buffer[offset + 2 + i]!;
  if (length < 0x80 || (count > 1 && buffer[offset + 2] === 0)) {
    throw new RDCleanPathDecodeError('non-minimal DER length');
  }
  return { tag, start: offset + 2 + count, length };
}

function readElement(buffer: Buffer, offset: number): Element {
  const header = readHeader(buffer, offset);
  if (!header || header.start + header.length > buffer.length) {
    throw new RDCleanPathDecodeError('truncated DER element');
  }
  return {
    tag: header.tag,
    value: buffer.subarray(header.start, header.start + header.length),
    end: header.start + header.length,
  };
}

function children(value: Buffer): Element[] {
  const elements: Element[] = [];
  for (let offset = 0; offset < value.length; ) {
    const element = readElement(value, offset);
    elements.push(element);
    offset = element.end;
  }
  return elements;
}

function explicitInner(element: Element, expectedTag: number): Buffer {
  const [inner, ...rest] = children(element.value);
  if (!inner || rest.length > 0 || inner.tag !== expectedTag) {
    throw new RDCleanPathDecodeError(`unexpected content in [${element.tag & 0x1f}]`);
  }
  return inner.value;
}

function decodeInteger(value: Buffer): number {
  if (value.length === 0 || value.length > 7 || value[0]! & 0x80) {
    throw new RDCleanPathDecodeError('unsupported DER integer');
  }
  return value.reduce((total, byte) => total * 256 + byte, 0);
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new RDCleanPathDecodeError('invalid UTF-8 string');
  }
}

/**
 * Total byte length of the PDU at the front of `buffer` once its header is
 * complete, so a request split across WebSocket frames can be reassembled.
 */
export function rdCleanPathPduLength(buffer: Buffer): number | undefined {
  const header = readHeader(buffer, 0);
  if (!header) return undefined;
  if (header.tag !== TAG_SEQUENCE) throw new RDCleanPathDecodeError('not an RDCleanPath PDU');
  return header.start + header.length;
}

/** Parse the client's request, rejecting anything else a proxy could be sent. */
export function decodeRDCleanPathRequest(buffer: Buffer): RDCleanPathRequest {
  const pdu = readElement(buffer, 0);
  if (pdu.tag !== TAG_SEQUENCE || pdu.end !== buffer.length) {
    throw new RDCleanPathDecodeError('not an RDCleanPath PDU');
  }
  let version: number | undefined;
  const strings = new Map<number, string>();
  let x224: Buffer | undefined;
  let previous = -1;
  for (const field of children(pdu.value)) {
    if ((field.tag & 0xe0) !== 0xa0) throw new RDCleanPathDecodeError('unexpected RDCleanPath field');
    const number = field.tag & 0x1f;
    if (number <= previous) throw new RDCleanPathDecodeError('RDCleanPath fields out of order');
    previous = number;
    switch (number) {
      case 0:
        version = decodeInteger(explicitInner(field, TAG_INTEGER));
        break;
      case 2:
      case 3:
      case 4:
      case 5:
        strings.set(number, decodeUtf8(explicitInner(field, TAG_UTF8_STRING)));
        break;
      case 6:
        x224 = Buffer.from(explicitInner(field, TAG_OCTET_STRING));
        break;
      default:
        // error, certificate chain and server address only travel to the client.
        throw new RDCleanPathDecodeError(`field [${number}] is not valid in a request`);
    }
  }
  if (version !== RDCLEANPATH_VERSION) {
    throw new RDCleanPathDecodeError(`unsupported RDCleanPath version ${version ?? 'missing'}`);
  }
  const destination = strings.get(2);
  const proxyAuth = strings.get(3);
  if (!destination) throw new RDCleanPathDecodeError('request has no destination');
  if (proxyAuth === undefined) throw new RDCleanPathDecodeError('request has no proxy_auth');
  if (!x224) throw new RDCleanPathDecodeError('request has no X.224 connection request');
  return {
    destination,
    proxyAuth,
    serverAuth: strings.get(4),
    preconnectionBlob: strings.get(5),
    x224ConnectionPdu: x224,
  };
}
