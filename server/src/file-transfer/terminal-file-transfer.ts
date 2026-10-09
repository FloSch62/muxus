import { nanoid } from 'nanoid';
import type {
  FileTransferProtocol,
  FileTransferState,
  TerminalClientMessage,
  TerminalServerMessage,
} from '@muxus/shared/ws-protocol';
import type { StagedFiles } from './staged-files.js';
import {
  CANCEL_SEQUENCE,
  RemoteCancelError,
  TransferCancelledError,
  TransferInput,
  TransferTimeoutError,
  type IncomingFile,
  type IncomingFileInfo,
  type OutgoingFile,
  type TransferContext,
  type TransferProgress,
  type TransferTiming,
} from './transfer-io.js';
import { xmodemReceive, xmodemSend, ymodemReceive, ymodemSend } from './xymodem.js';
import { hexHeaderFrom, zmodemReceive, zmodemSend, ZRINIT, type ZmodemFileInfo } from './zmodem.js';
import { ZmodemDetector, type ZmodemDetection } from './zmodem-detector.js';

/** The terminal's byte transport as a transfer sees it. */
export interface TransferLink {
  /** Bytes for the remote side, written without any newline translation. */
  write(data: Buffer): void;
  /** Resolves once the transport can take more; undefined when it already can. */
  drain(): Promise<void> | undefined;
  pause(): void;
  resume(): void;
  /** Make the line 8-bit clean for the transfer; resolves to the undo. */
  binary?(): Promise<() => void>;
}

export interface TerminalFileTransferOptions {
  link: TransferLink;
  /** Output for the terminal (and the session log). */
  display(data: Buffer): void;
  send(message: TerminalServerMessage): void;
  /** A line for session history and log files. */
  note(message: string): void;
  files: StagedFiles;
  timing?: Partial<TransferTiming>;
  /** Quiet time that ends the cleanup after a cancelled transfer. */
  settleQuietMs?: number;
}

type StartMessage = Extract<TerminalClientMessage, { op: 'file-transfer-start' }>;

const PROGRESS_INTERVAL_MS = 250;
/** Held-back output that might begin a ZMODEM header is shown after this much quiet. */
const HOLD_FLUSH_MS = 250;
const SETTLE_QUIET_MS = 500;
const SETTLE_LIMIT_MS = 5_000;
const SETTLE_TAIL_BYTES = 4096;
/** At most this much of the remote's text is shown again after a cancel. */
const SALVAGE_BYTES = 512;
const SALVAGE_LINES = 3;
/** A sender waits about a minute after offering a file; answer before it gives up. */
const OFFER_TIMEOUT_MS = 55_000;
/** A transport that takes no data for this long has a far end that stopped reading. */
const DRAIN_TIMEOUT_MS = 60_000;
const INPUT_HIGH_WATER = 8 * 1024 * 1024;
const INPUT_LOW_WATER = 1024 * 1024;

const PROTOCOL_NAMES: Record<FileTransferProtocol, string> = {
  xmodem: 'XMODEM',
  'xmodem-crc': 'XMODEM-CRC',
  'xmodem-1k': 'XMODEM-1K',
  ymodem: 'YMODEM',
  zmodem: 'ZMODEM',
};

