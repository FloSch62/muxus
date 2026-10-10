import http2 from 'node:http2';
import type { Duplex } from 'node:stream';
import type {
  GnmiEncoding,
  GnmiModel,
  GnmiNotification,
  GnmiSetResult,
} from '@muxus/shared';
import { formatGnmiPath, joinGnmiPaths, parseGnmiPath } from '@muxus/shared';
import type { ManagementClientMessage } from '@muxus/shared/ws-protocol';
import { GrpcChannel, GrpcCode, GrpcError, type GrpcCall, type GrpcCallOptions } from './grpc.js';
import { decodeMessage, encodeMessage, type ProtoMessage } from './protobuf.js';
import {
  CapabilityRequest,
  CapabilityResponse,
  DATA_TYPE,
  ENCODING,
  GetRequest,
  GetResponse,
  LIST_MODE,
  SetRequest,
  SetResponse,
  SUBSCRIPTION_MODE,
  SubscribeRequest,
  SubscribeResponse,
  UPDATE_RESULT_OP,
} from './schema.js';
import {
  encodingsFromProto,
  protoString,
  modelsFromProto,
  notificationToJson,
  pathFromProto,
  pathTextToProto,
  setValueToProto,
} from './values.js';

type GetMessage = Extract<ManagementClientMessage, { op: 'gnmi-get' }>;
type SetMessage = Extract<ManagementClientMessage, { op: 'gnmi-set' }>;
type SubscribeMessage = Extract<ManagementClientMessage, { op: 'gnmi-subscribe' }>;

const SERVICE = '/gnmi.gNMI';
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 20_000;
const UNARY_TIMEOUT_MS = 120_000;
/** Big Get responses arrive faster with a generous flow-control window. */
const WINDOW_BYTES = 32 * 1024 * 1024;

export interface GnmiCapabilities {
  version: string;
  encodings: GnmiEncoding[];
  models: GnmiModel[];
}

export interface GnmiSubscriptionHandlers {
  notification(notification: GnmiNotification, bytes: number): void;
  sync(): void;
  end(error: GrpcError | undefined): void;
}

export interface GnmiSubscription {
  poll(): void;
  cancel(): void;
}

/** Wrap a Muxus-owned stream (TCP, TLS, an SSH channel) in an HTTP/2 session. */
function connectSession(socket: Duplex, authority: string, secure: boolean): Promise<http2.ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`${secure ? 'https' : 'http'}://${authority}`, {
      createConnection: () => socket,
      settings: { initialWindowSize: WINDOW_BYTES, enablePush: false },
    });
    const onError = (err: Error) => {
      session.destroy();
      reject(err);
    };
    session.once('error', onError);
    session.once('connect', () => {
      session.off('error', onError);
      try {
        session.setLocalWindowSize(WINDOW_BYTES);
      } catch {
        /* older runtimes: the default window still works, only slower */
      }
      resolve(session);
    });
  });
}

/** One gNMI target, one HTTP/2 connection, any number of calls on it. */
export class GnmiClient {
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly calls = new Set<GrpcCall>();
  private closed = false;
  private pingTimer: NodeJS.Timeout | undefined;
  /** Round trip of the last keepalive ping, for the session header. */
  latencyMs: number | undefined;

  private constructor(
    private readonly session: http2.ClientHttp2Session,
    private readonly channel: GrpcChannel,
  ) {
    session.on('error', (err) => this.shutdown(err.message));
    session.on('goaway', () => this.shutdown('The device closed the connection.'));
    session.on('close', () => this.shutdown('The connection closed.'));
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  static async connect(options: {
    socket: Duplex;
    /** host:port the device is addressed as (HTTP/2 :authority). */
    authority: string;
    secure: boolean;
  }): Promise<GnmiClient> {
    const session = await connectSession(options.socket, options.authority, options.secure);
    return new GnmiClient(session, new GrpcChannel(session, options.authority));
  }

  /** gNMI has no login step: the credentials ride along as metadata on every call. */
  setCredentials(username: string | undefined, password: string | undefined): void {
    this.channel.metadata = {
      ...(username ? { username } : {}),
      ...(password !== undefined && username ? { password } : {}),
    };
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const call of this.calls) call.cancel(new GrpcError(GrpcCode.UNAVAILABLE, reason));
    this.calls.clear();
    if (!this.session.destroyed) this.session.destroy();
    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.clear();
  }

