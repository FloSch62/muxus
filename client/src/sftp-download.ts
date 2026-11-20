import type { SftpEntry, SftpListResponse } from '@muxus/shared';
import { ApiError, apiFetch } from './api/http.js';
import { downloadBlobWithProgress, type DownloadResume, type PartialDownload } from './api/transfers.js';
import { formatSize } from './components/TransferProgress.js';
import { joinRemotePath } from './sftp-upload.js';
import { confirmAction } from './state/dialogs.js';
import { TRANSFER_CANCELLED, type TransferProgressState } from './transfer-progress.js';

/**
 * Saving several downloaded files at once, and folders with everything in
 * them. A download link asks where to save each file in the desktop app, so
 * where the page may write to a folder (the desktop app and Chromium
 * browsers), the folder is picked once and every file is written into it.
 * Elsewhere the files go to the browser's downloads, and folders cannot be
 * downloaded.
 */

type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'downloads' | 'desktop' | 'documents';
}) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | undefined {
  return (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

/** Whether downloads can go into a folder the user picks, which folders need. */
export function canPickDownloadFolder(): boolean {
  return directoryPicker() !== undefined;
}

/**
 * Ask for the folder to save into. Undefined where the page cannot write to a
 * folder, null when the picker was dismissed. Call it from the click itself:
 * the picker needs the user's gesture.
 */
export async function pickDownloadFolder(): Promise<FileSystemDirectoryHandle | null | undefined> {
  const pick = directoryPicker();
  if (!pick) return undefined;
  try {
    return await pick({ id: 'muxus-sftp-download', mode: 'readwrite', startIn: 'downloads' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

// Characters Windows refuses in a file name, path separators included.
const UNSAFE_NAME_CHARACTERS = new Set('\\/:*?"<>|');

/** A remote name that every local file system accepts; browsers clean download names the same way. */
export function localFileName(name: string): string {
  let cleaned = '';
  for (const character of name) {
    const unsafe = UNSAFE_NAME_CHARACTERS.has(character) || character.charCodeAt(0) < 32;
    cleaned += unsafe ? '_' : character;
  }
  // Windows cannot keep trailing dots and spaces on a name.
  cleaned = cleaned.replace(/[. ]+$/, '');
  return cleaned || 'download';
}

/** "report.txt", then "report (1).txt", "report (2).txt" …; a dotfile keeps its leading dot. */
export function numberedFileName(name: string, copy: number): string {
  if (copy === 0) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${name.slice(0, dot)} (${copy})${name.slice(dot)}`
    : `${name} (${copy})`;
}

/**
 * Write `blob` into `folder` without replacing anything there: a taken name
 * gets a number, as browsers number repeated downloads. Resolves to the name
 * written.
 */
export async function saveIntoFolder(
  folder: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<string> {
  const base = localFileName(name);
  for (let copy = 0; ; copy++) {
    const candidate = numberedFileName(base, copy);
    if (await folderHas(folder, candidate)) continue;
    const file = await folder.getFileHandle(candidate, { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return candidate;
  }
}

/** Create a folder in `parent` without merging into anything there: a taken name gets a number. */
async function createFolderIn(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  const base = localFileName(name);
  for (let copy = 0; ; copy++) {
    // A folder name has no extension to keep after the number.
    const candidate = copy === 0 ? base : `${base} (${copy})`;
    if (!(await folderHas(parent, candidate))) return parent.getDirectoryHandle(candidate, { create: true });
  }
}

async function folderHas(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    // A folder of that name is taken too.
    if (error.name === 'TypeMismatchError') return true;
    if (error.name === 'NotFoundError') return false;
    throw error;
  }
}

// What downloads that stopped early received, by remote path, so that
// downloading the file again continues them. They are held in memory, so only
// the newest are kept, up to this many bytes in all.
const MAX_INTERRUPTED_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const interruptedDownloads = new Map<string, PartialDownload>();


/**
 * Continue an interrupted download of the remote `file`, and keep what this one
 * receives if it stops early other than by Cancel. Once the download is over,
 * `release` keeps a later Cancel of `signal`, as in a folder download, from
 * dropping what another download keeps of `file`.
 */
export function downloadResume(file: string, signal: AbortSignal): DownloadResume & { release: () => void } {
  // Cancel also drops what an earlier attempt received, even before an answer arrives.
  const dropOnCancel = () => {
    if (signal.reason === TRANSFER_CANCELLED) interruptedDownloads.delete(file);
  };
  signal.addEventListener('abort', dropOnCancel, { once: true });
  return {
    partial: interruptedDownloads.get(file),
    onInterrupted: (partial) => {
      if (signal.reason !== TRANSFER_CANCELLED) keepInterruptedDownload(file, partial);
    },
    release: () => signal.removeEventListener('abort', dropOnCancel),
  };
}

function keepInterruptedDownload(file: string, partial: PartialDownload): void {
  interruptedDownloads.delete(file);
  if (partial.blob.size > MAX_INTERRUPTED_DOWNLOAD_BYTES) return;
  interruptedDownloads.set(file, partial);
  let kept = 0;
  for (const { blob } of interruptedDownloads.values()) kept += blob.size;
  for (const [oldest, { blob }] of interruptedDownloads) {
    if (kept <= MAX_INTERRUPTED_DOWNLOAD_BYTES) break;
    interruptedDownloads.delete(oldest);
    kept -= blob.size;
  }
}

/** A download of the remote `file` finished; nothing of it is left to continue. */
export function forgetInterruptedDownload(file: string): void {
  interruptedDownloads.delete(file);
}

// A download with folders is listed in full before anything is saved, and
// refused past these.
export const MAX_FOLDER_DOWNLOAD_ENTRIES = 10_000;
export const MAX_FOLDER_DOWNLOAD_BYTES = 10 * 1024 ** 3;

export type DownloadProgress = TransferProgressState & {
  direction: 'download';
  fileIndex: number;
  fileCount: number;
};

export interface DownloadResult {
  /** Files saved, out of `fileCount`. */
  downloaded: number;
  fileCount: number;
  /** Folders created, the selected ones included. */
  folders: number;
  /** What was left out, by path below the destination, each with the reason. */
  skipped: string[];
  /** Cancel stopped the download; what was saved until then stays. */
  cancelled: boolean;
}

export interface DownloadDeps {
  list: (connId: string, path: string, signal: AbortSignal) => Promise<SftpListResponse>;
  download: typeof downloadBlobWithProgress;
  confirm: typeof confirmAction;
  /** Hands a file to the browser's downloads, where no folder was picked. */
  save: (name: string, blob: Blob) => void;
}

/** Hand `blob` to the browser's downloads; the desktop app asks where to save it. */
export function saveDownload(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const defaultDownloadDeps: DownloadDeps = {
  list: (connId, path, signal) =>
    apiFetch<SftpListResponse>(`/api/sftp/${connId}/list?path=${encodeURIComponent(path)}`, { signal }),
  download: downloadBlobWithProgress,
  confirm: confirmAction,
  save: saveDownload,
};

interface RemoteItem {
  path: string;
  /** Path below the destination, with `/` separators. */
  relativePath: string;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function parentOf(relativePath: string): string {
  return relativePath.slice(0, Math.max(0, relativePath.lastIndexOf('/')));
}

function nameOf(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

/** A single path element; any other name in a listing could reach outside the folder, here or on the server. */
function isEntryName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

// The File System API rejects a name it does not take with a TypeError, and
// Chromium does not take aux.c, con.txt, desktop.ini or x.lnk in a local folder,
// on every system. They are skipped, not renamed.
const REFUSED_NAME = 'name not allowed locally';

function isRefusedName(error: unknown): boolean {
  return error instanceof TypeError;
}

/** `error`, its message led by what failed and where; an abort stays as is, so the caller can tell why it stopped. */
function couldNot(action: string, relativePath: string, error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return error;
  const message = `Could not ${action} ${relativePath}: ${error instanceof Error ? error.message : String(error)}`;
  return error instanceof ApiError ? new ApiError(error.status, message, error.body) : new Error(message, { cause: error });
}

/**
 * Download files, and folders with everything below them, into `destination`;
 * without one, files go to the browser's downloads and folders are left out.
 * Folders are listed in full first, refused past the limits and confirmed with
 * their totals. Links, special files and names that are not a single entry or
 * that the local folder refuses are skipped. A file an earlier download left
 * unfinished continues where it stopped. Resolves undefined when the user
 * declines, and with what was saved after Cancel; stopped otherwise, it rejects,
 * a failure naming the item it stopped at.
 */
export async function downloadFromRemote(
  connId: string,
  targets: ReadonlyArray<{ entry: SftpEntry; path: string }>,
  destination: FileSystemDirectoryHandle | undefined,
  options: {
    signal: AbortSignal;
    onProgress: (progress: DownloadProgress) => void;
    deps?: DownloadDeps;
  },
): Promise<DownloadResult | undefined> {
  const { signal, onProgress } = options;
  const deps = options.deps ?? defaultDownloadDeps;
  const files: Array<RemoteItem & { size: number }> = [];
  // Folders found while listing are appended, so parents come before their children.
  const folders: RemoteItem[] = [];
  const directories: string[] = [];
  const result: DownloadResult = { downloaded: 0, fileCount: 0, folders: 0, skipped: [], cancelled: false };
  let totalBytes = 0;
  const addFile = (item: RemoteItem, size = 0) => {
    files.push({ ...item, size });
    totalBytes += size;
  };
  let last: DownloadProgress = {
    direction: 'download',
    name: targets[0]?.entry.name ?? 'Download',
    loaded: 0,
    bytesPerSecond: 0,
    phase: 'preparing',
    fileIndex: 0,
    fileCount: 0,
  };
  const report = (patch: Partial<DownloadProgress>) => {
    last = { ...last, ...patch };
    onProgress(last);
  };

  try {
    for (const { entry, path } of targets) {
      if (!isEntryName(entry.name)) result.skipped.push(`${entry.name} (invalid name)`);
      else if (entry.type === 'file') addFile({ path, relativePath: entry.name }, entry.size);
      else if (entry.type === 'dir' && destination) folders.push({ path, relativePath: entry.name });
    }
    report({});
    let entries = targets.length;
    const listed = new Set<string>();
    for (let index = 0; index < folders.length; index++) {
      const folder = folders[index]!;
      report({ name: folder.relativePath });
      const listing = await deps.list(connId, folder.path, signal).catch((error: unknown) => {
        throw couldNot('list', folder.relativePath, error, signal);
      });
      // A server that lists a link as the folder it points to must not lead back into the download.
      if (listed.has(listing.path)) {
        result.skipped.push(`${folder.relativePath} (link)`);
        continue;
      }
      listed.add(listing.path);
      directories.push(folder.relativePath);
      for (const entry of listing.entries) {
        const child = {
          path: joinRemotePath(listing.path, entry.name),
          relativePath: `${folder.relativePath}/${entry.name}`,
        };
        if (!isEntryName(entry.name)) result.skipped.push(`${child.relativePath} (invalid name)`);
        else if (entry.type === 'dir') folders.push(child);
        else if (entry.type === 'file') addFile(child, entry.size);
        else result.skipped.push(`${child.relativePath} (${entry.type === 'link' ? 'link' : 'special file'})`);
      }
      entries += listing.entries.length;
      if (entries > MAX_FOLDER_DOWNLOAD_ENTRIES) {
        throw new Error(
          `More than ${MAX_FOLDER_DOWNLOAD_ENTRIES.toLocaleString()} files and folders to download. Download fewer or smaller folders.`,
        );
      }
      if (totalBytes > MAX_FOLDER_DOWNLOAD_BYTES) {
        throw new Error(
          `More than ${formatSize(MAX_FOLDER_DOWNLOAD_BYTES)} to download. Download fewer or smaller folders.`,
        );
      }
    }

    if (destination && folders.length > 0) {
      const created = directories.length;
      const skipped = result.skipped.length;
      const confirmed = await deps.confirm({
        title: `Download ${plural(files.length, 'file')} (${formatSize(totalBytes)})?`,
        description:
          `${plural(created, 'folder')} ${created === 1 ? 'is' : 'are'} created in ${destination.name}.` +
          (skipped > 0 ? ` ${plural(skipped, 'item')} ${skipped === 1 ? 'is' : 'are'} skipped.` : ''),
        confirmLabel: 'Download',
      });
      if (!confirmed) return undefined;
      // An abort while the question was open must stop before anything is saved.
      signal.throwIfAborted();
    }

    const local = new Map<string, FileSystemDirectoryHandle>(destination ? [['', destination]] : []);
    for (const relativePath of directories) {
      signal.throwIfAborted();
      const parent = local.get(parentOf(relativePath));
      // Inside a folder whose name was refused.
      if (!parent) continue;
      try {
        local.set(relativePath, await createFolderIn(parent, nameOf(relativePath)));
        result.folders++;
      } catch (error) {
        if (!isRefusedName(error)) throw couldNot('create', relativePath, error, signal);
        result.skipped.push(`${relativePath} (${REFUSED_NAME})`);
      }
    }
    const transfers = destination ? files.filter((file) => local.has(parentOf(file.relativePath))) : files;
    const transferBytes = transfers.reduce((sum, file) => sum + file.size, 0);
    result.fileCount = transfers.length;

    let completedBytes = 0;
    for (const [index, file] of transfers.entries()) {
      signal.throwIfAborted();
      const current = { name: file.relativePath, fileIndex: index + 1, fileCount: transfers.length };
      report({ ...current, loaded: completedBytes, total: transferBytes, bytesPerSecond: 0, phase: 'preparing' });
      const resume = downloadResume(file.path, signal);
      let blob: Blob;
      try {
        blob = await deps.download(
          `/api/sftp/${connId}/download?path=${encodeURIComponent(file.path)}`,
          (progress) =>
            report({
              ...current,
              loaded: completedBytes + progress.loaded,
              bytesPerSecond: progress.bytesPerSecond,
              phase: 'transferring',
            }),
          signal,
          undefined,
          resume,
        );
      } catch (error) {
        throw couldNot('download', file.relativePath, error, signal);
      } finally {
        // A Cancel later in the job must leave what another download keeps of this file.
        resume.release();
      }
      forgetInterruptedDownload(file.path);
      completedBytes += blob.size;
      if (destination) {
        try {
          await saveIntoFolder(local.get(parentOf(file.relativePath))!, nameOf(file.relativePath), blob);
        } catch (error) {
          if (!isRefusedName(error)) throw couldNot('save', file.relativePath, error, signal);
          result.skipped.push(`${file.relativePath} (${REFUSED_NAME})`);
          continue;
        }
      } else {
        deps.save(file.relativePath, blob);
      }
      result.downloaded++;
    }

    report({
      name:
        result.downloaded > 0 || result.folders === 0
          ? plural(result.downloaded, 'file')
          : plural(result.folders, 'folder'),
      loaded: completedBytes,
      total: completedBytes,
      bytesPerSecond: 0,
      phase: 'complete',
      fileIndex: transfers.length,
      fileCount: transfers.length,
    });
    return result;
  } catch (error) {
    // Any other abort rejects, so the caller can tell a closed browser from a lost connection.
    if (signal.reason !== TRANSFER_CANCELLED) throw error;
    return { ...result, cancelled: true };
  }
}

/** The toast after a download, e.g. "Downloaded 3 files to Downloads". */
export function downloadSummary(
  { downloaded, fileCount, folders, skipped, cancelled }: DownloadResult,
  folder?: string,
): string {
  if (cancelled) {
    const where = folder ? ` in ${folder}` : '';
    return downloaded > 0
      ? `Download cancelled: ${downloaded} of ${plural(fileCount, 'file')} saved${where}`
      : folders > 0
        ? `Download cancelled: ${plural(folders, 'folder')} created${where}`
        : 'Download cancelled';
  }
  const done =
    downloaded > 0
      ? `Downloaded ${plural(downloaded, 'file')}${folder ? ` to ${folder}` : ''}`
      : folders > 0
        ? `Created ${plural(folders, 'folder')}${folder ? ` in ${folder}` : ''}`
        : 'Nothing was downloaded';
  return skipped.length > 0 ? `${done}; ${plural(skipped.length, 'item')} skipped` : done;
}
