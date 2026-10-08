import type { LocalCopyChange, SftpUploadResponse } from '@muxus/shared';
import { ApiError } from './api/http.js';
import { uploadRawWithProgress } from './api/transfers.js';
import { confirmAction } from './state/dialogs.js';
import { useLocalCopiesStore, type LocalCopyUpload, type TrackedLocalCopy } from './state/local-copies.js';
import { errorDetails, showToast, type ToastSeverity } from './state/toast.js';

// When a program saves a file Muxus opened for it, ask whether to upload the
// save (or upload straight away once the user said so for that file), then
// upload it with progress, refusing to silently replace a remote file that
// changed in the meantime.

export interface LocalCopySyncDeps {
  readLocalCopy: (id: string, offset: number) => Promise<Uint8Array | undefined>;
  confirm: typeof confirmAction;
  upload: typeof uploadRawWithProgress;
  /** Re-read the listing of the connection the file lives on. */
  refresh: (connId: string) => void;
  notify: (severity: ToastSeverity, message: string, details?: string) => void;
  /** Delay before a finished upload's progress disappears. */
  settleMs?: number;
}

// Saves reported while the same copy is still waiting for its turn, or
// waiting for the user's answer, fold into the one already queued.
const queued = new Set<string>();
let queue: Promise<void> = Promise.resolve();
let nextAttempt = 1;

/** Handle a program saving new contents into a tracked copy. Resolves once it is dealt with. */
export function localCopyChanged(change: LocalCopyChange, deps: LocalCopySyncDeps): Promise<void> {
  if (!useLocalCopiesStore.getState().copies[change.id]) return queue;
  if (queued.has(change.id)) return queue;
  queued.add(change.id);
  queue = queue.then(() => syncLocalCopy(change, deps)).catch(() => undefined);
  return queue;
}

async function syncLocalCopy({ id, file }: LocalCopyChange, deps: LocalCopySyncDeps): Promise<void> {
  let released = false;
  // From here on, a new save is newer than what gets uploaded and asks again.
  const release = () => {
    released = true;
    queued.delete(id);
  };
  try {
    const store = useLocalCopiesStore.getState();
    const copy = store.copies[id];
    if (!copy) return;
    if (!copy.autoUpload) {
      let always = false;
      const upload = await deps.confirm({
        title: `Upload changes to ${copy.name}?`,
        description: `${copy.name} was saved in another program. Uploading replaces ${copy.remotePath}${
          copy.host ? ` on ${copy.host}` : ''
        }.`,
        confirmLabel: 'Upload',
        cancelLabel: "Don't upload",
        checkbox: {
          label: 'Upload later changes to this file without asking',
          onChecked: () => {
            always = true;
          },
        },
      });
      if (!upload) return;
      if (always) store.update(id, { autoUpload: true });
    }
    release();
    await uploadLocalCopy(useLocalCopiesStore.getState().copies[id] ?? copy, file, deps);
  } finally {
    if (!released) queued.delete(id);
  }
}

async function readCopy(id: string, deps: LocalCopySyncDeps, signal: AbortSignal): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    const chunk = await deps.readLocalCopy(id, offset);
    if (!chunk) throw new Error('The local copy can no longer be read.');
    if (chunk.byteLength === 0) return new Blob(parts);
    parts.push(chunk as Uint8Array<ArrayBuffer>);
    offset += chunk.byteLength;
  }
}

function isRemoteChanged(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.body?.code === 'SFTP_FILE_CHANGED';
}

function isConnectionGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.body?.message === 'connection not found';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function uploadLocalCopy(copy: TrackedLocalCopy, file: string, deps: LocalCopySyncDeps): Promise<void> {
  const { setUpload, update } = useLocalCopiesStore.getState();
  const attempt = nextAttempt++;
  const controller = new AbortController();
  const where = copy.host ? ` to ${copy.host}` : '';
  let progress: LocalCopyUpload = {
    attempt,
    copyId: copy.id,
    direction: 'upload',
    name: copy.name,
    ...(copy.host ? { host: copy.host } : {}),
    loaded: 0,
    bytesPerSecond: 0,
    phase: 'preparing',
    cancel: () => {
      show({ phase: 'cancelling', bytesPerSecond: 0 });
      controller.abort();
    },
  };
  let visible = true;
  const show = (patch: Partial<LocalCopyUpload>) => {
    progress = { ...progress, ...patch };
    if (visible) setUpload(progress);
  };
  // Clears only this attempt's progress, never a later upload's.
  const hide = () => {
    visible = false;
    if (useLocalCopiesStore.getState().upload?.attempt === attempt) setUpload(undefined);
  };

  try {
    setUpload(progress);
    const contents = await readCopy(copy.id, deps, controller.signal);
    show({ total: contents.size });
    const send = (expectedMtimeMs: number | undefined) =>
      deps.upload(
        `/api/sftp/${copy.connId}/upload?path=${encodeURIComponent(copy.remotePath)}&overwrite=true${
          expectedMtimeMs === undefined ? '' : `&expectedMtimeMs=${expectedMtimeMs}`
        }`,
        contents,
        {
          signal: controller.signal,
          onProgress: (bytes) => show({ ...bytes, phase: 'transferring' }),
          onUploadComplete: () => show({ loaded: contents.size, phase: 'finalizing' }),
        },
      );

    let result: unknown;
    try {
      result = await send(copy.remoteMtimeMs);
    } catch (error) {
      if (!isRemoteChanged(error)) throw error;
      hide();
      const replace = await deps.confirm({
        title: `${copy.name} also changed on the server`,
        description: `${copy.remotePath}${copy.host ? ` on ${copy.host}` : ''} was changed or removed after you opened it. Uploading replaces that version with yours.`,
        confirmLabel: 'Replace',
        cancelLabel: 'Keep the server version',
        destructive: true,
      });
      if (!replace) {
        deps.notify('info', `${copy.name} was not uploaded. Your copy is at ${file}`);
        return;
      }
      visible = true;
      show({ loaded: 0, bytesPerSecond: 0, phase: 'preparing' });
      result = await send(undefined);
    }

    update(copy.id, { remoteMtimeMs: (result as SftpUploadResponse | undefined)?.mtimeMs });
    deps.refresh(copy.connId);
    show({ loaded: contents.size, total: contents.size, bytesPerSecond: 0, phase: 'complete' });
    deps.notify('success', `Uploaded ${copy.name}${where}`);
    setTimeout(hide, deps.settleMs ?? 1_200);
  } catch (error) {
    hide();
    if (isAbortError(error)) {
      deps.notify('info', `Cancelled the upload of ${copy.name}. Your copy is at ${file}`);
    } else if (isConnectionGone(error)) {
      deps.notify(
        'error',
        `Could not upload ${copy.name}: the connection${copy.host ? ` to ${copy.host}` : ''} is closed. Reconnect and upload your copy from ${file}`,
      );
    } else {
      const message = error instanceof Error ? error.message : String(error);
      deps.notify('error', `Could not upload ${copy.name}: ${message}`, errorDetails(error));
    }
  }
}

export function defaultLocalCopySyncDeps(refresh: (connId: string) => void): LocalCopySyncDeps | undefined {
  const desktop = window.muxusDesktop;
  if (!desktop?.readLocalCopy) return undefined;
  return {
    readLocalCopy: (id, offset) => desktop.readLocalCopy!(id, offset),
    confirm: confirmAction,
    upload: uploadRawWithProgress,
    refresh,
    notify: showToast,
  };
}
