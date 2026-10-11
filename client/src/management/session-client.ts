import type {
  AuthPromptInfo,
  GrpcJson,
  DesktopCertificateChallenge,
  GnmiNotification,
  ManagementClientMessage,
  ManagementError,
  ManagementProfile,
  ManagementResult,
  ManagementServerMessage,
  ManagementSessionInfo,
} from '@muxus/shared';
import { wsProtocols, wsUrl } from '../api/http.js';
import type { HostKeyRequest } from '../components/HostKeyDialog.js';

type RequestMessage = Extract<
  ManagementClientMessage,
  { op: 'gnmi-capabilities' | 'gnmi-get' | 'gnmi-set' | 'netconf-rpc' | 'grpc-call' | 'gnoi-file-get' | 'tls-probe' }
>;
type SubscribeMessage = Extract<ManagementClientMessage, { op: 'gnmi-subscribe' }>;
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface RequestOutcome<R extends ManagementResult = ManagementResult> {
  result: R;
  durationMs: number;
  bytes: number;
}

export class ManagementRequestError extends Error {
  constructor(
    readonly error: ManagementError,
    readonly durationMs: number,
  ) {
    super(error.message);
    this.name = 'ManagementRequestError';
  }
}

export interface PendingRequest<R extends ManagementResult = ManagementResult> {
  id: string;
  promise: Promise<RequestOutcome<R>>;
  cancel: () => void;
}

export interface SubscriptionHandlers {
  notifications: (notifications: GnmiNotification[], bytes: number) => void;
  sync: () => void;
  end: (error?: ManagementError) => void;
}

export interface GrpcStreamHandlers {
  messages: (messages: GrpcJson[]) => void;
  end: (error?: ManagementError) => void;
}

/** An open gNOI/gNSI stream: more messages can follow on bidirectional calls. */
export interface GrpcStream {
  id: string;
  send: (message: GrpcJson) => void;
  closeSend: () => void;
  cancel: () => void;
}

export interface Transfer<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export interface DownloadedFile {
  blob: Blob;
  size: number;
  verified: boolean;
  hashMethod?: string;
}

/** Upload chunk size; each one waits for the device before the next. */
const UPLOAD_CHUNK_BYTES = 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface LiveSubscription {
  id: string;
  poll: () => void;
  cancel: () => void;
}

export interface ManagementConnectionEvents {
  status: (message: string, transient: boolean) => void;
  authPrompt: (info: AuthPromptInfo) => void;
  hostKey: (request: HostKeyRequest) => void;
  certificate: (challenge: DesktopCertificateChallenge) => void;
  ready: (info: ManagementSessionInfo, profile: ManagementProfile) => void;
  netconfNotification?: (xml: string, eventTime: string | undefined, receivedAt: string) => void;
  /** The socket closed; `exit` is what the backend said, if anything. */
  closed: (exit: { message?: string; reason: 'completed' | 'failed' | 'disconnected' } | undefined, socketFailed: boolean) => void;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `r${Date.now().toString(36)}${requestCounter.toString(36)}`;
}

/**
 * The renderer end of /ws/management: login round-trips go to `events`,
 * requests resolve to their result, subscriptions stream to their handlers.
 */
export class ManagementConnection {
  private readonly socket: WebSocket;
  private readonly requests = new Map<
    string,
    { resolve(outcome: RequestOutcome): void; reject(error: ManagementRequestError): void }
  >();
  private readonly subscriptions = new Map<string, SubscriptionHandlers>();
  private readonly streams = new Map<string, GrpcStreamHandlers>();
  private readonly downloads = new Map<string, (data: string) => void>();
  private readonly uploads = new Map<string, (bytes: number) => void>();
  private readonly uploadFailures = new Map<string, (error: ManagementRequestError) => void>();
  private exit: { message?: string; reason: 'completed' | 'failed' | 'disconnected' } | undefined;
  private socketFailed = false;
  closed = false;

