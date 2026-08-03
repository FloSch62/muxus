/**
 * Server-side twins of the client's folder-path helpers (client/src/host-tree.ts).
 * A folder is a `/`-separated path stored on host metadata; segments are
 * trimmed and matched case-insensitively. Folder settings are keyed by the
 * lowercased path so "Prod/EU" and "prod/eu" address the same folder.
 */

const FOLDER_SEPARATOR = '/';

export function folderPathSegments(path: string | null | undefined): string[] {
  if (!path) return [];
  return path
    .split(FOLDER_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The canonical stored form of a folder path; '' means "no folder". */
export function normalizeFolderPath(path: string | null | undefined): string {
  return folderPathSegments(path).join(FOLDER_SEPARATOR);
}

/** Case-insensitive identity of a folder path. */
export function folderPathKey(path: string | null | undefined): string {
  return folderPathSegments(path)
    .map((segment) => segment.toLowerCase())
    .join(FOLDER_SEPARATOR);
}

/** The path itself and every ancestor, nearest first ("a/b/c", "a/b", "a"). */
export function folderChain(path: string | null | undefined): string[] {
  const segments = folderPathSegments(path);
  return segments
    .map((_segment, index) => segments.slice(0, index + 1).join(FOLDER_SEPARATOR))
    .reverse();
}

/** Whether `candidate` sits strictly inside `ancestor`. */
export function isDescendantFolderPath(candidate: string, ancestor: string): boolean {
  const parent = folderPathKey(ancestor);
  const child = folderPathKey(candidate);
  return parent.length > 0 && child.startsWith(`${parent}${FOLDER_SEPARATOR}`);
}

/** Where `path` lands when the folder `from` is renamed or moved to `to`. */
export function renameFolderPathUnder(path: string, from: string, to: string): string | undefined {
  if (folderPathKey(path) === folderPathKey(from)) return normalizeFolderPath(to);
  if (!isDescendantFolderPath(path, from)) return undefined;
  const tail = folderPathSegments(path).slice(folderPathSegments(from).length);
  return [...folderPathSegments(to), ...tail].join(FOLDER_SEPARATOR);
}
