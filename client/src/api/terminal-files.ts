import type { StagedTransferFile } from '@muxus/shared';
import { apiFetch } from './http.js';
import { downloadBlobWithProgress, uploadRawWithProgress, type ByteProgress } from './transfers.js';

/** Hand a picked file to the backend, which sends it once the transfer starts. */
export async function stageTerminalFile(
  file: File,
  onProgress: (progress: ByteProgress) => void,
  signal?: AbortSignal,
): Promise<StagedTransferFile> {
  const query = new URLSearchParams({ name: file.name });
  if (file.lastModified > 0) query.set('mtimeMs', String(file.lastModified));
  return (await uploadRawWithProgress(`/api/terminal-files?${query.toString()}`, file, {
    onProgress,
    signal,
  })) as StagedTransferFile;
}

/** A received file; the backend forgets it once it has been fetched. */
export function fetchReceivedFile(id: string, onProgress: (progress: ByteProgress) => void): Promise<Blob> {
  return downloadBlobWithProgress(`/api/terminal-files/${encodeURIComponent(id)}`, onProgress);
}

export async function discardStagedFile(id: string): Promise<void> {
  await apiFetch(`/api/terminal-files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
