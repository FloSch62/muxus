import {
  isEmptyPayload,
  uploadSummary,
  uploadToRemote,
  type DropPayload,
  type UploadDeps,
} from './sftp-upload.js';
import { useSftpUploadsStore, type TerminalUpload } from './state/sftp-uploads.js';
import { errorDetails, showToast, type ToastSeverity } from './state/toast.js';

export interface TerminalUploadRequest {
  connId: string;
  host?: string;
  /** Reads the drop and settles where it goes; the upload shows as preparing meanwhile. */
  prepare: (signal: AbortSignal) => Promise<{ directory: string; payload: DropPayload }>;
  /** Re-read file browser listings of the connection. */
  refresh: (connId: string) => void;
  deps?: UploadDeps;
  notify?: (severity: ToastSeverity, message: string, details?: string) => void;
  /** Delay before a finished upload's progress disappears. */
  settleMs?: number;
}

let nextUploadId = 1;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Upload files dropped onto an SSH terminal over the session's own connection.
 * Progress shows in the file browser when one is on screen for the connection,
 * otherwise in a corner of the window. One upload per connection at a time.
 */
export async function startTerminalUpload(request: TerminalUploadRequest): Promise<void> {
  const { connId, host, refresh } = request;
  const notify = request.notify ?? showToast;
  // A finished upload only lingers on screen; the next one replaces it.
  const running = useSftpUploadsStore.getState().uploads[connId];
  if (running && running.phase !== 'complete') {
    notify('warning', 'Wait for the current upload to finish.');
    return;
  }
  const id = nextUploadId++;
  const controller = new AbortController();
  let progress: TerminalUpload = {
    id,
    connId,
    ...(host ? { host } : {}),
    direction: 'upload',
    name: 'files',
    loaded: 0,
    bytesPerSecond: 0,
    phase: 'preparing',
    cancel: () => {
      show({ phase: 'cancelling', bytesPerSecond: 0 });
      controller.abort();
    },
  };
  const show = (patch: Partial<TerminalUpload>) => {
    progress = { ...progress, ...patch };
    useSftpUploadsStore.getState().show(progress);
  };
  const hide = () => useSftpUploadsStore.getState().clear(connId, id);

  try {
    show({});
    const { directory, payload } = await request.prepare(controller.signal);
    controller.signal.throwIfAborted();
    if (isEmptyPayload(payload)) {
      hide();
      notify('info', 'Nothing was uploaded: the drop held no files or folders.');
      return;
    }
    const result = await uploadToRemote(connId, directory, payload, {
      signal: controller.signal,
      onProgress: (update) => {
        // A cancel stays on screen until the request has actually stopped.
        if (progress.phase !== 'cancelling') show(update);
      },
      ...(request.deps ? { deps: request.deps } : {}),
    });
    refresh(connId);
    notify('success', uploadSummary(result, directory));
    setTimeout(hide, request.settleMs ?? 1_200);
  } catch (error) {
    hide();
    if (isAbortError(error)) {
      notify('info', 'Upload cancelled');
      refresh(connId);
    } else {
      notify('error', error instanceof Error ? error.message : String(error), errorDetails(error));
    }
  }
}
