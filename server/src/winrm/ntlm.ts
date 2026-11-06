import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * NTLMv2 (MS-NLMP) as WinRM needs it: the three-message handshake carried in
 * `Authorization: Negotiate` headers, then signing and sealing of every
 * message with the session keys. OpenSSL 3 no longer ships MD4 or RC4 by
 * default, so both are implemented here; nothing else uses them.
 */

// --- MD4 (RFC 1320) ---

export function md4(input: Buffer): Buffer {
  const bitLength = input.length * 8;
  const padded = Buffer.alloc((((input.length + 8) >> 6) + 1) * 64);
  input.copy(padded);
  padded[input.length] = 0x80;
  padded.writeUInt32LE(bitLength >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bitLength / 0x1_0000_0000), padded.length - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const rotl = (x: number, s: number) => (x << s) | (x >>> (32 - s));
  const x: number[] = [];
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(offset + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const f = (p: number, q: number, r: number) => (p & q) | (~p & r);
    const g = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
    const h = (p: number, q: number, r: number) => p ^ q ^ r;
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + f(b, c, d) + x[i]!) | 0, 3);
      d = rotl((d + f(a, b, c) + x[i + 1]!) | 0, 7);
      c = rotl((c + f(d, a, b) + x[i + 2]!) | 0, 11);
      b = rotl((b + f(c, d, a) + x[i + 3]!) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + g(b, c, d) + x[i]! + 0x5a827999) | 0, 3);
      d = rotl((d + g(a, b, c) + x[i + 4]! + 0x5a827999) | 0, 5);
      c = rotl((c + g(d, a, b) + x[i + 8]! + 0x5a827999) | 0, 9);
      b = rotl((b + g(c, d, a) + x[i + 12]! + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + h(b, c, d) + x[i]! + 0x6ed9eba1) | 0, 3);
      d = rotl((d + h(a, b, c) + x[i + 8]! + 0x6ed9eba1) | 0, 9);
      c = rotl((c + h(d, a, b) + x[i + 4]! + 0x6ed9eba1) | 0, 11);
      b = rotl((b + h(c, d, a) + x[i + 12]! + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0);
  out.writeInt32LE(b, 4);
  out.writeInt32LE(c, 8);
  out.writeInt32LE(d, 12);
  return out;
}

// --- RC4 ---

/** An RC4 keystream whose state carries over between calls, as NTLM sealing needs. */
export class Rc4 {
  private readonly s = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Buffer) {
    for (let n = 0; n < 256; n++) this.s[n] = n;
    let j = 0;
    for (let n = 0; n < 256; n++) {
      j = (j + this.s[n]! + key[n % key.length]!) & 0xff;
      [this.s[n], this.s[j]] = [this.s[j]!, this.s[n]!];
    }
  }

  update(data: Buffer): Buffer {
    const out = Buffer.alloc(data.length);
    for (let n = 0; n < data.length; n++) {
      this.i = (this.i + 1) & 0xff;
      this.j = (this.j + this.s[this.i]!) & 0xff;
      [this.s[this.i], this.s[this.j]] = [this.s[this.j]!, this.s[this.i]!];
      out[n] = data[n]! ^ this.s[(this.s[this.i]! + this.s[this.j]!) & 0xff]!;
    }
    return out;
  }
}

// --- Messages ---

export const NTLM = {
  UNICODE: 0x00000001,
  REQUEST_TARGET: 0x00000004,
  SIGN: 0x00000010,
  SEAL: 0x00000020,
  NTLM: 0x00000200,
  ALWAYS_SIGN: 0x00008000,
  EXTENDED_SESSIONSECURITY: 0x00080000,
  TARGET_INFO: 0x00800000,
  VERSION: 0x02000000,
  NEGOTIATE_128: 0x20000000,
  KEY_EXCH: 0x40000000,
  NEGOTIATE_56: 0x80000000,
} as const;

const CLIENT_FLAGS =
  (NTLM.NEGOTIATE_56 |
    NTLM.KEY_EXCH |
    NTLM.NEGOTIATE_128 |
    NTLM.VERSION |
    NTLM.TARGET_INFO |
    NTLM.EXTENDED_SESSIONSECURITY |
    NTLM.ALWAYS_SIGN |
    NTLM.NTLM |
    NTLM.SEAL |
    NTLM.SIGN |
    NTLM.REQUEST_TARGET |
    NTLM.UNICODE) >>>
  0;

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
/** Windows 10 build 19041, NTLM revision 15: a version servers recognise. */
const VERSION = Buffer.from([10, 0, 0x61, 0x4a, 0, 0, 0, 15]);
const AV_EOL = 0;
const AV_TIMESTAMP = 7;

