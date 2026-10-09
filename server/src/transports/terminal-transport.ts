/**
 * Byte-oriented terminal transport shared by Telnet and serial sessions.
 * SSH and local PTYs have richer native APIs and remain attached directly.
 */
export interface TerminalTransport {
  write(data: Buffer): void;
  /** Bytes for a file transfer, written without newline translation. */
  writeRaw(data: Buffer): void;
  /** Resolves once queued writes have gone out; undefined when nothing is queued. */
  drained(): Promise<void> | undefined;
  /** Make the line 8-bit clean for a file transfer; resolves to the undo. */
  binaryTransfer?(): Promise<() => void>;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  close(): void;
  onData(listener: (data: Buffer) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

/** A writable's drain, or its end, whichever comes first. */
export function writableDrained(stream: NodeJS.WritableStream & {
  writableNeedDrain?: boolean;
  writable?: boolean;
}): Promise<void> | undefined {
  if (!stream.writableNeedDrain || stream.writable === false) return undefined;
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      stream.off('error', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
    stream.on('error', done);
  });
}
