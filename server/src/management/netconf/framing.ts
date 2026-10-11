/**
 * NETCONF over SSH message framing (RFC 6242). Hellos, and every message
 * when either side only speaks base:1.0, end with the `]]>]]>` marker;
 * once both sides offer base:1.1 messages travel as chunks,
 * `\n#<size>\n<data>` … `\n##\n`.
 *
 * Replies can run to many megabytes over a stream of small SSH packets, so
 * the decoder queues packets and copies each byte once instead of growing
 * one buffer per packet.
 */

export const END_OF_MESSAGE = ']]>]]>';
const EOM = Buffer.from(END_OF_MESSAGE, 'utf8');
const NEWLINE = 0x0a;
const HASH = 0x23;

export class NetconfFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetconfFramingError';
  }
}

export function encodeEndOfMessage(message: string): Buffer {
  return Buffer.concat([Buffer.from(message, 'utf8'), EOM]);
}

export function encodeChunked(message: string): Buffer {
  const body = Buffer.from(message, 'utf8');
  if (body.length === 0) throw new NetconfFramingError('cannot frame an empty message');
  return Buffer.concat([Buffer.from(`\n#${body.length}\n`, 'utf8'), body, Buffer.from('\n##\n', 'utf8')]);
}

/** Received bytes as a list of packets, read from the front. */
class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  byteAt(index: number): number | undefined {
    if (index >= this.length) return undefined;
    for (const chunk of this.chunks) {
      if (index < chunk.length) return chunk[index];
      index -= chunk.length;
    }
    return undefined;
  }

  /** Remove and return the first `count` bytes. */
  take(count: number): Buffer {
    const parts: Buffer[] = [];
    let remaining = count;
    while (remaining > 0) {
      const head = this.chunks[0]!;
      if (head.length <= remaining) {
        parts.push(head);
        this.chunks.shift();
        remaining -= head.length;
      } else {
        parts.push(head.subarray(0, remaining));
        this.chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.length -= count;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, count);
  }

  drop(count: number): void {
    this.take(count);
  }

  /** First index ≥ `from` where `pattern` starts, or -1. */
  indexOf(pattern: Buffer, from: number): number {
    let offset = 0;
    // The last bytes seen, across as many packets as it takes: a match may
    // straddle several tiny ones.
    let tail: Buffer = Buffer.alloc(0);
    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd > from) {
        if (tail.length) {
          const joined = Buffer.concat([tail, chunk.subarray(0, pattern.length - 1)]);
          const straddle = joined.indexOf(pattern);
          const absolute = offset - tail.length + straddle;
          if (straddle >= 0 && straddle < tail.length && absolute >= from) return absolute;
        }
        const found = chunk.indexOf(pattern, Math.max(0, from - offset));
        if (found >= 0) return offset + found;
      }
      const rolled = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      tail = rolled.subarray(Math.max(0, rolled.length - (pattern.length - 1)));
      offset = chunkEnd;
    }
    return -1;
  }
}

/**
 * Incremental decoder for either framing. `push` returns every message
 * completed by the packet; switch to chunked framing once the hellos have
 * been exchanged.
 */
export class NetconfDecoder {
  private mode: 'eom' | 'chunked' = 'eom';
  private readonly queue = new ByteQueue();
  /** End-of-message mode: bytes already searched for the marker. */
  private searched = 0;
  /** Chunked mode: chunks of the message being assembled. */
  private parts: Buffer[] = [];
  private partsSize = 0;
  /** Chunked mode: size of the chunk whose header was read, still waiting for its data. */
  private pendingChunk: number | undefined;

  constructor(private readonly maxMessageBytes = 1024 * 1024 * 1024) {}

  useChunked(): void {
    this.mode = 'chunked';
  }

  push(chunk: Buffer): string[] {
    this.queue.push(chunk);
    const messages: string[] = [];
    for (;;) {
      const message = this.mode === 'eom' ? this.nextEndOfMessage() : this.nextChunked();
      if (message === undefined) return messages;
      messages.push(message);
    }
  }

  private nextEndOfMessage(): string | undefined {
    const end = this.queue.indexOf(EOM, Math.max(0, this.searched - (EOM.length - 1)));
    if (end < 0) {
      this.searched = this.queue.length;
      if (this.queue.length > this.maxMessageBytes) throw new NetconfFramingError('message too large');
      return undefined;
    }
    const message = this.queue.take(end).toString('utf8');
    this.queue.drop(EOM.length);
    this.searched = 0;
    return message;
  }

  private nextChunked(): string | undefined {
    for (;;) {
      if (this.pendingChunk !== undefined) {
        if (this.queue.length < this.pendingChunk) return undefined;
        this.parts.push(this.queue.take(this.pendingChunk));
        this.partsSize += this.pendingChunk;
        this.pendingChunk = undefined;
      }
      // Tolerate whitespace some servers leave between messages.
      if (this.parts.length === 0) {
        while (this.queue.length > 0) {
          const byte = this.queue.byteAt(0)!;
          const isSpace = byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === NEWLINE;
          if (!isSpace) break;
          if (byte === NEWLINE) {
            const next = this.queue.byteAt(1);
            if (next === undefined) return undefined;
            if (next === HASH) break;
          }
          this.queue.drop(1);
        }
      }
      if (this.queue.length < 4) return undefined;
      if (this.queue.byteAt(0) !== NEWLINE || this.queue.byteAt(1) !== HASH) {
        throw new NetconfFramingError('expected a chunk header');
      }
      if (this.queue.byteAt(2) === HASH) {
        if (this.queue.byteAt(3) !== NEWLINE) throw new NetconfFramingError('malformed end-of-chunks marker');
        if (this.parts.length === 0) throw new NetconfFramingError('end-of-chunks without a chunk');
        this.queue.drop(4);
        const message = Buffer.concat(this.parts, this.partsSize).toString('utf8');
        this.parts = [];
        this.partsSize = 0;
        return message;
      }
      // "\n#" then up to ten digits then "\n".
      let newline = -1;
      for (let index = 2; index < Math.min(this.queue.length, 14); index++) {
        if (this.queue.byteAt(index) === NEWLINE) {
          newline = index;
          break;
        }
      }
      if (newline < 0) {
        if (this.queue.length >= 14) throw new NetconfFramingError('chunk size too long');
        return undefined;
      }
      const header = this.queue.take(newline + 1).toString('ascii');
      const sizeText = header.slice(2, -1);
      if (!/^[1-9]\d{0,9}$/.test(sizeText) || Number(sizeText) > 4294967295) {
        throw new NetconfFramingError(`invalid chunk size “${sizeText}”`);
      }
      const size = Number(sizeText);
      if (this.partsSize + size > this.maxMessageBytes) throw new NetconfFramingError('message too large');
      this.pendingChunk = size;
    }
  }
}
