/**
 * Byte-oriented terminal transport shared by Telnet and serial sessions.
 * SSH and local PTYs have richer native APIs and remain attached directly.
 */
export interface TerminalTransport {
  write(data: Buffer): void;
  /** Settle once everything written so far has left for the remote end. */
  drain(): Promise<void>;
  resize(cols: number, rows: number): void;
  /** Signal BREAK: a held break condition on a serial line, IAC BRK on Telnet. */
  sendBreak(): Promise<void>;
  pause(): void;
  resume(): void;
  close(): void;
  onData(listener: (data: Buffer) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}
