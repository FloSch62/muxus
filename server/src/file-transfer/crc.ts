const CRC16_TABLE = new Uint16Array(256);
const CRC32_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let crc16 = i << 8;
  for (let bit = 0; bit < 8; bit++) {
    crc16 = crc16 & 0x8000 ? ((crc16 << 1) ^ 0x1021) & 0xffff : (crc16 << 1) & 0xffff;
  }
  CRC16_TABLE[i] = crc16;
  let crc32 = i;
  for (let bit = 0; bit < 8; bit++) {
    crc32 = crc32 & 1 ? (crc32 >>> 1) ^ 0xedb88320 : crc32 >>> 1;
  }
  CRC32_TABLE[i] = crc32 >>> 0;
}

/** CRC-16/XMODEM (CCITT polynomial, zero start), as XMODEM and ZMODEM use it. */
export function crc16(data: Uint8Array, crc = 0, start = 0, end = data.length): number {
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) & 0xff00) ^ CRC16_TABLE[((crc >> 8) ^ data[i]!) & 0xff]!;
  }
  return crc;
}

export function crc16Byte(crc: number, byte: number): number {
  return ((crc << 8) & 0xff00) ^ CRC16_TABLE[((crc >> 8) ^ byte) & 0xff]!;
}

/**
 * Running CRC-32 register (no final inversion). ZMODEM starts at 0xffffffff
 * and sends the complement.
 */
export function crc32Update(crc: number, data: Uint8Array, start = 0, end = data.length): number {
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}

export function crc32Byte(crc: number, byte: number): number {
  return (CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
}

/** Standard CRC-32 (zlib) of a whole buffer. */
export function crc32(data: Uint8Array): number {
  return ~crc32Update(0xffffffff, data) >>> 0;
}