  constructor(
    profile: ManagementProfile,
    private readonly events: ManagementConnectionEvents,
  ) {
    this.socket = new WebSocket(wsUrl('/ws/management'), wsProtocols());
    this.socket.onopen = () => this.send({ op: 'connect', profile });
    this.socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: ManagementServerMessage;
      try {
        message = JSON.parse(event.data) as ManagementServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    };
    this.socket.onerror = () => {
      this.socketFailed = true;
    };
    this.socket.onclose = () => this.finish();
  }

  private receive(message: ManagementServerMessage): void {
    switch (message.op) {
      case 'status':
        this.events.status(message.message, message.transient === true);
        return;
      case 'auth-prompt': {
        const { op: _op, ...info } = message;
        this.events.authPrompt(info);
        return;
      }
      case 'host-key':
        this.events.hostKey(message);
        return;
      case 'certificate': {
        const { op: _op, ...challenge } = message;
        this.events.certificate(challenge);
        return;
      }
      case 'ready':
        this.events.ready(message.info, message.profile);
        return;
      case 'result': {
        const pending = this.requests.get(message.id);
        this.requests.delete(message.id);
        pending?.resolve({ result: message.result, durationMs: message.durationMs, bytes: message.bytes });
        return;
      }
      case 'error': {
        const pending = this.requests.get(message.id);
        this.requests.delete(message.id);
        if (pending) {
          pending.reject(new ManagementRequestError(message.error, message.durationMs));
          return;
        }
        // A subscription or stream that failed before it started reports as an error.
        const subscription = this.subscriptions.get(message.id);
        this.subscriptions.delete(message.id);
        subscription?.end(message.error);
        const stream = this.streams.get(message.id);
        this.streams.delete(message.id);
        stream?.end(message.error);
        const upload = this.uploads.get(message.id);
        this.uploads.delete(message.id);
        if (upload) this.uploadFailures.get(message.id)?.(new ManagementRequestError(message.error, message.durationMs));
        return;
      }
      case 'gnmi-notifications':
        this.subscriptions.get(message.id)?.notifications(message.notifications, message.bytes);
        return;
      case 'grpc-messages':
        this.streams.get(message.id)?.messages(message.messages);
        return;
      case 'gnoi-file-data':
        this.downloads.get(message.id)?.(message.data);
        return;
      case 'gnoi-file-ack':
        this.uploads.get(message.id)?.(message.bytes);
        return;
      case 'gnmi-sync':
        this.subscriptions.get(message.id)?.sync();
        return;
      case 'stream-end': {
        const subscription = this.subscriptions.get(message.id);
        this.subscriptions.delete(message.id);
        subscription?.end(message.error);
        const stream = this.streams.get(message.id);
        this.streams.delete(message.id);
        stream?.end(message.error);
        return;
      }
      case 'netconf-notification':
        this.events.netconfNotification?.(message.xml, message.eventTime, message.receivedAt);
        return;
      case 'exit':
        this.exit = { message: message.message, reason: message.reason };
        return;
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const lost = new ManagementRequestError({ message: this.exit?.message ?? 'The session closed.' }, 0);
    for (const pending of this.requests.values()) pending.reject(lost);
    this.requests.clear();
    for (const subscription of this.subscriptions.values()) subscription.end({ message: lost.message });
    this.subscriptions.clear();
    for (const stream of this.streams.values()) stream.end({ message: lost.message });
    this.streams.clear();
    for (const fail of this.uploadFailures.values()) fail(lost);
    this.uploadFailures.clear();
    this.uploads.clear();
    this.downloads.clear();
    this.events.closed(this.exit, this.socketFailed);
  }

  send(message: ManagementClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  request<R extends ManagementResult = ManagementResult>(message: WithoutId<RequestMessage>): PendingRequest<R> {
    const id = nextRequestId();
    const promise = new Promise<RequestOutcome<R>>((resolve, reject) => {
      if (this.closed) {
        reject(new ManagementRequestError({ message: 'The session is closed.' }, 0));
        return;
      }
      this.requests.set(id, { resolve: resolve as (outcome: RequestOutcome) => void, reject });
      this.send({ ...message, id } as ManagementClientMessage);
    });
    return { id, promise, cancel: () => this.send({ op: 'cancel', id }) };
  }

  subscribe(message: Omit<SubscribeMessage, 'id'>, handlers: SubscriptionHandlers): LiveSubscription {
    const id = nextRequestId();
    if (this.closed) {
      queueMicrotask(() => handlers.end({ message: 'The session is closed.' }));
    } else {
      this.subscriptions.set(id, handlers);
      this.send({ ...message, id });
    }
    return {
      id,
      poll: () => this.send({ op: 'gnmi-poll', id }),
      cancel: () => this.send({ op: 'cancel', id }),
    };
  }

  /** A unary gNOI/gNSI call; resolves to the response JSON. */
  async grpcCall<T = GrpcJson>(method: string, request: GrpcJson = {}): Promise<T> {
    const outcome = await this.request({ op: 'grpc-call', method, request }).promise;
    return (outcome.result.op === 'grpc-call' ? outcome.result.response : {}) as T;
  }

  /** A streaming gNOI/gNSI call. */
  grpcStream(method: string, request: GrpcJson | undefined, handlers: GrpcStreamHandlers): GrpcStream {
    const id = nextRequestId();
    if (this.closed) {
      queueMicrotask(() => handlers.end({ message: 'The session is closed.' }));
    } else {
      this.streams.set(id, handlers);
      this.send({ op: 'grpc-stream', id, method, ...(request ? { request } : {}) });
    }
    return {
      id,
      send: (message) => this.send({ op: 'grpc-send', id, message }),
      closeSend: () => this.send({ op: 'grpc-close-send', id }),
      cancel: () => this.send({ op: 'cancel', id }),
    };
  }

  /** Download a file from the device over gNOI, its hash checked by the backend. */
  downloadFile(remoteFile: string, onProgress?: (bytes: number) => void): Transfer<DownloadedFile> {
    const chunks: Array<Uint8Array<ArrayBuffer>> = [];
    let received = 0;
    const pending = this.request({ op: 'gnoi-file-get', remoteFile });
    this.downloads.set(pending.id, (data) => {
      const chunk = fromBase64(data);
      chunks.push(chunk);
      received += chunk.length;
      onProgress?.(received);
    });
    const promise = pending.promise
      .then((outcome) => {
        const result = outcome.result.op === 'gnoi-file-get' ? outcome.result : { size: received, verified: false };
        return { blob: new Blob(chunks), ...result };
      })
      .finally(() => this.downloads.delete(pending.id));
    return { promise, cancel: pending.cancel };
  }

  /** Upload a file to the device over gNOI, a chunk at a time as the device takes them. */
  uploadFile(
    remoteFile: string,
    file: Blob,
    permissions: number | undefined,
    onProgress?: (bytes: number) => void,
  ): Transfer<number> {
    const id = nextRequestId();
    const promise = new Promise<number>((resolve, reject) => {
      if (this.closed) {
        reject(new ManagementRequestError({ message: 'The session is closed.' }, 0));
        return;
      }
      let offset = 0;
      this.requests.set(id, {
        resolve: (outcome) => {
          this.uploads.delete(id);
          this.uploadFailures.delete(id);
          resolve(outcome.result.op === 'gnoi-file-put' ? outcome.result.size : file.size);
        },
        reject: (error) => {
          this.uploads.delete(id);
          this.uploadFailures.delete(id);
          reject(error);
        },
      });
      this.uploadFailures.set(id, reject);
      this.uploads.set(id, (bytes) => {
        onProgress?.(bytes);
        const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
        const slice = file.slice(offset, end);
        offset = end;
        void slice.arrayBuffer().then((buffer) => {
          this.send({ op: 'gnoi-file-chunk', id, data: toBase64(new Uint8Array(buffer)), last: end >= file.size });
        });
      });
      this.send({
        op: 'gnoi-file-put',
        id,
        remoteFile,
        size: file.size,
        ...(permissions !== undefined ? { permissions } : {}),
      });
    });
    return { promise, cancel: () => this.send({ op: 'cancel', id }) };
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}
