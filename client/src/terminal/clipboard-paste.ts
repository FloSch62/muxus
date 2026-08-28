import { apiFetch } from '../api/http.js';

export type TerminalClipboardPayload =
  | { kind: 'text'; text: string }
  | { kind: 'image'; png: Uint8Array<ArrayBuffer> }
  | { kind: 'empty' }
  | { kind: 'unavailable' };

export type TerminalClipboardPasteResult =
  | { status: 'pasted'; kind: 'image-path' | 'text' }
  | { status: 'skipped'; reason: 'empty' | 'unavailable' };


interface PasteTerminalClipboardOptions {
  uploadImage: (png: Uint8Array<ArrayBuffer>) => Promise<string>;
  pasteText: (text: string) => void | Promise<void>;
  pasteImagePath: (path: string) => void | Promise<void>;
}

interface TerminalImagePasteTarget {
  connectionId?: string;
  expectedConnectionId?: string;
  inputReady: boolean;
  socketOpen: boolean;
  ssh: boolean;
}

export function isCurrentTerminalImagePasteTarget({
  connectionId,
  expectedConnectionId,
  inputReady,
  socketOpen,
  ssh,
}: TerminalImagePasteTarget): boolean {
  return (
    ssh &&
    inputReady &&
    socketOpen &&
    expectedConnectionId !== undefined &&
    connectionId === expectedConnectionId
  );
}

interface TerminalClipboardPasteQueueLimits {
  maxPendingImageBytes: number;
  maxPendingPastes: number;
}

const DEFAULT_QUEUE_LIMITS: TerminalClipboardPasteQueueLimits = {
  maxPendingImageBytes: 36 * 1024 * 1024,
  maxPendingPastes: 8,
};

type CapturedClipboardPayload =
  | { ok: true; payload: TerminalClipboardPayload }
  | { ok: false; error: unknown };

export class TerminalClipboardPasteQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private pendingImageBytes = 0;
  private pendingPastes = 0;

  constructor(
    private readonly limits: TerminalClipboardPasteQueueLimits = DEFAULT_QUEUE_LIMITS,
  ) {}

  cancelAll(): void {
    for (const controller of this.controllers) controller.abort();
  }

  enqueue<TResult>(
    capture: (signal: AbortSignal) => Promise<TerminalClipboardPayload>,
    apply: (payload: TerminalClipboardPayload, signal: AbortSignal) => Promise<TResult>,
  ): Promise<TResult> {
    if (this.pendingPastes >= this.limits.maxPendingPastes) {
      return Promise.reject(new Error('Too many clipboard pastes are waiting.'));
    }
    this.pendingPastes++;

    const controller = new AbortController();
    this.controllers.add(controller);
    let payloadPromise: Promise<TerminalClipboardPayload>;
    try {
      payloadPromise = capture(controller.signal);
    } catch (error) {
      payloadPromise = Promise.reject(error);
    }

    let reservedImageBytes = 0;
    const captured = payloadPromise.then<CapturedClipboardPayload, CapturedClipboardPayload>(
      (payload) => {
        if (payload.kind === 'image') {
          if (
            this.pendingImageBytes + payload.png.byteLength >
            this.limits.maxPendingImageBytes
          ) {
            return { ok: false, error: new Error('Too much clipboard image data is waiting.') };
          }
          reservedImageBytes = payload.png.byteLength;
          this.pendingImageBytes += reservedImageBytes;
        }
        return { ok: true, payload };
      },
      (error: unknown) => ({ ok: false, error }),
    );

    const operation = this.tail.then(async () => {
      controller.signal.throwIfAborted();
      const clipboard = await captured;
      controller.signal.throwIfAborted();
      if (!clipboard.ok) throw clipboard.error;
      const result = await apply(clipboard.payload, controller.signal);
      controller.signal.throwIfAborted();
      return result;
    });
    const settled = operation.finally(() => {
      this.controllers.delete(controller);
      this.pendingPastes--;
      this.pendingImageBytes -= reservedImageBytes;
    });
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }
}


export async function uploadTerminalClipboardImage(
  connId: string,
  png: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await apiFetch<{ path: string }>(
    `/api/sftp/${encodeURIComponent(connId)}/clipboard-image`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
      signal,
    },
  );
  return response.path;
}

/** Paste captured text or upload a captured image and paste its remote path. */
export async function pasteTerminalClipboard(
  payload: TerminalClipboardPayload,
  { uploadImage, pasteText, pasteImagePath }: PasteTerminalClipboardOptions,
): Promise<TerminalClipboardPasteResult> {
  if (payload.kind === 'text') {
    await pasteText(payload.text);
    return { status: 'pasted', kind: 'text' };
  }
  if (payload.kind === 'empty' || payload.kind === 'unavailable') {
    return { status: 'skipped', reason: payload.kind };
  }

  const remotePath = await uploadImage(payload.png);
  await pasteImagePath(remotePath);
  return { status: 'pasted', kind: 'image-path' };
}