export function negotiateMessage(): Buffer {
  const message = Buffer.alloc(40);
  SIGNATURE.copy(message, 0);
  message.writeUInt32LE(1, 8);
  message.writeUInt32LE(CLIENT_FLAGS, 12);
  // Domain and workstation fields stay empty (offsets 16 and 24).
  VERSION.copy(message, 32);
  return message;
}

export interface NtlmChallenge {
  flags: number;
  serverChallenge: Buffer;
  targetInfo: Buffer;
}

export function parseChallenge(message: Buffer): NtlmChallenge {
  if (message.length < 48 || !message.subarray(0, 8).equals(SIGNATURE) || message.readUInt32LE(8) !== 2) {
    throw new Error('The server sent an invalid NTLM challenge.');
  }
  const flags = message.readUInt32LE(20);
  const serverChallenge = Buffer.from(message.subarray(24, 32));
  const infoLength = message.readUInt16LE(40);
  const infoOffset = message.readUInt32LE(44);
  const targetInfo =
    flags & NTLM.TARGET_INFO && infoOffset + infoLength <= message.length
      ? Buffer.from(message.subarray(infoOffset, infoOffset + infoLength))
      : Buffer.alloc(0);
  return { flags, serverChallenge, targetInfo };
}

function avPair(targetInfo: Buffer, id: number): Buffer | undefined {
  for (let offset = 0; offset + 4 <= targetInfo.length; ) {
    const avId = targetInfo.readUInt16LE(offset);
    const length = targetInfo.readUInt16LE(offset + 2);
    if (avId === AV_EOL) return undefined;
    if (avId === id) return targetInfo.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  return undefined;
}

const hmacMd5 = (key: Buffer<ArrayBufferLike>, ...data: Buffer<ArrayBufferLike>[]) => {
  const hmac = createHmac('md5', key);
  for (const part of data) hmac.update(part);
  return hmac.digest();
};
const md5 = (...data: Buffer<ArrayBufferLike>[]) => {
  const hash = createHash('md5');
  for (const part of data) hash.update(part);
  return hash.digest();
};
const utf16 = (text: string) => Buffer.from(text, 'utf16le');

export function ntowfv2(password: string, user: string, domain: string): Buffer {
  return hmacMd5(md4(utf16(password)), utf16(user.toUpperCase() + domain));
}

/** Split `DOMAIN\user`; a `user@domain` name goes as it is with no domain, as Windows accepts. */
export function splitUser(name: string): { user: string; domain: string } {
  const slash = name.indexOf('\\');
  if (slash >= 0) return { domain: name.slice(0, slash), user: name.slice(slash + 1) };
  return { user: name, domain: '' };
}

export interface AuthenticateInput {
  username: string;
  password: string;
  challenge: NtlmChallenge;
  workstation?: string;
  /** Test seams; random or current by default. */
  clientChallenge?: Buffer;
  exportedSessionKey?: Buffer;
  timestamp?: Buffer;
}

export interface NtlmAuthentication {
  message: Buffer;
  session: NtlmSession;
  /** Exposed for tests against the MS-NLMP examples. */
  ntProofStr: Buffer;
  sessionBaseKey: Buffer;
  encryptedRandomSessionKey: Buffer;
}

function fileTimeNow(): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE((BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n);
  return out;
}

export function authenticateMessage(input: AuthenticateInput): NtlmAuthentication {
  const { user, domain } = splitUser(input.username);
  const { challenge } = input;
  const flags = (challenge.flags & CLIENT_FLAGS) >>> 0;
  const clientChallenge = input.clientChallenge ?? randomBytes(8);
  const serverTime = avPair(challenge.targetInfo, AV_TIMESTAMP);
  const timestamp = input.timestamp ?? (serverTime ? Buffer.from(serverTime) : fileTimeNow());

  const responseKey = ntowfv2(input.password, user, domain);
  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    timestamp,
    clientChallenge,
    Buffer.alloc(4),
    challenge.targetInfo,
    Buffer.alloc(4),
  ]);
  const ntProofStr = hmacMd5(responseKey, challenge.serverChallenge, temp);
  const ntResponse = Buffer.concat([ntProofStr, temp]);
  // With a server timestamp the LM response is zeroes; otherwise LMv2.
  const lmResponse = serverTime
    ? Buffer.alloc(24)
    : Buffer.concat([hmacMd5(responseKey, challenge.serverChallenge, clientChallenge), clientChallenge]);
  const sessionBaseKey = hmacMd5(responseKey, ntProofStr);

  let exportedSessionKey: Buffer<ArrayBufferLike> = sessionBaseKey;
  let encryptedRandomSessionKey: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  if (flags & NTLM.KEY_EXCH) {
    exportedSessionKey = input.exportedSessionKey ?? randomBytes(16);
    encryptedRandomSessionKey = new Rc4(sessionBaseKey).update(exportedSessionKey);
  }

  const payload = [
    utf16(domain),
    utf16(user),
    utf16(input.workstation ?? ''),
    lmResponse,
    ntResponse,
    encryptedRandomSessionKey,
  ];
  const header = Buffer.alloc(72);
  SIGNATURE.copy(header, 0);
  header.writeUInt32LE(3, 8);
  let offset = header.length;
  // Field order in the header: LM, NT, domain, user, workstation, session key.
  const fieldAt = [28, 36, 44, 12, 20, 52];
  payload.forEach((data, index) => {
    const at = fieldAt[index]!;
    header.writeUInt16LE(data.length, at);
    header.writeUInt16LE(data.length, at + 2);
    header.writeUInt32LE(offset, at + 4);
    offset += data.length;
  });
  header.writeUInt32LE(flags, 60);
  VERSION.copy(header, 64);

  return {
    message: Buffer.concat([header, ...payload]),
    session: new NtlmSession(exportedSessionKey, flags),
    ntProofStr,
    sessionBaseKey,
    encryptedRandomSessionKey,
  };
}

