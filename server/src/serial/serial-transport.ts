import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import type { SerialProfile } from '@muxus/shared';
import type { TerminalTransport } from '../transports/terminal-transport.js';

export function serialOpenOptions(profile: SerialProfile): ConstructorParameters<typeof SerialPort>[0] {
  return {
    path: profile.path,
    baudRate: profile.baudRate,
    dataBits: profile.dataBits,
    stopBits: profile.stopBits,
    parity: profile.parity,
    rtscts: profile.flowControl === 'hardware',
    xon: profile.flowControl === 'software',
    xoff: profile.flowControl === 'software',
    xany: false,
    lock: true,
    autoOpen: false,
  };
}

const BUSY_RETRY_TOTAL_MS = 2500;
const BUSY_RETRY_DELAY_MS = 150;

function isSerialBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EBUSY' || /cannot lock port|resource busy|access is denied/i.test(error.message);
}

export class SerialTransport extends EventEmitter implements TerminalTransport {
  private ended = false;
  private closed = false;
  private closeError: Error | undefined;
  private pendingError: Error | undefined;
  private readonly pendingData: Buffer[] = [];

  private constructor(private readonly port: SerialPort) {
    super();
    port.on('data', (data: Buffer) => {
      if (this.listenerCount('data') > 0) this.emit('data', data);
      else this.pendingData.push(data);
    });
    port.on('error', (error: Error) => {
      if (this.listenerCount('transport-error') > 0) this.emit('transport-error', error);
      else this.pendingError = error;
    });
    port.on('close', (error?: Error | null) => {
      this.closed = true;
      this.closeError = error ?? undefined;
      this.emit('transport-close', this.closeError);
    });
  }

  static async connect(profile: SerialProfile): Promise<SerialTransport> {
    // Replacing a live session reopens the device while the previous fd is
    // still releasing its exclusive lock (close and open race on separate
    // connections), so a busy port gets a short grace period before failing.
    const deadline = Date.now() + BUSY_RETRY_TOTAL_MS;
    for (;;) {
      try {
        return await SerialTransport.open(profile);
      } catch (error) {
        if (!isSerialBusyError(error) || Date.now() >= deadline) {
          throw friendlySerialError(error as Error, profile.path);
        }
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
      }
    }
  }

  private static open(profile: SerialProfile): Promise<SerialTransport> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort(serialOpenOptions(profile));
      port.open((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(new SerialTransport(port));
      });
    });
  }

  write(data: Buffer): void {
    if (!this.ended && this.port.isOpen) this.port.write(data);
  }

  resize(_cols: number, _rows: number): void {
    // Serial links have no standard window-size negotiation.
  }

  pause(): void {
    this.port.pause();
  }

  resume(): void {
    this.port.resume();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.port.isOpen) this.port.close();
    else this.port.destroy();
  }

  onData(listener: (data: Buffer) => void): () => void {
    this.on('data', listener);
    for (const data of this.pendingData.splice(0)) listener(data);
    return () => this.off('data', listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.on('transport-close', listener);
    if (this.closed) queueMicrotask(() => listener(this.closeError));
    return () => this.off('transport-close', listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.on('transport-error', listener);
    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = undefined;
      queueMicrotask(() => listener(error));
    }
    return () => this.off('transport-error', listener);
  }
}

function friendlySerialError(error: Error, path: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || /permission denied/i.test(error.message)) {
    const hint =
      process.platform === 'linux'
        ? ' Check that your user belongs to the device’s serial-access group (commonly dialout or uucp).'
        : '';
    return new Error(`Permission denied opening serial port ${path}.${hint}`);
  }
  if (code === 'ENOENT' || /no such file|file not found/i.test(error.message)) {
    return new Error(`Serial port not found: ${path}`);
  }
  if (/cannot lock port|resource busy|access is denied/i.test(error.message)) {
    return new Error(`Serial port is already in use: ${path}`);
  }
  return error;
}
