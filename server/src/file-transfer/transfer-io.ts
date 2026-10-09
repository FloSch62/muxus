/** The far end stopped answering within the protocol's timeout. */
export class TransferTimeoutError extends Error {
  constructor(message = 'The remote side stopped responding.') {
    super(message);
    this.name = 'TransferTimeoutError';
  }
}

/** The far end sent the protocol's cancel sequence. */
export class RemoteCancelError extends Error {
  constructor(message = 'The remote side cancelled the transfer.') {
    super(message);
    this.name = 'RemoteCancelError';
  }
}

/** The local user cancelled; the protocol unwinds without answering. */
export class TransferCancelledError extends Error {
  constructor() {
    super('Transfer cancelled.');
    this.name = 'TransferCancelledError';
  }
}

/** Bytes from the remote side, consumed by a protocol as they arrive. */
export class TransferInput {
  private readonly chunks: Buffer[] = [];
  private offset = 0;
  private buffered = 0;
  private waiter: (() => void) | undefined;

  constructor(
    private readonly signal: AbortSignal,
    /** Told how much is waiting whenever that changes, for read backpressure. */
    private readonly onLevel?: (buffered: number) => void,
  ) {}

  get available(): number {
    return this.buffered;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.onLevel?.(this.buffered);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /** Next byte if one is already buffered. */
  tryByte(): number | undefined {
    const head = this.chunks[0];
    if (!head) return undefined;
    const byte = head[this.offset++]!;
    this.buffered--;
    if (this.offset >= head.length) {
      this.chunks.shift();
      this.offset = 0;
      this.onLevel?.(this.buffered);
    }
    return byte;
  }

  peekByte(): number | undefined {
    return this.chunks[0]?.[this.offset];
  }

  async byte(timeoutMs: number): Promise<number> {
    const byte = this.tryByte();
    if (byte !== undefined) return byte;
    await this.wait(timeoutMs);
    return this.tryByte()!;
  }

  /** Exactly `length` bytes, each arriving within `timeoutMs` of the previous one. */
  async bytes(length: number, timeoutMs: number): Promise<Buffer> {
    const out = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) {
      let byte = this.tryByte();
      if (byte === undefined) byte = await this.byte(timeoutMs);
      out[i] = byte;
    }
    return out;
  }

  /** Consume the next byte if it arrives within `timeoutMs` and matches. */
  async optional(matches: (byte: number) => boolean, timeoutMs: number): Promise<boolean> {
    if (this.buffered === 0) {
      try {
        await this.wait(timeoutMs);
      } catch (error) {
        if (error instanceof TransferTimeoutError) return false;
        throw error;
      }
    }
    const next = this.peekByte();
    if (next === undefined || !matches(next)) return false;
    this.tryByte();
    return true;
  }

  /** Resolves once at least one byte is buffered. */
  wait(timeoutMs: number, stop?: AbortSignal): Promise<void> {
    if (this.signal.aborted || stop?.aborted) return Promise.reject(new TransferCancelledError());
    if (this.buffered > 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
        stop?.removeEventListener('abort', onAbort);
        if (this.waiter === wake) this.waiter = undefined;
      };
      const timer = setTimeout(() => {
        done();
        reject(new TransferTimeoutError());
      }, timeoutMs);
      const onAbort = () => {
        done();
        reject(new TransferCancelledError());
      };
      const wake = () => {
        done();
        resolve();
      };
      this.signal.addEventListener('abort', onAbort, { once: true });
      stop?.addEventListener('abort', onAbort, { once: true });
      this.waiter = wake;
    });
  }

  /** Drop everything buffered: stale replies a protocol must not act on. */
  discard(): void {
    this.chunks.length = 0;
    this.offset = 0;
    this.buffered = 0;
    this.onLevel?.(0);
  }

  /** Everything still buffered, handed back to the terminal after a transfer. */
  takeRemaining(): Buffer {
    const head = this.chunks[0];
    if (head && this.offset > 0) this.chunks[0] = head.subarray(this.offset);
    const remaining = Buffer.concat(this.chunks);
    this.discard();
    return remaining;
  }
}

/** Where a protocol writes; `drain` resolves when the transport can take more. */
export interface TransferOutput {
  write(data: Buffer): void;
  drain(): Promise<void>;
}

/** One file being sent, read on demand. */
export interface OutgoingFile {
  name: string;
  size: number;
  mtimeMs?: number;
  read(position: number, length: number): Promise<Buffer>;
}

/** What a sender announced about a file (YMODEM block 0, ZMODEM ZFILE). */
export interface IncomingFileInfo {
  name?: string;
  size?: number;
  mtimeMs?: number;
  /** Files still to come including this one, when the sender says. */
  filesLeft?: number;
  /** Bytes still to come including this file, when the sender says. */
  bytesLeft?: number;
}

export interface IncomingFile {
  write(data: Buffer): Promise<void>;
  /** Complete the file, keeping only `size` bytes when the sender gave one. */
  finish(size?: number): Promise<void>;
  /** Drop a partial file. */
  discard(): Promise<void>;
}

export interface TransferProgress {
  fileName?: string;
  /** 1-based position of the file in the batch. */
  fileIndex: number;
  fileCount?: number;
  /** Bytes of the current file so far. */
  bytes: number;
  total?: number;
}

/** Protocol timeouts in milliseconds; tests shorten them. */
export interface TransferTiming {
  /** A sender waits this long for the receiver to ask for the first block. */
  start: number;
  /** A receiver repeats its start request this often. */
  startInterval: number;
  /** Silence tolerated in the middle of a transfer. */
  reply: number;
  /** Gap tolerated between the bytes of one block. */
  byte: number;
  retries: number;
}

export const DEFAULT_TIMING: TransferTiming = {
  start: 60_000,
  startInterval: 3_000,
  reply: 10_000,
  byte: 1_000,
  retries: 10,
};

export interface TransferContext {
  input: TransferInput;
  output: TransferOutput;
  signal: AbortSignal;
  progress(update: TransferProgress): void;
  timing?: Partial<TransferTiming>;
}

export function timingOf(ctx: TransferContext): TransferTiming {
  return { ...DEFAULT_TIMING, ...ctx.timing };
}

const CAN = 0x18;
const BS = 0x08;

/**
 * The abort sequence lrzsz sends: enough CANs to stop XMODEM, YMODEM and
 * ZMODEM receivers and senders, then backspaces that erase the CANs again
 * if a shell ends up echoing them.
 */
export const CANCEL_SEQUENCE = Buffer.from([...Array(10).fill(CAN), ...Array(10).fill(BS)]);

/** File name without any directory the sender included. */
export function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] || name;
}