// --- Session security ---

const magic = (text: string) => Buffer.from(`${text}\0`, 'latin1');
const CLIENT_SIGN = magic('session key to client-to-server signing key magic constant');
const SERVER_SIGN = magic('session key to server-to-client signing key magic constant');
const CLIENT_SEAL = magic('session key to client-to-server sealing key magic constant');
const SERVER_SEAL = magic('session key to server-to-client sealing key magic constant');

/** Signs and seals messages with extended session security, one sequence per direction. */
export class NtlmSession {
  private readonly clientSign: Buffer<ArrayBufferLike>;
  private readonly serverSign: Buffer<ArrayBufferLike>;
  private readonly clientSeal: Rc4;
  private readonly serverSeal: Rc4;
  private clientSequence = 0;
  private serverSequence = 0;
  private readonly keyExchange: boolean;

  constructor(exportedSessionKey: Buffer, flags: number) {
    this.keyExchange = (flags & NTLM.KEY_EXCH) !== 0;
    const sealKey =
      flags & NTLM.NEGOTIATE_128
        ? exportedSessionKey
        : flags & NTLM.NEGOTIATE_56
          ? exportedSessionKey.subarray(0, 7)
          : exportedSessionKey.subarray(0, 5);
    this.clientSign = md5(exportedSessionKey, CLIENT_SIGN);
    this.serverSign = md5(exportedSessionKey, SERVER_SIGN);
    this.clientSeal = new Rc4(md5(sealKey, CLIENT_SEAL));
    this.serverSeal = new Rc4(md5(sealKey, SERVER_SEAL));
  }

  /** Encrypt a message for the server; returns the 16-byte signature and the sealed bytes. */
  seal(message: Buffer): { signature: Buffer; sealed: Buffer } {
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32LE(this.clientSequence++);
    const sealed = this.clientSeal.update(message);
    let checksum: Buffer<ArrayBufferLike> = hmacMd5(this.clientSign, sequence, message).subarray(0, 8);
    if (this.keyExchange) checksum = this.clientSeal.update(checksum);
    return { signature: Buffer.concat([Buffer.from([1, 0, 0, 0]), checksum, sequence]), sealed };
  }

  /** Decrypt a message from the server and check its signature. */
  unseal(sealed: Buffer, signature: Buffer): Buffer {
    const message = this.serverSeal.update(sealed);
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32LE(this.serverSequence++);
    let checksum: Buffer<ArrayBufferLike> = hmacMd5(this.serverSign, sequence, message).subarray(0, 8);
    if (this.keyExchange) checksum = this.serverSeal.update(checksum);
    if (signature.length !== 16 || !checksum.equals(signature.subarray(4, 12))) {
      throw new Error('The WinRM server sent a message with an invalid signature.');
    }
    return message;
  }
}
