import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { TelnetProfile } from '@muxus/shared';
import type { TerminalTransport } from '../transports/terminal-transport.js';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

const OPT_BINARY = 0;
const OPT_ECHO = 1;
const OPT_SUPPRESS_GO_AHEAD = 3;
const OPT_TERMINAL_TYPE = 24;
const OPT_NAWS = 31;

const TERMINAL_TYPE_IS = 0;
const TERMINAL_TYPE_SEND = 1;
const DEFAULT_TERMINAL_TYPE = 'xterm-256color';
const CONNECT_TIMEOUT_MS = 20_000;

type ParserState = 'data' | 'iac' | 'option' | 'sb-option' | 'sb-data' | 'sb-iac';

/**
 * Incremental Telnet codec. Negotiation bytes are consumed and answered,
 * while application bytes are emitted for xterm. State deliberately spans
 * TCP chunks because IAC commands and sub-negotiations can be fragmented at
 * any byte boundary.
 */
export class TelnetCodec {
  private state: ParserState = 'data';
  private command = 0;
  private subOption = 0;
  private subData: number[] = [];
  private readonly remoteEnabled = new Set<number>();
  private readonly localEnabled = new Set<number>();
  private pendingCr = false;

  constructor(
    private cols: number,
    private rows: number,
    private readonly send: (data: Buffer) => void,
    private readonly receive: (data: Buffer) => void,
  ) {}

  feed(chunk: Buffer): void {
    const output: number[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) this.state = 'iac';
          else this.pushApplicationByte(byte, output);
          break;
        case 'iac':
          if (byte === IAC) {
            this.pushApplicationByte(IAC, output);
            this.state = 'data';
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.command = byte;
            this.state = 'option';
          } else if (byte === SB) {
            this.state = 'sb-option';
          } else {
            // NOP, GA, AYT and other two-byte commands carry no terminal data.
            this.state = 'data';
          }
          break;
        case 'option':
          this.negotiate(this.command, byte);
          this.state = 'data';
          break;
        case 'sb-option':
          this.subOption = byte;
          this.subData = [];
          this.state = 'sb-data';
          break;
        case 'sb-data':
          if (byte === IAC) this.state = 'sb-iac';
          else this.subData.push(byte);
          break;
        case 'sb-iac':
          if (byte === IAC) {
            this.subData.push(IAC);
            this.state = 'sb-data';
          } else if (byte === SE) {
            this.subnegotiate(this.subOption, this.subData);
            this.state = 'data';
          } else {
            // Malformed sub-negotiation: discard it and resynchronize.
            this.state = 'data';
          }
          break;
      }
    }
    if (output.length > 0) this.receive(Buffer.from(output));
  }

  encode(data: Buffer): Buffer {
    const output: number[] = [];
    const binary = this.localEnabled.has(OPT_BINARY);
    for (let i = 0; i < data.length; i++) {
      const byte = data[i]!;
      if (!binary && byte === 13) {
        this.pushEscaped(13, output);
        if (data[i + 1] !== 10) this.pushEscaped(10, output);
        continue;
      }
      if (!binary && byte === 10 && data[i - 1] !== 13) this.pushEscaped(13, output);
      this.pushEscaped(byte, output);
    }
    return Buffer.from(output);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.localEnabled.has(OPT_NAWS)) this.sendWindowSize();
  }

  flush(): void {
    if (!this.pendingCr) return;
    this.pendingCr = false;
    this.receive(Buffer.from([13]));
  }

  private negotiate(command: number, option: number): void {
    if (command === WILL) {
      const supported =
        option === OPT_BINARY || option === OPT_ECHO || option === OPT_SUPPRESS_GO_AHEAD;
      if (supported) {
        if (!this.remoteEnabled.has(option)) {
          this.remoteEnabled.add(option);
          this.sendCommand(DO, option);
        }
      } else {
        this.sendCommand(DONT, option);
      }
      return;
    }

    if (command === WONT) {
      if (this.remoteEnabled.delete(option)) this.sendCommand(DONT, option);
      return;
    }

    if (command === DO) {
      const supported =
        option === OPT_BINARY ||
        option === OPT_SUPPRESS_GO_AHEAD ||
        option === OPT_TERMINAL_TYPE ||
        option === OPT_NAWS;
      if (supported) {
        if (!this.localEnabled.has(option)) {
          this.localEnabled.add(option);
          this.sendCommand(WILL, option);
        }
        if (option === OPT_NAWS) this.sendWindowSize();
      } else {
        this.sendCommand(WONT, option);
      }
      return;
    }

    if (this.localEnabled.delete(option)) this.sendCommand(WONT, option);
  }

  private subnegotiate(option: number, data: number[]): void {
    if (
      option !== OPT_TERMINAL_TYPE ||
      !this.localEnabled.has(OPT_TERMINAL_TYPE) ||
      data[0] !== TERMINAL_TYPE_SEND
    ) {
      return;
    }
    const terminal = Buffer.from(DEFAULT_TERMINAL_TYPE, 'ascii');
    this.sendSubnegotiation(OPT_TERMINAL_TYPE, Buffer.concat([Buffer.from([TERMINAL_TYPE_IS]), terminal]));
  }

  private sendWindowSize(): void {
    const size = Buffer.allocUnsafe(4);
    size.writeUInt16BE(Math.min(65_535, Math.max(1, this.cols)), 0);
    size.writeUInt16BE(Math.min(65_535, Math.max(1, this.rows)), 2);
    this.sendSubnegotiation(OPT_NAWS, size);
  }

  private sendCommand(command: number, option: number): void {
    this.send(Buffer.from([IAC, command, option]));
  }

  private sendSubnegotiation(option: number, data: Buffer): void {
    const escaped: number[] = [];
    for (const byte of data) this.pushEscaped(byte, escaped);
    this.send(Buffer.from([IAC, SB, option, ...escaped, IAC, SE]));
  }

  private pushEscaped(byte: number, output: number[]): void {
    output.push(byte);
    if (byte === IAC) output.push(IAC);
  }

  private pushApplicationByte(byte: number, output: number[]): void {
    if (this.remoteEnabled.has(OPT_BINARY)) {
      if (this.pendingCr) {
        output.push(13);
        this.pendingCr = false;
      }
      output.push(byte);
      return;
    }
    if (this.pendingCr) {
      output.push(13);
      this.pendingCr = false;
      if (byte === 0) return;
    }
    if (byte === 13) this.pendingCr = true;
    else output.push(byte);
  }
}

