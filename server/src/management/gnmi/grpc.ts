import http2 from 'node:http2';
import { EventEmitter } from 'node:events';

/**
 * A minimal gRPC client over node:http2, enough for gNMI's unary calls and
 * its bidirectional Subscribe stream. Muxus owns the connection underneath
 * (TCP, an SSH channel, its own TLS with pinning), which grpc-js does not
 * let a caller do; gRPC itself is only framing and a few headers:
 * length-prefixed messages in both directions and the status in trailers.
 */

export const GRPC_STATUS_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

export const GrpcCode = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  RESOURCE_EXHAUSTED: 8,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export class GrpcError extends Error {
  readonly codeName: string;

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message || GRPC_STATUS_NAMES[code] || `gRPC status ${code}`);
    this.name = 'GrpcError';
    this.codeName = GRPC_STATUS_NAMES[code] ?? `STATUS_${code}`;
  }
}

function httpStatusToGrpc(status: number): number {
  switch (status) {
    case 400:
      return GrpcCode.INTERNAL;
    case 401:
      return GrpcCode.UNAUTHENTICATED;
    case 403:
      return 7;
    case 404:
      return GrpcCode.UNIMPLEMENTED;
    case 429:
    case 502:
    case 503:
    case 504:
      return GrpcCode.UNAVAILABLE;
    default:
      return GrpcCode.UNKNOWN;
  }
}

function decodeGrpcMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** One gRPC message: a compression flag, a big-endian length, the payload. */
export function frameMessage(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Reassembles gRPC messages from HTTP/2 DATA chunks of any size. */
export class GrpcFrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  /** Length of the message whose header was read while its body is still arriving. */
  private pending: number | undefined;

  push(chunk: Buffer): Buffer[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const messages: Buffer[] = [];
    for (;;) {
      if (this.pending === undefined) {
        if (this.buffered < 5) break;
        const head = this.take(5);
        if (head[0] !== 0) {
          throw new GrpcError(GrpcCode.INTERNAL, 'The device sent a compressed message, which Muxus did not ask for.');
        }
        this.pending = head.readUInt32BE(1);
      }
      if (this.buffered < this.pending) break;
      messages.push(this.take(this.pending));
      this.pending = undefined;
    }
    return messages;
  }

  /**
   * The next `length` bytes. Each byte is copied at most once, however small
   * the chunks a large message arrives in.
   */
  private take(length: number): Buffer {
    this.buffered -= length;
    if (length === 0) return Buffer.alloc(0);
    const first = this.chunks[0]!;
    if (first.length >= length) {
      if (first.length === length) this.chunks.shift();
      else this.chunks[0] = first.subarray(length);
      return first.subarray(0, length);
    }
    const out = Buffer.allocUnsafe(length);
    let filled = 0;
    let used = 0;
    while (filled < length) {
      const chunk = this.chunks[used]!;
      const need = length - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        used += 1;
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[used] = chunk.subarray(need);
        filled = length;
      }
    }
    this.chunks.splice(0, used);
    return out;
  }
}

export interface GrpcCallOptions {
  /** Deadline for the whole call, sent as grpc-timeout. */
  timeoutMs?: number;
  /** Fail with RESOURCE_EXHAUSTED once the response passes this many bytes. */
  maxBytes?: number;
}

/**
 * One call. Emits `message` (Buffer) for each response message and `end`
 * exactly once with a GrpcError, or undefined for OK.
 */
export class GrpcCall extends EventEmitter {
  /** Encoded response bytes received so far. */
  bytes = 0;
  private ended = false;
  private status: GrpcError | undefined | null = null;
  private readonly decoder = new GrpcFrameDecoder();

