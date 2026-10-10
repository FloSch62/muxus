import { createHash } from 'node:crypto';
import type { GnmiClient } from '../gnmi/client.js';
import { GrpcCode, GrpcError } from '../gnmi/grpc.js';
import { decodeMessage, encodeMessage, type ProtoMessage } from '../gnmi/protobuf.js';
import { FileGetRequest, FileGetResponse, FilePutRequest, HASH_METHOD } from './gnoi.js';
import { ReflectionRequest, ReflectionResponse } from './gnsi.js';

/**
 * The gNOI and reflection exchanges the renderer does not drive message by
 * message: file transfers (chunked, with the hash gNOI requires checked or
 * supplied here) and listing the services a device offers.
 */

const CHUNK_BYTES = 64 * 1024;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
/** Larger files go through the device's own tooling, not a tab. */
export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

const HASH_NAMES: Record<number, string> = {
  [HASH_METHOD.SHA256]: 'sha256',
  [HASH_METHOD.SHA512]: 'sha512',
  [HASH_METHOD.MD5]: 'md5',
};

function waitForEnd(call: ReturnType<GnmiClient['openCall']>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => call.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    call.once('end', (error: GrpcError | undefined) => {
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    });
  });
}

export interface DownloadResult {
  size: number;
  /** The device sent a hash and the content matched it. */
  verified: boolean;
  hashMethod?: string;
}

/** Stream a file from the device, handing each chunk on as it arrives and checking the hash at the end. */
export async function downloadFile(
  client: GnmiClient,
  remoteFile: string,
  onData: (chunk: Buffer) => void,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const call = client.openCall('/gnoi.file.File/Get', { timeoutMs: TRANSFER_TIMEOUT_MS, maxBytes: MAX_TRANSFER_BYTES });
  // The device names its hash only at the end, so every candidate is computed along the way.
  const digests = Object.fromEntries(Object.values(HASH_NAMES).map((name) => [name, createHash(name)]));
  let size = 0;
  let hash: ProtoMessage | undefined;
  call.on('message', (message: Buffer) => {
    const response = decodeMessage(FileGetResponse, message);
    if (response.contents) {
      const chunk = response.contents as Buffer;
      size += chunk.length;
      for (const digest of Object.values(digests)) digest.update(chunk);
      onData(chunk);
    }
    if (response.hash) hash = response.hash as ProtoMessage;
  });
  const ended = waitForEnd(call, signal);
  call.write(encodeMessage(FileGetRequest, { remote_file: remoteFile }));
  call.end();
  await ended;
  const algorithm = hash ? HASH_NAMES[Number(hash.method ?? 0)] : undefined;
  if (!hash || !algorithm) return { size, verified: false };
  if (!digests[algorithm]!.digest().equals(hash.hash as Buffer)) {
    throw new GrpcError(GrpcCode.DATA_LOSS, `The ${algorithm.toUpperCase()} of the received file does not match the device's.`);
  }
  return { size, verified: true, hashMethod: algorithm };
}

/** An upload in progress: chunks go out as they come, the SHA-256 follows the last one. */
export class FileUpload {
  private readonly call: ReturnType<GnmiClient['openCall']>;
  private readonly digest = createHash('sha256');
  private readonly ended: Promise<void>;
  bytes = 0;

  constructor(client: GnmiClient, remoteFile: string, permissions: number | undefined, signal?: AbortSignal) {
    this.call = client.openCall('/gnoi.file.File/Put', { timeoutMs: TRANSFER_TIMEOUT_MS });
    this.ended = waitForEnd(this.call, signal);
    // Surface failures through finish(); until then nobody awaits this.
    this.ended.catch(() => undefined);
    this.call.write(
      encodeMessage(FilePutRequest, {
        open: { remote_file: remoteFile, ...(permissions !== undefined ? { permissions } : {}) },
      }),
    );
  }

  async write(chunk: Buffer): Promise<void> {
    for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
      const piece = chunk.subarray(offset, offset + CHUNK_BYTES);
      this.digest.update(piece);
      this.bytes += piece.length;
      await this.call.writeDrained(encodeMessage(FilePutRequest, { contents: piece }));
    }
  }

  async finish(): Promise<number> {
    this.call.write(encodeMessage(FilePutRequest, { hash: { method: HASH_METHOD.SHA256, hash: this.digest.digest() } }));
    this.call.end();
    await this.ended;
    return this.bytes;
  }

  cancel(): void {
    this.call.cancel();
  }
}

/**
 * Service names from gRPC server reflection (v1alpha, then v1), or
 * undefined when the device does not offer reflection.
 */
export async function listServices(client: GnmiClient): Promise<string[] | undefined> {
  for (const path of [
    '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
    '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
  ]) {
    const call = client.openCall(path, { timeoutMs: 10_000 });
    let services: string[] | undefined;
    call.on('message', (message: Buffer) => {
      const response = decodeMessage(ReflectionResponse, message);
      const list = response.list_services_response as { service?: Array<{ name?: string }> } | undefined;
      if (list) services = (list.service ?? []).map((service) => service.name ?? '').filter(Boolean);
      call.end();
    });
    const ended = waitForEnd(call).catch((error: unknown) => error);
    call.write(encodeMessage(ReflectionRequest, { list_services: '*' }));
    const error = await ended;
    if (services) return services.sort();
    if (error instanceof GrpcError && error.code !== GrpcCode.UNIMPLEMENTED) return undefined;
  }
  return undefined;
}