interface ActiveTransfer {
  state: FileTransferState;
  input: TransferInput;
  abort: AbortController;
  /** Pending answer to a ZMODEM offer. */
  answer?: (message: StartMessage | undefined) => void;
  /** Staged uploads this transfer owns. */
  uploads: string[];
  /** The user declined an offer and the protocol wound down cleanly. */
  declined?: boolean;
  lastSentAt: number;
  /** Bytes of earlier files in the batch, for the transfer rate. */
  doneBytes: number;
  sampleAt: number;
  sampleBytes: number;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * The visible end of what arrived while a cancelled transfer wound down:
 * usually the remote side's message and prompt after the protocol bytes.
 * Capped at a few short lines, so file content still in flight stays off
 * the screen and out of the log.
 */
export function printableTail(data: Buffer): Buffer {
  let start = data.length;
  let lines = 0;
  while (start > 0 && data.length - start < SALVAGE_BYTES) {
    const byte = data[start - 1]!;
    const printable =
      (byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x1b || byte === 0x07;
    if (!printable) break;
    if (byte === 0x0a && ++lines > SALVAGE_LINES) break;
    start--;
  }
  return data.subarray(start);
}

/**
 * XMODEM, YMODEM and ZMODEM on one terminal's raw byte stream. Remote output
 * passes through `output()`: normally on to the terminal, watched for the
 * header `sz` and `rz` start with; during a transfer, into the protocol, so
 * none of it reaches the terminal, session history or log files. Keystrokes
 * are held off (`busy`) for the same span.
 */
export class TerminalFileTransfers {
  private readonly detector = new ZmodemDetector();
  private holdTimer: NodeJS.Timeout | undefined;
  private active: ActiveTransfer | undefined;
  private settling:
    | { tail: Buffer[]; tailBytes: number; quiet: NodeJS.Timeout; deadline: number; finish: () => void }
    | undefined;
  private inputPaused = false;
  private closed = false;

  constructor(private readonly options: TerminalFileTransferOptions) {}

  /** True while terminal input must not reach the remote side. */
  get busy(): boolean {
    return this.active !== undefined || this.settling !== undefined;
  }

  output(chunk: Buffer): void {
    if (this.closed) return;
    if (this.active) {
      this.active.input.push(chunk);
      return;
    }
    if (this.settling) {
      this.settle(chunk);
      return;
    }
    this.watch(chunk);
  }

  /** Handles the file transfer control frames; false for anything else. */
  control(message: TerminalClientMessage): boolean {
    if (message.op === 'file-transfer-start') {
      void this.start(message);
      return true;
    }
    if (message.op === 'file-transfer-cancel') {
      this.cancel();
      return true;
    }
    return false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.settling) clearTimeout(this.settling.quiet);
    this.settling = undefined;
    const active = this.active;
    if (active) {
      active.answer?.(undefined);
      active.abort.abort();
    }
  }

  private watch(chunk: Buffer): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }
    const { output, detection } = this.detector.feed(chunk);
    if (output.length) this.options.display(output);
    if (detection) {
      this.autoStart(detection);
      return;
    }
    if (this.detector.holding) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = undefined;
        const held = this.detector.flush();
        if (held.length && !this.closed) this.options.display(held);
      }, HOLD_FLUSH_MS);
      this.holdTimer.unref?.();
    }
  }

  private begin(
    direction: FileTransferState['direction'],
    protocol: FileTransferProtocol,
    automatic: boolean,
    phase: FileTransferState['phase'],
  ): ActiveTransfer {
    const abort = new AbortController();
    const active: ActiveTransfer = {
      state: {
        id: nanoid(12),
        direction,
        protocol,
        phase,
        automatic,
        bytes: 0,
        bytesPerSecond: 0,
        received: [],
      },
      input: new TransferInput(abort.signal, (buffered) => this.inputLevel(buffered)),
      abort,
      uploads: [],
      lastSentAt: 0,
      doneBytes: 0,
      sampleAt: Date.now(),
      sampleBytes: 0,
    };
    this.active = active;
    this.publish(active, true);
    return active;
  }

  private autoStart(detection: ZmodemDetection): void {
    if (detection.type === ZRINIT) {
      // `rz` waits for files: the renderer asks the user to pick some.
      const active = this.begin('send', 'zmodem', true, 'offer');
      const answered = this.expectAnswer(active);
      active.input.push(detection.rest);
      const header = hexHeaderFrom(detection.type, detection.data);
      void this.run(active, async (ctx) => {
        const answer = await this.awaitAnswer(active, ctx, false, answered);
        if (!answer?.files?.length || answer.direction !== 'send') throw new TransferCancelledError();
        active.state.phase = 'waiting';
        active.sampleAt = Date.now();
        const files = await this.openUploads(active, answer.files);
        try {
          const result = await zmodemSend(ctx, files.map((entry) => entry.file), { receiverInit: header });
          if (result.skipped.length) active.state.skipped = result.skipped;
        } finally {
          await Promise.all(files.map((entry) => entry.close()));
        }
      });
      return;
    }
    // `sz` offers files: answer ZRINIT to learn what it sends, then ask.
    const active = this.begin('receive', 'zmodem', true, 'waiting');
    active.input.push(detection.rest);
    void this.run(active, (ctx) =>
      zmodemReceive(ctx, {
        open: async (info: ZmodemFileInfo, index: number) => {
          if (index === 1) {
            Object.assign(active.state, {
              phase: 'offer',
              fileName: info.name,
              fileIndex: 1,
              fileCount: info.filesLeft,
              total: info.size,
              batchTotal: info.bytesLeft,
            } satisfies Partial<FileTransferState>);
            const answered = this.expectAnswer(active);
            this.publish(active, true);
            const answer = await this.awaitAnswer(active, ctx, true, answered);
            if (answer?.direction !== 'receive') {
              // Skipping every file lets `sz` finish normally.
              active.declined = true;
              active.state.message = 'Declined.';
              return undefined;
            }
            active.state.phase = 'transferring';
            active.sampleAt = Date.now();
          }
          if (active.declined) return undefined;
          return this.openIncoming(active, info);
        },
      }),
    );
  }

  /** Take the user's answer from the moment the offer is out, even mid-setup. */
  private expectAnswer(active: ActiveTransfer): Promise<StartMessage | undefined> {
    return new Promise((resolve) => {
      active.answer = (message) => {
        active.answer = undefined;
        resolve(message);
      };
    });
  }

  /**
   * Wait for the user to accept or decline an offer. Anything the remote
   * side sends meanwhile (a sender only sends its abort) ends the wait.
   */
  private async awaitAnswer(
    active: ActiveTransfer,
    ctx: TransferContext,
    stopOnInput: boolean,
    answer: Promise<StartMessage | undefined>,
  ): Promise<StartMessage | undefined> {
    const watchers: Array<Promise<StartMessage | undefined>> = [answer];
    let timer: NodeJS.Timeout | undefined;
    watchers.push(
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TransferTimeoutError('No answer to the transfer request.')),
          OFFER_TIMEOUT_MS,
        );
      }),
    );
    const stop = new AbortController();
    if (stopOnInput) {
      // A waiting sender is silent apart from flow control; CANs mean it gave up.
      watchers.push(
        (async () => {
          let cancels = 0;
          for (;;) {
            await ctx.input.wait(OFFER_TIMEOUT_MS * 2, stop.signal);
            if (ctx.input.tryByte() !== 0x18) cancels = 0;
            else if (++cancels >= 2) throw new RemoteCancelError('The remote side stopped waiting.');
          }
        })(),
      );
    } else {
      watchers.push(
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new TransferCancelledError());
          ctx.signal.addEventListener('abort', onAbort, { once: true });
          stop.signal.addEventListener('abort', () => ctx.signal.removeEventListener('abort', onAbort), {
            once: true,
          });
        }),
      );
    }
    try {
      return await Promise.race(watchers);
    } finally {
      clearTimeout(timer);
      stop.abort();
      active.answer = undefined;
    }
  }

  private async start(message: StartMessage): Promise<void> {
    const active = this.active;
    if (active?.answer) {
      active.answer(message);
      return;
    }
    if (active || this.settling || this.closed) {
      await this.dropUploads(message.files);
      return;
    }
    const { protocol, direction } = message;
    if (direction === 'send') {
      if (!message.files?.length) return;
      const transfer = this.begin('send', protocol, false, 'waiting');
      void this.run(transfer, async (ctx) => {
        const ids = protocol === 'ymodem' || protocol === 'zmodem' ? message.files! : message.files!.slice(0, 1);
        await this.dropUploads(message.files!.filter((id) => !ids.includes(id)));
        const files = await this.openUploads(transfer, ids);
        const outgoing = files.map((entry) => entry.file);
        try {
          if (protocol === 'zmodem') {
            const result = await zmodemSend(ctx, outgoing, { announce: true });
            if (result.skipped.length) transfer.state.skipped = result.skipped;
          } else if (protocol === 'ymodem') {
            await ymodemSend(ctx, outgoing);
          } else {
            await xmodemSend(ctx, outgoing[0]!, { blockSize: protocol === 'xmodem-1k' ? 1024 : 128 });
          }
        } finally {
          await Promise.all(files.map((entry) => entry.close()));
        }
      });
      return;
    }

    const transfer = this.begin('receive', protocol, false, 'waiting');
    void this.run(transfer, async (ctx) => {
      if (protocol === 'zmodem') {
        await zmodemReceive(ctx, { open: (info) => this.openIncoming(transfer, info) });
      } else if (protocol === 'ymodem') {
        await ymodemReceive(ctx, (info) => this.openIncoming(transfer, info));
      } else {
        const name = message.fileName ?? 'xmodem.bin';
        transfer.state.fileName = name;
        await xmodemReceive(ctx, await this.openIncoming(transfer, { name }), {
          crc: protocol !== 'xmodem',
          fileName: name,
        });
      }
    });
  }

  private cancel(): void {
    const active = this.active;
    if (!active || active.abort.signal.aborted) return;
    if (active.answer) {
      active.answer(undefined);
      return;
    }
    active.state.phase = 'cancelling';
    this.publish(active, true);
    active.abort.abort();
  }

  private async run(active: ActiveTransfer, body: (ctx: TransferContext) => Promise<void>): Promise<void> {
    const { link } = this.options;
    const ctx: TransferContext = {
      input: active.input,
      output: {
        write: (data) => {
          if (!active.abort.signal.aborted && !this.closed) link.write(data);
        },
        drain: () => this.drain(active),
      },
      signal: active.abort.signal,
      progress: (update) => this.progress(active, update),
      ...(this.options.timing ? { timing: this.options.timing } : {}),
    };
    let restore: (() => void) | undefined;
    let outcome: 'complete' | 'cancelled' | 'failed' = 'complete';
    let sendCancel = false;
    try {
      restore = await link.binary?.();
      await body(ctx);
      if (active.declined) outcome = 'cancelled';
    } catch (error) {
      if (error instanceof TransferCancelledError) {
        outcome = 'cancelled';
        sendCancel = true;
      } else {
        outcome = 'failed';
        sendCancel = !(error instanceof RemoteCancelError);
        active.state.message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      await this.dropUploads(active.uploads);
    }
    if (this.closed) return;
    const leftover = active.input.takeRemaining();
    this.inputLevel(0);
    const finish = () => {
      restore?.();
      this.active = undefined;
      active.state.phase = outcome;
      active.state.bytesPerSecond = 0;
      this.publish(active, true);
      this.options.note(this.summary(active));
    };
    if (outcome === 'complete' || active.declined) {
      finish();
      if (leftover.length) this.watch(leftover);
      return;
    }
    if (sendCancel) link.write(CANCEL_SEQUENCE);
    // Let protocol bytes still in flight drain away before the terminal
    // shows output again; keep what looks like the remote's own text.
    this.active = undefined;
    this.beginSettle(leftover, finish);
  }

  /**
   * Wait for the transport to take more, but never past a cancel or a far
   * end that stopped reading altogether.
   */
  private drain(active: ActiveTransfer): Promise<void> {
    const { signal } = active.abort;
    if (signal.aborted) return Promise.reject(new TransferCancelledError());
    const pending = this.options.link.drain();
    if (!pending) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        done();
        reject(new TransferCancelledError());
      };
      const timer = setTimeout(() => {
        done();
        reject(new TransferTimeoutError('The remote side stopped reading.'));
      }, DRAIN_TIMEOUT_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        () => {
          done();
          resolve();
        },
        (error: unknown) => {
          done();
          reject(error);
        },
      );
    });
  }

  private beginSettle(leftover: Buffer, finish: () => void): void {
    const quietMs = this.options.settleQuietMs ?? SETTLE_QUIET_MS;
    const settling = {
      tail: leftover.length ? [leftover] : [],
      tailBytes: leftover.length,
      quiet: setTimeout(() => this.endSettle(), quietMs),
      deadline: Date.now() + SETTLE_LIMIT_MS,
      finish,
    };
    settling.quiet.unref?.();
    this.settling = settling;
  }

  private settle(chunk: Buffer): void {
    const settling = this.settling!;
    settling.tail.push(chunk);
    settling.tailBytes += chunk.length;
    while (settling.tailBytes - settling.tail[0]!.length >= SETTLE_TAIL_BYTES) {
      settling.tailBytes -= settling.tail.shift()!.length;
    }
    if (Date.now() >= settling.deadline) {
      this.endSettle();
      return;
    }
    clearTimeout(settling.quiet);
    settling.quiet = setTimeout(() => this.endSettle(), this.options.settleQuietMs ?? SETTLE_QUIET_MS);
    settling.quiet.unref?.();
  }

  private endSettle(): void {
    const settling = this.settling;
    if (!settling) return;
    clearTimeout(settling.quiet);
    this.settling = undefined;
    settling.finish();
    const text = printableTail(Buffer.concat(settling.tail));
    if (text.length && !this.closed) this.options.display(Buffer.concat([Buffer.from('\r\n'), text]));
  }

  private inputLevel(buffered: number): void {
    if (!this.inputPaused && buffered > INPUT_HIGH_WATER) {
      this.inputPaused = true;
      this.options.link.pause();
    } else if (this.inputPaused && buffered < INPUT_LOW_WATER) {
      this.inputPaused = false;
      this.options.link.resume();
    }
  }

  private progress(active: ActiveTransfer, update: TransferProgress): void {
    const { state } = active;
    if (update.fileIndex !== state.fileIndex && state.fileIndex !== undefined) {
      active.doneBytes += state.bytes;
    }
    const fileChanged = update.fileIndex !== state.fileIndex;
    state.fileName = update.fileName ?? state.fileName;
    state.fileIndex = update.fileIndex;
    state.fileCount = update.fileCount ?? state.fileCount;
    state.bytes = update.bytes;
    state.total = update.total;
    const phaseChanged = state.phase === 'waiting' && update.bytes > 0;
    if (phaseChanged) state.phase = 'transferring';
    const now = Date.now();
    const moved = active.doneBytes + update.bytes;
    const elapsed = now - active.sampleAt;
    if (elapsed >= PROGRESS_INTERVAL_MS) {
      const instant = ((moved - active.sampleBytes) * 1000) / elapsed;
      state.bytesPerSecond =
        state.bytesPerSecond > 0 ? state.bytesPerSecond * 0.7 + Math.max(0, instant) * 0.3 : Math.max(0, instant);
      active.sampleAt = now;
      active.sampleBytes = moved;
    }
    this.publish(active, phaseChanged || fileChanged);
  }

  private publish(active: ActiveTransfer, force = false): void {
    const now = Date.now();
    if (!force && now - active.lastSentAt < PROGRESS_INTERVAL_MS) return;
    active.lastSentAt = now;
    this.options.send({
      op: 'file-transfer',
      transfer: { ...active.state, received: [...active.state.received] },
    });
  }

  private async openUploads(
    active: ActiveTransfer,
    ids: string[],
  ): Promise<Array<{ file: OutgoingFile; close(): Promise<void> }>> {
    active.uploads.push(...ids);
    const opened: Array<{ file: OutgoingFile; close(): Promise<void> }> = [];
    try {
      for (const id of ids) opened.push(await this.options.files.outgoing(id));
    } catch (error) {
      await Promise.all(opened.map((entry) => entry.close()));
      throw error;
    }
    const first = opened[0]?.file;
    Object.assign(active.state, {
      fileName: first?.name,
      fileIndex: 1,
      fileCount: opened.length,
      total: first?.size,
      batchTotal: opened.reduce((sum, entry) => sum + entry.file.size, 0),
    } satisfies Partial<FileTransferState>);
    this.publish(active, true);
    return opened;
  }

  private async openIncoming(active: ActiveTransfer, info: IncomingFileInfo): Promise<IncomingFile> {
    const name = info.name ?? 'received.bin';
    const { file, staged } = await this.options.files.incoming(name);
    void staged.then((result) => {
      if (!result || this.closed) return;
      active.state.received.push({ id: result.id, name: result.name, size: result.size });
      this.publish(active, true);
    });
    return file;
  }

  private async dropUploads(ids: readonly string[] | undefined): Promise<void> {
    if (!ids) return;
    await Promise.all(ids.map((id) => this.options.files.remove(id).catch(() => undefined)));
  }

  private summary(active: ActiveTransfer): string {
    const { state } = active;
    const protocol = PROTOCOL_NAMES[state.protocol];
    if (state.phase === 'complete') {
      if (state.direction === 'receive') {
        const files = state.received.map((file) => `${file.name} (${formatBytes(file.size)})`).join(', ');
        return `${protocol}: received ${files || 'no files'}`;
      }
      const sent = state.fileCount === 1 && state.fileName ? state.fileName : `${state.fileCount ?? 0} files`;
      const skipped = state.skipped?.length ? `; skipped ${state.skipped.join(', ')}` : '';
      return `${protocol}: sent ${sent}${skipped}`;
    }
    if (state.phase === 'cancelled') return `${protocol} transfer cancelled`;
    return `${protocol} transfer failed: ${state.message ?? 'unknown error'}`;
  }
}
