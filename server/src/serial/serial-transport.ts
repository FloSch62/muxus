import { EventEmitter } from 'node:events';
import type { SerialPort } from 'serialport';
import type { SerialProfile } from '@muxus/shared';
import { DEFAULT_BREAK_DURATION_MS } from '@muxus/shared/ws-protocol';
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
  private pendingError: Error | undefined;
  private readonly pendingData: Buffer[] = [];
  private breaking = false;
  private releaseBreak: ((then: () => void) => void) | undefined;

  private constructor(
    private readonly port: SerialPort,
    private readonly breakDurationMs: number,
  ) {
    super();
    port.on('data', (data: Buffer) => {
      if (this.listenerCount('data') > 0) this.emit('data', data);
      else this.pendingData.push(data);
    });
    port.on('error', (error: Error) => {
      if (this.listenerCount('transport-error') > 0) this.emit('transport-error', error);
      else this.pendingError = error;
    });
    port.on('close', () => {
      this.closed = true;
      this.emit('transport-close');
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

  private static async open(profile: SerialProfile): Promise<SerialTransport> {
    // Loaded on first use: the native binding would otherwise load (and on
    // Windows be scanned) on every app start, serial sessions or not.
    const { SerialPort } = await import('serialport');
    return new Promise((resolve, reject) => {
      const port = new SerialPort(serialOpenOptions(profile));
      port.open((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(new SerialTransport(port, profile.breakDurationMs ?? DEFAULT_BREAK_DURATION_MS));
      });
    });
  }

  write(data: Buffer): void {
    if (!this.ended && this.port.isOpen) this.port.write(data);
  }

  drain(): Promise<void> {
    if (this.ended || !this.port.isOpen) return Promise.resolve();
    // Waits for the bytes to be transmitted on the line, not just queued.
    return new Promise((resolve) => this.port.drain(() => resolve()));
  }

  resize(_cols: number, _rows: number): void {
    // Serial links have no standard window-size negotiation.
  }

  /** Hold the line in the break state for the host's break duration, then release it. */
  sendBreak(): Promise<void> {
    if (this.ended || !this.port.isOpen) {
      return Promise.reject(new Error('the serial port is not open'));
    }
    // A second press while the line is held changes nothing on the wire.
    if (this.breaking) return Promise.resolve();
    this.breaking = true;
    return new Promise((resolve, reject) => {
      this.port.set({ brk: true }, (error) => {
        if (error) {
          // The binding sets the modem lines after the break, so a failed
          // call may still have left the line in break: release it anyway.
          this.port.set({ brk: false }, () => {
            this.breaking = false;
            reject(error);
          });
          return;
        }
        if (this.ended) {
          this.breaking = false;
          resolve();
          return;
        }
        const release = (then?: () => void) => {
          clearTimeout(timer);
          this.releaseBreak = undefined;
          this.port.set({ brk: false }, (releaseError) => {
            this.breaking = false;
            if (releaseError) reject(releaseError);
            else resolve();
            then?.();
          });
        };
        const timer = setTimeout(release, this.breakDurationMs);
        this.releaseBreak = release;
      });
    });
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
    const closePort = () => {
      if (this.port.isOpen) this.port.close();
      else this.port.destroy();
    };
    // Not every driver clears a held break when the port closes.
    if (this.releaseBreak) this.releaseBreak(closePort);
    else closePort();
  }

  onData(listener: (data: Buffer) => void): () => void {
    this.on('data', listener);
    for (const data of this.pendingData.splice(0)) listener(data);
    return () => this.off('data', listener);
  }

  onClose(listener: () => void): () => void {
    this.on('transport-close', listener);
    if (this.closed) queueMicrotask(listener);
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
