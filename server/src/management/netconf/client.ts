import type { Duplex } from 'node:stream';
import {
  encodeChunked,
  encodeEndOfMessage,
  NetconfDecoder,
  NetconfFramingError,
} from './framing.js';
import {
  clientHello,
  NETCONF_BASE_1_1,
  notificationEventTime,
  parseHello,
  rootElement,
  wrapRpc,
} from './xml.js';

const HELLO_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_TIMEOUT_MS = 120_000;

export class NetconfError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = 'NetconfError';
  }
}

export interface NetconfReply {
  xml: string;
  messageId: string;
  bytes: number;
}

export interface NetconfNotification {
  xml: string;
  eventTime?: string;
}

interface PendingRpc {
  messageId: string;
  resolve(reply: NetconfReply): void;
  reject(error: NetconfError): void;
}

/**
 * One NETCONF session on a `netconf` SSH subsystem channel: the hello
 * exchange, framing negotiation, message-id bookkeeping and notifications.
 * RPC replies are returned as text, <rpc-error> included; only transport
 * failures reject.
 */
export class NetconfClient {
  readonly capabilities: string[];
  readonly sessionId: string;
  readonly base: '1.0' | '1.1';
  private nextMessageId = 1;
  private readonly pending: PendingRpc[] = [];
  private readonly notificationListeners = new Set<(notification: NetconfNotification) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closed = false;

  private constructor(
    private readonly channel: Duplex,
    private readonly decoder: NetconfDecoder,
    hello: { capabilities: string[]; sessionId?: string },
    leftover: string[],
  ) {
    this.capabilities = hello.capabilities;
    this.sessionId = hello.sessionId ?? '';
    this.base = hello.capabilities.includes(NETCONF_BASE_1_1) ? '1.1' : '1.0';
    if (this.base === '1.1') decoder.useChunked();
    channel.on('data', (chunk: Buffer) => this.receive(chunk));
    channel.on('close', () => this.shutdown('The NETCONF session closed.'));
    channel.on('error', (err: Error) => this.shutdown(err.message));
    for (const message of leftover) this.dispatch(message);
  }

  /** Exchange hellos on a freshly opened subsystem channel. */
  static open(channel: Duplex): Promise<NetconfClient> {
    return new Promise((resolve, reject) => {
      const decoder = new NetconfDecoder();
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        channel.off('data', onData);
        channel.off('close', onClose);
        channel.off('error', onError);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Errors from tearing the channel down are not news to anyone.
        channel.on('error', () => undefined);
        channel.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new NetconfError('The server sent no NETCONF <hello> within 30 seconds.')),
        HELLO_TIMEOUT_MS,
      );
      const onData = (chunk: Buffer) => {
        let messages: string[];
        try {
          messages = decoder.push(chunk);
        } catch (err) {
          fail(new NetconfError(`Malformed NETCONF framing: ${(err as Error).message}`));
          return;
        }
        if (messages.length === 0 || settled) return;
        let hello: ReturnType<typeof parseHello>;
        try {
          hello = parseHello(messages[0]!);
        } catch (err) {
          fail(err as Error);
          return;
        }
        settled = true;
        cleanup();
        // Bytes after the hello belong to the negotiated framing.
        resolve(new NetconfClient(channel, decoder, hello, messages.slice(1)));
      };
      const onClose = () => fail(new NetconfError('The server closed the NETCONF subsystem before its <hello>.'));
      const onError = (err: Error) => fail(err);
      channel.on('data', onData);
      channel.once('close', onClose);
      channel.once('error', onError);
      channel.write(encodeEndOfMessage(clientHello()));
    });
  }

  onNotification(listener: (notification: NetconfNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private receive(chunk: Buffer): void {
    let messages: string[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      const message = err instanceof NetconfFramingError ? err.message : String(err);
      this.shutdown(`Malformed NETCONF framing: ${message}`);
      this.channel.destroy();
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(xml: string): void {
    const root = rootElement(xml);
    if (root?.name === 'notification') {
      const eventTime = notificationEventTime(xml);
      for (const listener of this.notificationListeners) listener({ xml, ...(eventTime ? { eventTime } : {}) });
      return;
    }
    if (root?.name !== 'rpc-reply') return;
    const id = root.attributes['message-id'];
    // Replies come back in order; one without an id answers the oldest RPC.
    const index = id === undefined ? 0 : this.pending.findIndex((pending) => pending.messageId === id);
    if (index < 0) return;
    const [pending] = this.pending.splice(index, 1);
    if (!pending) return;
    pending.resolve({ xml, messageId: pending.messageId, bytes: Buffer.byteLength(xml, 'utf8') });
  }

  private frame(message: string): Buffer {
    return this.base === '1.1' ? encodeChunked(message) : encodeEndOfMessage(message);
  }

  rpc(body: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<NetconfReply> {
    if (this.closed) return Promise.reject(new NetconfError('The NETCONF session is closed.'));
    const messageId = String(this.nextMessageId++);
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
      let settled = false;
      const settle = () => {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      // The entry stays queued after a timeout or cancel: NETCONF cannot
      // abandon an RPC, so its late reply still has to find a slot.
      const entry: PendingRpc = {
        messageId,
        resolve: (reply) => {
          if (settled) return;
          settle();
          resolve(reply);
        },
        reject: (error) => {
          if (settled) return;
          settle();
          reject(error);
        },
      };
      const timer = setTimeout(
        () => entry.reject(new NetconfError(`No reply within ${Math.round(timeoutMs / 1000)} seconds.`)),
        timeoutMs,
      );
      const onAbort = () => entry.reject(new NetconfError('Cancelled.', true));
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.push(entry);
      this.channel.write(this.frame(wrapRpc(messageId, body)));
    });
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.splice(0)) pending.reject(new NetconfError(reason));
    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.clear();
    this.notificationListeners.clear();
  }

  /** Say goodbye with <close-session/> when the session is healthy, then drop the channel. */
  async close(): Promise<void> {
    if (!this.closed) {
      try {
        await this.rpc('<close-session/>', { timeoutMs: 2000 });
      } catch {
        /* the channel goes away regardless */
      }
    }
    this.shutdown('The NETCONF session was closed.');
    this.channel.end();
    setTimeout(() => this.channel.destroy(), 1000).unref?.();
  }
}