  constructor(
    private readonly stream: http2.ClientHttp2Stream,
    options: GrpcCallOptions,
  ) {
    super();
    stream.on('response', (headers) => {
      const httpStatus = Number(headers[':status']);
      if (httpStatus !== 200) {
        this.finish(new GrpcError(httpStatusToGrpc(httpStatus), `The device answered HTTP ${httpStatus}.`));
        return;
      }
      // Trailers-only responses carry the status in the headers.
      if (headers['grpc-status'] !== undefined) this.recordStatus(headers);
    });
    stream.on('trailers', (trailers) => this.recordStatus(trailers));
    stream.on('data', (chunk: Buffer) => {
      if (this.ended) return;
      this.bytes += chunk.length;
      if (options.maxBytes !== undefined && this.bytes > options.maxBytes) {
        this.cancel(
          new GrpcError(
            GrpcCode.RESOURCE_EXHAUSTED,
            `The response grew past ${formatBytes(options.maxBytes)}; ask for a narrower path.`,
          ),
        );
        return;
      }
      let messages: Buffer[];
      try {
        messages = this.decoder.push(chunk);
      } catch (err) {
        this.cancel(err as GrpcError);
        return;
      }
      for (const message of messages) this.emit('message', message);
    });
    stream.on('error', (err: Error) => {
      this.finish(new GrpcError(GrpcCode.UNAVAILABLE, err.message));
    });
    // The status ends the call even while this side still has requests open
    // (a device refusing a streaming call right away, say).
    stream.on('end', () => {
      if (this.status === null) return;
      this.finish(this.status);
      if (!stream.closed) stream.close();
    });
    stream.on('close', () => {
      if (this.status !== null) {
        this.finish(this.status);
        return;
      }
      const code = stream.rstCode;
      this.finish(
        new GrpcError(
          code === http2.constants.NGHTTP2_CANCEL ? GrpcCode.CANCELLED : GrpcCode.UNAVAILABLE,
          code ? `The stream was reset (HTTP/2 error ${code}).` : 'The device closed the stream without a status.',
        ),
      );
    });
  }

  private recordStatus(headers: http2.IncomingHttpHeaders): void {
    const code = Number(headers['grpc-status']);
    this.status = code === 0 ? undefined : new GrpcError(Number.isFinite(code) ? code : GrpcCode.UNKNOWN, decodeGrpcMessage(headers['grpc-message']));
  }

  private finish(error: GrpcError | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('end', error);
  }

  get done(): boolean {
    return this.ended;
  }

  write(message: Buffer): void {
    if (!this.ended && !this.stream.destroyed) this.stream.write(frameMessage(message));
  }

  /** Write and wait until HTTP/2 flow control has room again: backpressure for uploads. */
  writeDrained(message: Buffer): Promise<void> {
    if (this.ended || this.stream.destroyed) {
      return Promise.reject(new GrpcError(GrpcCode.UNAVAILABLE, 'The call has ended.'));
    }
    if (this.stream.write(frameMessage(message))) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onEnd = (error: GrpcError | undefined) => {
        cleanup();
        reject(error ?? new GrpcError(GrpcCode.UNAVAILABLE, 'The call has ended.'));
      };
      const cleanup = () => {
        this.stream.off('drain', onDrain);
        this.off('end', onEnd);
      };
      this.stream.once('drain', onDrain);
      this.once('end', onEnd);
    });
  }

  /** Half-close: no more requests from this side. */
  end(): void {
    if (!this.stream.destroyed) this.stream.end();
  }

  cancel(error = new GrpcError(GrpcCode.CANCELLED, 'Cancelled.')): void {
    this.finish(error);
    if (!this.stream.destroyed) this.stream.close(http2.constants.NGHTTP2_CANCEL);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export class GrpcChannel {
  /** Headers sent with every call (gNMI carries its login here). */
  metadata: Record<string, string> = {};

  constructor(
    private readonly session: http2.ClientHttp2Session,
    private readonly authority: string,
  ) {}

  /** Start a call; the caller writes the request(s) and ends its side. */
  call(method: string, options: GrpcCallOptions = {}): GrpcCall {
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': method,
      ':authority': this.authority,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-accept-encoding': 'identity',
      'user-agent': 'muxus-gnmi',
      ...this.metadata,
    };
    if (options.timeoutMs !== undefined) headers['grpc-timeout'] = `${Math.max(1, Math.round(options.timeoutMs))}m`;
    const stream = this.session.request(headers, { endStream: false });
    return new GrpcCall(stream, options);
  }

  /** One request, one response. */
  unary(
    method: string,
    request: Buffer,
    options: GrpcCallOptions & { signal?: AbortSignal } = {},
  ): Promise<{ message: Buffer; bytes: number }> {
    return new Promise((resolve, reject) => {
      const call = this.call(method, options);
      let response: Buffer | undefined;
      const onAbort = () => call.cancel();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      call.on('message', (message: Buffer) => {
        response = message;
      });
      call.once('end', (error: GrpcError | undefined) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else if (!response) reject(new GrpcError(GrpcCode.INTERNAL, 'The device sent no response message.'));
        else resolve({ message: response, bytes: call.bytes });
      });
      call.write(request);
      call.end();
    });
  }
}
