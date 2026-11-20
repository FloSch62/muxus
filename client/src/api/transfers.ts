import type { ApiErrorBody } from '@muxus/shared';
import { reportAuthInvalid, reportBackendDown, reportBackendUp } from '../state/backend.js';
import { ApiError, apiFetchRaw, authToken } from './http.js';

export interface ByteProgress {
  loaded: number;
  total?: number;
  bytesPerSecond: number;
}

/** What a download that stopped early received, and the version of the file it came from. */
export interface PartialDownload {
  blob: Blob;
  etag: string;
}

export interface DownloadResume {
  /** Bytes an earlier attempt received: only the rest is asked for, unless the file changed. */
  partial?: PartialDownload;
  /** Receives everything this attempt has when it stops early. */
  onInterrupted: (partial: PartialDownload) => void;
}

/**
 * Smooth and throttle noisy browser progress events. Ten UI updates per
 * second look continuous without rerendering the SFTP table for every chunk.
 */
function progressReporter(onProgress: (progress: ByteProgress) => void, startBytes = 0) {
  const startedAt = performance.now();
  let sampledAt = startedAt;
  let sampledBytes = startBytes;
  let emittedAt = 0;
  let smoothedSpeed = 0;

  return (loaded: number, total?: number, force = false) => {
    const now = performance.now();
    const sampleDuration = now - sampledAt;
    if (sampleDuration >= 250 || force) {
      const instantSpeed =
        sampleDuration > 0 ? ((loaded - sampledBytes) * 1000) / sampleDuration : smoothedSpeed;
      smoothedSpeed =
        smoothedSpeed > 0 ? smoothedSpeed * 0.72 + Math.max(0, instantSpeed) * 0.28 : Math.max(0, instantSpeed);
      sampledAt = now;
      sampledBytes = loaded;
    }
    if (force || now - emittedAt >= 100 || loaded === 0) {
      emittedAt = now;
      onProgress({ loaded, total, bytesPerSecond: smoothedSpeed });
    }
  };
}

function xhrError(xhr: XMLHttpRequest): ApiError {
  let body: ApiErrorBody | undefined;
  try {
    body = xhr.responseText ? (JSON.parse(xhr.responseText) as ApiErrorBody) : undefined;
  } catch {
    /* non-JSON error response */
  }
  return new ApiError(
    xhr.status,
    body?.message || `${xhr.status || 'Network error'} ${xhr.statusText}`.trim(),
    body,
  );
}

/**
 * XMLHttpRequest remains the browser API that exposes upload byte progress.
 * Resolves with the parsed JSON response, if there is one.
 */
export function uploadRawWithProgress(
  path: string,
  file: Blob,
  options: {
    onProgress: (progress: ByteProgress) => void;
    onUploadComplete?: () => void;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const report = progressReporter(options.onProgress);
    report(0, file.size, true);
    xhr.open('POST', path);
    xhr.setRequestHeader('authorization', `Bearer ${authToken()}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => report(event.loaded, file.size, event.loaded >= file.size);
    xhr.upload.onload = () => options.onUploadComplete?.();
    xhr.onerror = () => {
      reportBackendDown();
      reject(new ApiError(0, 'Cannot reach the Muxus backend'));
    };
    xhr.onabort = () => reject(new DOMException('Transfer cancelled', 'AbortError'));
    xhr.onload = () => {
      reportBackendUp();
      if (xhr.status === 401) reportAuthInvalid();
      if (xhr.status >= 200 && xhr.status < 300) {
        report(file.size, file.size, true);
        let body: unknown;
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
        } catch {
          body = undefined;
        }
        resolve(body);
      } else {
        reject(xhrError(xhr));
      }
    };
    const abort = () => xhr.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => options.signal?.removeEventListener('abort', abort);
    xhr.send(file);
  });
}

/** Stream an authenticated download while retaining byte-level progress. */
export async function downloadBlobWithProgress(
  path: string,
  onProgress: (progress: ByteProgress) => void,
  signal?: AbortSignal,
  onHeaders?: (headers: Headers) => void,
  resume?: DownloadResume,
): Promise<Blob> {
  const partial = resume?.partial;
  const response = await apiFetchRaw(path, {
    signal,
    ...(partial ? { headers: { range: `bytes=${partial.blob.size}-`, 'if-range': partial.etag } } : {}),
  });
  onHeaders?.(response.headers);
  // The server sends the rest with 206, or the whole file once it changed.
  const prefix = response.status === 206 ? partial?.blob : undefined;
  const offset = prefix?.size ?? 0;
  const etag = response.headers.get('etag');
  const headerValue = response.headers.get('content-length');
  const header = headerValue === null ? undefined : Number(headerValue);
  const total = header !== undefined && Number.isFinite(header) && header >= 0 ? offset + header : undefined;
  const report = progressReporter(onProgress, offset);
  report(offset, total, true);
  if (!response.body) {
    const blob = await response.blob();
    report(offset + blob.size, total ?? offset + blob.size, true);
    return prefix ? new Blob([prefix, blob], { type: blob.type }) : blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = prefix ? [prefix] : [];
  let loaded = offset;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const copy = value.slice();
      chunks.push(copy.buffer as ArrayBuffer);
      loaded += copy.byteLength;
      report(loaded, total);
    }
  } catch (error) {
    if (etag && loaded > 0) resume?.onInterrupted({ blob: new Blob(chunks), etag });
    throw error;
  }
  report(loaded, total ?? loaded, true);
  return new Blob(chunks, {
    type: response.headers.get('content-type') ?? 'application/octet-stream',
  });
}
