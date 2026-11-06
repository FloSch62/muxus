import type { Duplex } from 'node:stream';

export interface HttpResponse {
  status: number;
  /** Lower-cased header names; repeated headers joined with ', '. */
  headers: Map<string, string>;
  body: Buffer;
}

/**
 * HTTP/1.1 requests one after another over a single kept-alive socket. NTLM
 * authenticates the connection rather than each request, so a WinRM session
 * must stay on the socket that logged in — which a pooled client cannot
 * promise. Also works over an SSH gateway's channel.
 */
export class HttpConnection {
  private buffer = Buffer.alloc(0);
  private waiting: ((error?: Error) => void) | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: Error | undefined;

  constructor(
    private readonly socket: Duplex,
    private readonly host: string,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    const end = (error?: Error) => {
      this.failure ??= error ?? new Error('The WinRM server closed the connection.');
      this.wake(this.failure);
    };
    socket.on('error', end);
    socket.on('close', () => end());
    socket.on('end', () => end());
  }

  get closed(): boolean {
    return this.failure !== undefined;
  }

  close(): void {
    this.failure ??= new Error('The WinRM connection was closed.');
    this.socket.destroy();
  }

  /** Send one request; requests queue behind the one in flight. */
  request(path: string, headers: Record<string, string>, body: Buffer): Promise<HttpResponse> {
    const run = this.queue.then(() => this.exchange(path, headers, body));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exchange(path: string, headers: Record<string, string>, body: Buffer): Promise<HttpResponse> {
    if (this.failure) throw this.failure;
    const lines = [`POST ${path} HTTP/1.1`, `Host: ${this.host}`, 'Connection: Keep-Alive'];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    lines.push(`Content-Length: ${body.length}`, '', '');
    this.socket.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), body]));
    return this.readResponse();
  }

  private wake(error?: Error): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.(error);
  }

  private async more(): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      this.waiting = (error) => (error ? reject(error) : resolve());
    });
  }

  private async readResponse(): Promise<HttpResponse> {
    let headerEnd: number;
    while ((headerEnd = this.buffer.indexOf('\r\n\r\n')) < 0) await this.more();
    const head = this.buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
    this.buffer = this.buffer.subarray(headerEnd + 4);
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1]);
    if (!Number.isInteger(status)) throw new Error('The WinRM server sent an invalid HTTP response.');
    const headers = new Map<string, string>();
    for (const line of head.slice(1)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }

    let body: Buffer;
    if (/chunked/i.test(headers.get('transfer-encoding') ?? '')) {
      const parts: Buffer[] = [];
      for (;;) {
        let lineEnd: number;
        while ((lineEnd = this.buffer.indexOf('\r\n')) < 0) await this.more();
        const size = Number.parseInt(this.buffer.subarray(0, lineEnd).toString('latin1'), 16);
        if (!Number.isFinite(size)) throw new Error('The WinRM server sent an invalid chunk.');
        while (this.buffer.length < lineEnd + 2 + size + 2) await this.more();
        parts.push(Buffer.from(this.buffer.subarray(lineEnd + 2, lineEnd + 2 + size)));
        this.buffer = this.buffer.subarray(lineEnd + 2 + size + 2);
        if (size === 0) break;
      }
      body = Buffer.concat(parts);
    } else {
      const length = Number(headers.get('content-length') ?? 0);
      while (this.buffer.length < length) await this.more();
      body = Buffer.from(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
    }
    if (/close/i.test(headers.get('connection') ?? '')) {
      this.failure ??= new Error('The WinRM server closed the connection.');
    }
    return { status, headers, body };
  }
}