  close(): void {
    this.shutdown('The session was closed.');
  }

  /** Measure the round trip; a ping that goes unanswered ends the session. */
  ping(): Promise<number | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.shutdown('The device stopped answering keepalives.');
        resolve(undefined);
      }, PING_TIMEOUT_MS);
      try {
        this.session.ping((err, duration) => {
          clearTimeout(timer);
          if (err) {
            resolve(undefined);
            return;
          }
          this.latencyMs = Math.round(duration);
          resolve(this.latencyMs);
        });
      } catch {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  private async unary(
    method: string,
    request: Buffer,
    options: { signal?: AbortSignal; maxBytes?: number } = {},
  ): Promise<{ message: Buffer; bytes: number }> {
    if (this.closed) throw new GrpcError(GrpcCode.UNAVAILABLE, 'The session is closed.');
    return this.channel.unary(`${SERVICE}/${method}`, request, { timeoutMs: UNARY_TIMEOUT_MS, ...options });
  }

  async capabilities(signal?: AbortSignal): Promise<GnmiCapabilities & { bytes: number }> {
    const { message, bytes } = await this.unary('Capabilities', encodeMessage(CapabilityRequest, {}), { signal });
    const response = decodeMessage(CapabilityResponse, message);
    return {
      version: protoString(response.gNMI_version),
      encodings: encodingsFromProto(response.supported_encodings),
      models: modelsFromProto(response.supported_models),
      bytes,
    };
  }

  async get(
    request: GetMessage,
    encoding: GnmiEncoding,
    signal?: AbortSignal,
  ): Promise<{ notifications: GnmiNotification[]; bytes: number }> {
    const body: ProtoMessage = {
      ...(request.prefix?.trim() ? { prefix: pathTextToProto(request.prefix) } : {}),
      path: request.paths.map((path) => pathTextToProto(path)),
      type: DATA_TYPE[request.type],
      encoding: ENCODING[encoding],
      ...(request.depth ? { extension: [{ depth: { level: request.depth } }] } : {}),
    };
    const { message, bytes } = await this.unary('Get', encodeMessage(GetRequest, body), {
      signal,
      maxBytes: request.maxBytes,
    });
    const response = decodeMessage(GetResponse, message);
    rejectEmbeddedError(response);
    return {
      notifications: ((response.notification as ProtoMessage[] | undefined) ?? []).map(notificationToJson),
      bytes,
    };
  }

  async set(
    request: SetMessage,
    signal?: AbortSignal,
  ): Promise<{ timestamp: string; results: GnmiSetResult[]; bytes: number }> {
    const update = (item: SetMessage['updates'][number]) => ({
      path: pathTextToProto(item.path),
      val: setValueToProto(item.value, item.encoding),
    });
    const commit = request.commit;
    const body: ProtoMessage = {
      ...(request.prefix?.trim() ? { prefix: pathTextToProto(request.prefix) } : {}),
      delete: request.deletes.map((path) => pathTextToProto(path)),
      replace: request.replaces.map(update),
      update: request.updates.map(update),
      ...(commit
        ? {
            extension: [
              {
                commit: {
                  id: commit.id,
                  ...(commit.action === 'commit'
                    ? {
                        commit: commit.rollbackSeconds
                          ? { rollback_duration: { seconds: BigInt(commit.rollbackSeconds) } }
                          : {},
                      }
                    : commit.action === 'confirm'
                      ? { confirm: {} }
                      : { cancel: {} }),
                },
              },
            ],
          }
        : {}),
    };
    const { message, bytes } = await this.unary('Set', encodeMessage(SetRequest, body), { signal });
    const response = decodeMessage(SetResponse, message);
    rejectEmbeddedError(response);
    const prefix = response.prefix ? pathFromProto(response.prefix as ProtoMessage) : undefined;
    return {
      timestamp: String((response.timestamp as bigint | undefined) ?? 0n),
      results: ((response.response as ProtoMessage[] | undefined) ?? []).map((result) => ({
        path: formatGnmiPath(joinGnmiPaths(prefix, pathFromProto(result.path as ProtoMessage | undefined))),
        op: UPDATE_RESULT_OP[Number(result.op ?? 0)] ?? 'invalid',
      })),
      bytes,
    };
  }

  /** One request, one reply, for a gNOI/gNSI method on this connection. */
  unaryCall(path: string, request: Buffer, signal?: AbortSignal): Promise<{ message: Buffer; bytes: number }> {
    if (this.closed) return Promise.reject(new GrpcError(GrpcCode.UNAVAILABLE, 'The session is closed.'));
    return this.channel.unary(path, request, { timeoutMs: UNARY_TIMEOUT_MS, signal });
  }

  /**
   * A raw call on this connection, for the gNOI and gNSI services that share
   * the gNMI server. It ends with the session like every other call.
   */
  openCall(path: string, options: GrpcCallOptions = {}): GrpcCall {
    const call = this.channel.call(path, options);
    if (this.closed) {
      queueMicrotask(() => call.cancel(new GrpcError(GrpcCode.UNAVAILABLE, 'The session is closed.')));
      return call;
    }
    this.calls.add(call);
    call.once('end', () => this.calls.delete(call));
    return call;
  }

  subscribe(request: SubscribeMessage, encoding: GnmiEncoding, handlers: GnmiSubscriptionHandlers): GnmiSubscription {
    if (this.closed) {
      queueMicrotask(() => handlers.end(new GrpcError(GrpcCode.UNAVAILABLE, 'The session is closed.')));
      return { poll: () => undefined, cancel: () => undefined };
    }
    // Validate every path before anything goes on the wire.
    const prefix = request.prefix?.trim() ? pathTextToProto(request.prefix) : undefined;
    const subscriptions = request.subscriptions.map((subscription) => ({
      path: pathTextToProto(subscription.path),
      mode: SUBSCRIPTION_MODE[subscription.mode],
      ...(subscription.sampleIntervalMs ? { sample_interval: BigInt(subscription.sampleIntervalMs) * 1_000_000n } : {}),
      ...(subscription.suppressRedundant ? { suppress_redundant: true } : {}),
      ...(subscription.heartbeatIntervalMs
        ? { heartbeat_interval: BigInt(subscription.heartbeatIntervalMs) * 1_000_000n }
        : {}),
    }));
    const call = this.channel.call(`${SERVICE}/Subscribe`);
    this.calls.add(call);
    let previousBytes = 0;
    call.on('message', (message: Buffer) => {
      const received = call.bytes - previousBytes;
      previousBytes = call.bytes;
      let response: ProtoMessage;
      try {
        response = decodeMessage(SubscribeResponse, message);
      } catch (err) {
        call.cancel(new GrpcError(GrpcCode.INTERNAL, `Could not decode a subscription update: ${(err as Error).message}`));
        return;
      }
      if (response.error) {
        const error = response.error as ProtoMessage;
        call.cancel(new GrpcError(Number(error.code ?? GrpcCode.UNKNOWN), protoString(error.message)));
        return;
      }
      if (response.sync_response) handlers.sync();
      if (response.update) handlers.notification(notificationToJson(response.update as ProtoMessage), received);
    });
    call.once('end', (error: GrpcError | undefined) => {
      this.calls.delete(call);
      handlers.end(error);
    });
    call.write(
      encodeMessage(SubscribeRequest, {
        subscribe: {
          ...(prefix ? { prefix } : {}),
          subscription: subscriptions,
          mode: LIST_MODE[request.mode],
          encoding: ENCODING[encoding],
          ...(request.updatesOnly ? { updates_only: true } : {}),
        },
      }),
    );
    return {
      poll: () => {
        if (request.mode === 'poll') call.write(encodeMessage(SubscribeRequest, { poll: {} }));
      },
      cancel: () => call.cancel(),
    };
  }
}

/** Pre-0.7 targets put failures in the response body instead of the status. */
function rejectEmbeddedError(response: ProtoMessage): void {
  const error = (response.error ?? response.message) as ProtoMessage | undefined;
  if (error && (error.code || error.message)) {
    throw new GrpcError(Number(error.code ?? GrpcCode.UNKNOWN), protoString(error.message));
  }
}

/** Reject malformed path text up front with a readable message. */
export function validateGnmiPaths(paths: readonly (string | undefined)[]): void {
  for (const path of paths) if (path?.trim()) parseGnmiPath(path);
}
