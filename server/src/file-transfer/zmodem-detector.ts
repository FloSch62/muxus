import { crc16 } from './crc.js';

const ZPAD = 0x2a;
const ZDLE = 0x18;
const ZHEX = 0x42;

/** Cursor is at column 0 after "rz\r"; this clears what it printed. */
const ERASE_LINE = '\x1b[2K';

/** "**", ZDLE, 'B', then type, four data bytes and the CRC as 14 hex digits. */
const HEADER_LENGTH = 4 + 14;

export interface ZmodemDetection {
  /** ZRQINIT (0): the remote runs `sz` and offers files. ZRINIT (1): it runs `rz` and wants files. */
  type: 0 | 1;
  /** ZP0..ZP3 of the header; for ZRINIT, the receiver's buffer size and capability flags. */
  data: Buffer;
  /** Output after the header, which belongs to the transfer. */
  rest: Buffer;
}

export interface DetectorResult {
  /** Output for the terminal. */
  output: Buffer;
  detection?: ZmodemDetection;
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return -1;
}

/**
 * Watches terminal output for the hex header `sz` and `rz` open with. Only a
 * complete ZRQINIT or ZRINIT whose CRC checks out counts, so ordinary text,
 * even text with "**" or a stray CAN in it, never starts a transfer.
 *
 * A header may be split across any number of chunks. Once "**" and ZDLE
 * have been seen, the candidate bytes are held back from the terminal until
 * they complete a header or turn out to be ordinary output; a lone "*" or
 * "**" at the end of a chunk is shown at once, so typing never lags.
 */
export class ZmodemDetector {
  /** The header prefix matched so far. */
  private candidate: number[] = [];
  /** How many of the candidate's last bytes have not reached the terminal. */
  private unshown = 0;
  /** The last bytes that reached the terminal. */
  private shownTail = '';

  feed(chunk: Buffer): DetectorResult {
    if (this.candidate.length === 0 && chunk.indexOf(ZPAD) < 0) return { output: this.shown(chunk) };
    const out = Buffer.allocUnsafe(this.unshown + chunk.length);
    let length = 0;
    const emit = (byte: number) => {
      out[length++] = byte;
    };
    const release = () => {
      for (let i = this.candidate.length - this.unshown; i < this.candidate.length; i++) emit(this.candidate[i]!);
      this.candidate = [];
      this.unshown = 0;
    };

    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      if (this.candidate.length === 0) {
        if (byte === ZPAD) {
          this.candidate = [byte];
          this.unshown = 1;
          continue;
        }
        // Copy ordinary output up to the next possible header start.
        const next = chunk.indexOf(ZPAD, i);
        const end = next < 0 ? chunk.length : next;
        length += chunk.copy(out, length, i, end);
        i = end - 1;
        continue;
      }

      const position = this.candidate.length;
      if (this.accepts(position, byte)) {
        this.candidate.push(byte);
        this.unshown++;
        if (this.candidate.length < HEADER_LENGTH) continue;
        const header = this.decode();
        if (header) {
          this.candidate = [];
          this.unshown = 0;
          // `sz` types "rz\r" ahead of its header to start a receiver; that
          // is our job now, so keep it off the screen, or erase it when an
          // earlier chunk already showed it.
          let output = out.subarray(0, length);
          if (header.type === 0) {
            if (output.subarray(-3).toString('latin1') === 'rz\r') output = output.subarray(0, -3);
            else if (output.length === 0 && this.shownTail === 'rz\r') output = Buffer.from(ERASE_LINE);
          }
          this.shownTail = '';
          return {
            output,
            detection: { ...header, rest: Buffer.from(chunk.subarray(i + 1)) },
          };
        }
        release();
        continue;
      }

      if (position === 2 && byte === ZPAD) {
        // "***": drop the first star from the candidate, keep matching "**".
        if (this.unshown === 2) emit(this.candidate[0]!);
        this.candidate = [ZPAD, ZPAD];
        this.unshown = Math.min(this.unshown, 1) + 1;
        continue;
      }
      release();
      if (byte === ZPAD) {
        this.candidate = [byte];
        this.unshown = 1;
      } else {
        emit(byte);
      }
    }

    if (this.candidate.length <= 2 && this.unshown > 0) {
      // Show a trailing "*" or "**" now but keep it in mind for matching.
      for (let i = this.candidate.length - this.unshown; i < this.candidate.length; i++) emit(this.candidate[i]!);
      this.unshown = 0;
    }
    return { output: this.shown(out.subarray(0, length)) };
  }

  /** True while candidate bytes are held back from the terminal. */
  get holding(): boolean {
    return this.unshown > 0;
  }

  /** Release held-back bytes once output has gone quiet in the middle of a candidate. */
  flush(): Buffer {
    const held = Buffer.from(this.candidate.slice(this.candidate.length - this.unshown));
    this.unshown = 0;
    return this.shown(held);
  }

  private shown(output: Buffer): Buffer {
    if (output.length > 0) {
      this.shownTail = (this.shownTail + output.subarray(-3).toString('latin1')).slice(-3);
    }
    return output;
  }

  private accepts(position: number, byte: number): boolean {
    if (position === 1) return byte === ZPAD;
    if (position === 2) return byte === ZDLE;
    if (position === 3) return byte === ZHEX;
    if (position === 4) return byte === 0x30;
    if (position === 5) return byte === 0x30 || byte === 0x31;
    return hexValue(byte) >= 0;
  }

  private decode(): { type: 0 | 1; data: Buffer } | undefined {
    const bytes = Buffer.alloc(7);
    for (let i = 0; i < 7; i++) {
      bytes[i] = (hexValue(this.candidate[4 + i * 2]!) << 4) | hexValue(this.candidate[5 + i * 2]!);
    }
    if (crc16(bytes, 0, 0, 5) !== bytes.readUInt16BE(5)) return undefined;
    return { type: bytes[0] as 0 | 1, data: Buffer.from(bytes.subarray(1, 5)) };
  }
}
