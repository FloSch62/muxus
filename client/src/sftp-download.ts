/**
 * Saving several downloaded files at once. A download link asks where to save
 * each file in the desktop app, so where the page may write to a folder (the
 * desktop app and Chromium browsers), the folder is picked once and every file
 * is written into it. Elsewhere the files go to the browser's downloads.
 */

type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'downloads' | 'desktop' | 'documents';
}) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | undefined {
  return (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
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
