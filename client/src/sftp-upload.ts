import { ApiError, apiFetch } from './api/http.js';
import { uploadRawWithProgress, type ByteProgress } from './api/transfers.js';
import { confirmAction } from './state/dialogs.js';
import type { TransferProgressState } from './transfer-progress.js';

// Files and folders dropped or picked for upload, and the upload itself. The
// file browser and a drop onto an SSH terminal both go through here, so both
// create folders, report progress and ask before replacing a file alike.

export interface DroppedFile {
  file: File;
  /** Path below the upload directory, with `/` separators. */
  relativePath: string;
}

export interface DropPayload {
  files: DroppedFile[];
  /** Folders to create, even when empty. */
  directories: string[];
}

export type UploadProgress = TransferProgressState & {
  direction: 'upload';
  fileIndex: number;
  fileCount: number;
};

export interface UploadResult {
  uploaded: number;
  directories: number;
}

export interface UploadDeps {
  mkdir: (connId: string, path: string, signal: AbortSignal) => Promise<unknown>;
  upload: typeof uploadRawWithProgress;
  confirm: typeof confirmAction;
}

interface WebkitFileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(success: (file: File) => void, error?: (error: DOMException) => void): void;
  createReader(): {
    readEntries(success: (entries: WebkitFileEntry[]) => void, error?: (error: DOMException) => void): void;
  };
}

export function joinRemotePath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function cleanRelativePath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

async function readDirectory(reader: ReturnType<WebkitFileEntry['createReader']>): Promise<WebkitFileEntry[]> {
  const result: WebkitFileEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitFileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return result;
    result.push(...batch);
  }
}

/**
 * Read the files and folders of a drop. Call it from the drop handler itself:
 * the items are only readable until the event returns, and the entries are
 * taken before the first await.
 */
export async function collectDrop(items: DataTransferItem[]): Promise<DropPayload> {
  const payload: DropPayload = { files: [], directories: [] };
  const entries: WebkitFileEntry[] = [];
  for (const item of items) {
    const getter = (item as unknown as { webkitGetAsEntry?: () => WebkitFileEntry | null }).webkitGetAsEntry;
    const entry = getter?.call(item);
    if (entry) entries.push(entry);
  }

  const visit = async (entry: WebkitFileEntry, parent: string): Promise<void> => {
    const relativePath = cleanRelativePath(parent ? `${parent}/${entry.name}` : entry.name);
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
      payload.files.push({ file, relativePath });
      return;
    }
    if (!entry.isDirectory) return;
    payload.directories.push(relativePath);
    const children = await readDirectory(entry.createReader());
    await Promise.all(children.map((child) => visit(child, relativePath)));
  };

  if (entries.length > 0) {
    await Promise.all(entries.map((entry) => visit(entry, '')));
    return payload;
  }
  for (const item of items) {
    const file = item.getAsFile();
    if (file) payload.files.push({ file, relativePath: file.name });
  }
  return payload;
}

export function isEmptyPayload(payload: DropPayload): boolean {
  return payload.files.length === 0 && payload.directories.length === 0;
}

export const defaultUploadDeps: UploadDeps = {
  mkdir: (connId, path, signal) =>
    apiFetch(`/api/sftp/${connId}/mkdir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, recursive: true }),
      signal,
    }),
  upload: uploadRawWithProgress,
  confirm: confirmAction,
};

function isDestinationExists(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.body?.code === 'SFTP_DESTINATION_EXISTS'
  );
}

/**
 * Upload a drop into `directory` on the connection: folders first, shallowest
 * first, then each file. A file that already exists is replaced only once the
 * user confirms; a declined one is skipped. Progress ends in a `complete` state.
 */
export async function uploadToRemote(
  connId: string,
  directory: string,
  payload: DropPayload,
  options: {
    signal: AbortSignal;
    onProgress: (progress: UploadProgress) => void;
    deps?: UploadDeps;
  },
): Promise<UploadResult> {
  const { signal, onProgress } = options;
  const deps = options.deps ?? defaultUploadDeps;
  const fileCount = payload.files.length;
  const parentDirectories = payload.files
    .map(({ relativePath }) => cleanRelativePath(relativePath).split('/').slice(0, -1).join('/'))
    .filter(Boolean);
  const directories = [...new Set([...payload.directories, ...parentDirectories])]
    .filter(Boolean)
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const totalBytes = payload.files.reduce((sum, item) => sum + item.file.size, 0);
  let completedBytes = 0;
  let uploaded = 0;
  let fileIndex = 0;
  let last: UploadProgress = {
    direction: 'upload',
    name: directories[0] ?? payload.files[0]?.relativePath ?? 'Preparing upload',
    loaded: 0,
    total: totalBytes || undefined,
    bytesPerSecond: 0,
    phase: 'preparing',
    fileIndex: 0,
    fileCount,
  };
  const report = (patch: Partial<UploadProgress>) => {
    last = { ...last, ...patch };
    onProgress(last);
  };
  report({});

  for (const relative of directories) {
    signal.throwIfAborted();
    report({ name: relative, loaded: completedBytes, bytesPerSecond: 0, phase: 'preparing' });
    await deps.mkdir(connId, joinRemotePath(directory, relative), signal);
  }
  for (const item of payload.files) {
    // A cancel while the replace question was open must stop the next request too.
    signal.throwIfAborted();
    fileIndex++;
    const relative = cleanRelativePath(item.relativePath || item.file.name);
    const destination = joinRemotePath(directory, relative);
    const send = (overwrite: boolean) =>
      deps.upload(
        `/api/sftp/${connId}/upload?path=${encodeURIComponent(destination)}${overwrite ? '&overwrite=true' : ''}`,
        item.file,
        {
          signal,
          onProgress: (progress: ByteProgress) =>
            report({
              name: relative,
              loaded: completedBytes + progress.loaded,
              total: totalBytes,
              bytesPerSecond: progress.bytesPerSecond,
              phase: 'transferring',
              fileIndex,
            }),
          onUploadComplete: () =>
            report({ loaded: completedBytes + item.file.size, phase: 'finalizing' }),
        },
      );
    try {
      await send(false);
      uploaded++;
    } catch (uploadError) {
      if (!isDestinationExists(uploadError)) throw uploadError;
      const replace = await deps.confirm({
        title: 'Replace the existing file?',
        description: `${relative} already exists on the remote host.`,
        confirmLabel: 'Replace',
        destructive: true,
      });
      if (replace) {
        signal.throwIfAborted();
        await send(true);
        uploaded++;
      }
    }
    completedBytes += item.file.size;
  }

  report({
    name: payload.files.at(-1)?.relativePath ?? directories.at(-1) ?? 'Upload',
    loaded: totalBytes,
    total: totalBytes || undefined,
    bytesPerSecond: 0,
    phase: 'complete',
    fileIndex: fileCount,
  });
  return { uploaded, directories: directories.length };
}

/** The toast after an upload, e.g. "Uploaded 3 files" or "Uploaded 1 file to /srv/app". */
export function uploadSummary({ uploaded, directories }: UploadResult, directory?: string): string {
  if (uploaded > 0) {
    return `Uploaded ${uploaded === 1 ? '1 file' : `${uploaded} files`}${directory ? ` to ${directory}` : ''}`;
  }
  if (directories > 0) {
    return `Created ${directories === 1 ? '1 folder' : `${directories} folders`}${directory ? ` in ${directory}` : ''}`;
  }
  return 'Nothing was uploaded';
}
