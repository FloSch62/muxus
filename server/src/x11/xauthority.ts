import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Reader and writer for the binary Xauthority format (libXau). Each record is
 * five big-endian length-prefixed fields: a u16 address family, then the
 * address, display number, auth protocol name and auth data as u16-length
 * byte strings.
 */

export const FAMILY_INTERNET = 0;
export const FAMILY_INTERNET6 = 6;
/** Unix-domain and loopback connections; the address is the local hostname. */
export const FAMILY_LOCAL = 256;
/** Matches any address. */
export const FAMILY_WILD = 65535;

export const MIT_MAGIC_COOKIE = 'MIT-MAGIC-COOKIE-1';

export interface XauthEntry {
  family: number;
  address: Buffer;
  /** Display number as written by xauth ("0"); empty matches any display. */
  number: string;
  name: string;
  data: Buffer;
}

/** Credentials presented to an X server in the connection setup. */
export interface X11Auth {
  name: string;
  data: Buffer;
}

export function parseXauthority(buf: Buffer): XauthEntry[] {
  const entries: XauthEntry[] = [];
  let offset = 0;
  const field = (): Buffer | undefined => {
    if (offset + 2 > buf.length) return undefined;
    const length = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + length > buf.length) return undefined;
    const value = buf.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  while (offset + 2 <= buf.length) {
    const family = buf.readUInt16BE(offset);
    offset += 2;
    const address = field();
    const number = field();
    const name = field();
    const data = field();
    // A truncated trailing record is ignored, as libXau does.
    if (!address || !number || !name || !data) break;
    entries.push({
      family,
      address: Buffer.from(address),
      number: number.toString('latin1'),
      name: name.toString('latin1'),
      data: Buffer.from(data),
    });
  }
  return entries;
}

export function serializeXauthority(entries: readonly XauthEntry[]): Buffer {
  const parts: Buffer[] = [];
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    parts.push(length, value);
  };
  for (const entry of entries) {
    const family = Buffer.alloc(2);
    family.writeUInt16BE(entry.family);
    parts.push(family);
    field(entry.address);
    field(Buffer.from(entry.number, 'latin1'));
    field(Buffer.from(entry.name, 'latin1'));
    field(entry.data);
  }
  return Buffer.concat(parts);
}

/** $XAUTHORITY, else ~/.Xauthority — the lookup order Xlib uses. */
export function xauthorityPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.XAUTHORITY || path.join(env.HOME || os.homedir(), '.Xauthority');
}

/**
 * Where an X client is connected, for picking the matching Xauthority
 * record: a local display (Unix socket or loopback TCP) or the IP address
 * of a remote TCP display.
 */
export type XauthTarget = { local: true } | { local: false; family: number; address: Buffer };

/**
 * The Xauthority address for a connected TCP display, from the socket's peer
 * address as libxcb derives it: loopback counts as local, IPv4 (including
 * IPv4-mapped IPv6) is FamilyInternet, other IPv6 is FamilyInternet6. Using
 * the peer address covers DISPLAY host names without a separate lookup.
 */
export function xauthTargetForPeer(address: string | undefined): XauthTarget {
  const ip = address?.replace(/%.*$/, '') ?? '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const ipv4 = mapped ?? (net.isIPv4(ip) ? ip : undefined);
  if (ipv4) {
    const bytes = Buffer.from(ipv4.split('.').map(Number));
    return bytes[0] === 127 ? { local: true } : { local: false, family: FAMILY_INTERNET, address: bytes };
  }
  const bytes = net.isIPv6(ip) ? ipv6Bytes(ip) : undefined;
  if (!bytes) return { local: false, family: FAMILY_INTERNET, address: Buffer.alloc(0) };
  const loopback = bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  return loopback ? { local: true } : { local: false, family: FAMILY_INTERNET6, address: bytes };
}

/**
 * The MIT-MAGIC-COOKIE-1 credentials Xlib would send for `number`, following
 * XauGetBestAuthByAddr: a record matches on display number (empty = any) and
 * on address — FamilyWild, FamilyLocal with this machine's hostname for
 * local displays, or the peer's IP address for remote TCP displays.
 */
export function findXauthCookie(
  entries: readonly XauthEntry[],
  number: string,
  target: XauthTarget,
  hostname: string = os.hostname(),
): X11Auth | undefined {
  const local = Buffer.from(hostname, 'latin1');
  const localShort = Buffer.from(hostname.split('.')[0] ?? hostname, 'latin1');
  const matchesAddress = (entry: XauthEntry): boolean => {
    if (entry.family === FAMILY_WILD) return true;
    if (target.local) {
      return (
        entry.family === FAMILY_LOCAL &&
        (entry.address.equals(local) || entry.address.equals(localShort))
      );
    }
    return entry.family === target.family && entry.address.equals(target.address);
  };
  const entry = entries.find(
    (candidate) =>
      candidate.name === MIT_MAGIC_COOKIE &&
      (candidate.number === '' || candidate.number === number) &&
      matchesAddress(candidate),
  );
  return entry ? { name: entry.name, data: entry.data } : undefined;
}

/** Read and search the Xauthority file; a missing or unreadable file yields no cookie. */
export function readXauthCookie(
  number: string,
  target: XauthTarget,
  file: string = xauthorityPath(),
): X11Auth | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  return findXauthCookie(parseXauthority(buf), number, target);
}

/** 16 network-order bytes of a textual IPv6 address (`::` and a dotted IPv4 tail allowed). */
function ipv6Bytes(address: string): Buffer | undefined {
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  let text = address;
  if (tail) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${address.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const groups = (part: string) => (part ? part.split(':').map((group) => Number.parseInt(group, 16)) : []);
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return undefined;
  const bytes = Buffer.alloc(16);
  [...left, ...Array<number>(missing).fill(0), ...right].forEach((group, index) =>
    bytes.writeUInt16BE(group, index * 2),
  );
  return bytes;
}
