import type { ApiErrorBody } from '@muxus/shared';
import { reportAuthInvalid, reportBackendDown, reportBackendUp } from '../state/backend.js';
import { ApiError, apiFetchRaw, authToken } from './http.js';

export interface ByteProgress {
  loaded: number;
  total?: number;
  bytesPerSecond: number;
}

/**
 * Smooth and throttle noisy browser progress events. Ten UI updates per
 * second look continuous without rerendering the SFTP table for every chunk.
 */
function progressReporter(onProgress: (progress: ByteProgress) => void) {
  const startedAt = performance.now();
  let sampledAt = startedAt;
  let sampledBytes = 0;
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

/** XMLHttpRequest remains the browser API that exposes upload byte progress. */
export function uploadRawWithProgress(
  path: string,
  file: File,
  options: {
    onProgress: (progress: ByteProgress) => void;
    onUploadComplete?: () => void;
    signal?: AbortSignal;
  },
): Promise<void> {
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
        resolve();
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
): Promise<Blob> {
  const response = await apiFetchRaw(path, { signal });
  const headerValue = response.headers.get('content-length');
  const header = headerValue === null ? undefined : Number(headerValue);
  const total = header !== undefined && Number.isFinite(header) && header >= 0 ? header : undefined;
  const report = progressReporter(onProgress);
  report(0, total, true);
  if (!response.body) {
    const blob = await response.blob();
    report(blob.size, total ?? blob.size, true);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const copy = value.slice();
    chunks.push(copy.buffer as ArrayBuffer);
    loaded += copy.byteLength;
    report(loaded, total);
  }
  report(loaded, total ?? loaded, true);
  return new Blob(chunks, {
    type: response.headers.get('content-type') ?? 'application/octet-stream',
  });
}