export class TelnetTransport extends EventEmitter implements TerminalTransport {
  private readonly codec: TelnetCodec;
  private ended = false;
  private closed = false;
  private pendingError: Error | undefined;
  private readonly pendingData: Buffer[] = [];

  private constructor(
    private readonly socket: net.Socket,
    cols: number,
    rows: number,
  ) {
    super();
    this.codec = new TelnetCodec(
      cols,
      rows,
      (data) => socket.write(data),
      (data) => this.deliver(data),
    );
    socket.on('data', (data) => this.codec.feed(data));
    socket.on('error', (error) => {
      if (this.listenerCount('transport-error') > 0) this.emit('transport-error', error);
      else this.pendingError = error;
    });
    socket.on('close', () => {
      this.codec.flush();
      this.closed = true;
      this.emit('transport-close');
    });
  }

  static connect(profile: TelnetProfile, cols: number, rows: number): Promise<TelnetTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: profile.host, port: profile.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Telnet connection to ${profile.host}:${profile.port} timed out`));
      }, CONNECT_TIMEOUT_MS);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(friendlyTelnetError(error, profile));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        resolve(new TelnetTransport(socket, cols, rows));
      });
    });
  }

  write(data: Buffer): void {
    if (!this.ended) this.socket.write(this.codec.encode(data));
  }

  resize(cols: number, rows: number): void {
    this.codec.resize(cols, rows);
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.socket.destroy();
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

  private deliver(data: Buffer): void {
    if (this.listenerCount('data') > 0) this.emit('data', data);
    else this.pendingData.push(data);
  }
}

function friendlyTelnetError(error: Error, profile: TelnetProfile): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED') {
    return new Error(`Telnet connection refused by ${profile.host}:${profile.port}`);
  }
  if (code === 'ENOTFOUND') return new Error(`Telnet host not found: ${profile.host}`);
  if (code === 'ETIMEDOUT') {
    return new Error(`Telnet connection to ${profile.host}:${profile.port} timed out`);
  }
  return error;
}
