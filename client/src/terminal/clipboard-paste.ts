import { apiFetchRaw } from '../api/http.js';

export type TerminalClipboardPasteResult =
  | { status: 'pasted'; kind: 'image-path' | 'text' }
  | { status: 'skipped'; reason: 'empty' | 'unavailable' };

interface TerminalClipboardPasteOptions {
  readText: () => Promise<string | null>;
  readImagePng: () => Promise<Uint8Array<ArrayBuffer> | undefined>;
  uploadImage: (png: Uint8Array<ArrayBuffer>) => Promise<string>;
  pasteText: (text: string) => void;
}

export function remoteClipboardImagePath(
  timestamp = Date.now(),
  id: string = crypto.randomUUID(),
): string {
  return `/tmp/muxus-paste-${timestamp}-${id}.png`;
}

export async function uploadTerminalClipboardImage(
  connId: string,
  png: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const remotePath = remoteClipboardImagePath();
  await apiFetchRaw(
    `/api/sftp/${encodeURIComponent(connId)}/upload?path=${encodeURIComponent(remotePath)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    },
  );
  return remotePath;
}

/** Paste text when present; image-only clipboards become an uploaded remote path. */
export async function pasteTerminalClipboard({
  readText,
  readImagePng,
  uploadImage,
  pasteText,
}: TerminalClipboardPasteOptions): Promise<TerminalClipboardPasteResult> {
  const text = await readText();
  if (text) {
    pasteText(text);
    return { status: 'pasted', kind: 'text' };
  }

  const png = await readImagePng();
  if (!png) {
    return { status: 'skipped', reason: text === null ? 'unavailable' : 'empty' };
  }

  const remotePath = await uploadImage(png);
  pasteText(remotePath);
  return { status: 'pasted', kind: 'image-path' };
}
