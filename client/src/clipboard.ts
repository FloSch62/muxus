export type ClipboardContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; png: Uint8Array<ArrayBuffer> }
  | { kind: 'empty' }
  | { kind: 'unavailable' };

/**
 * Read text from the clipboard. The async Clipboard API has no legacy read
 * fallback (execCommand('paste') never worked reliably), so this returns null
 * when the API is unavailable (plain-http LAN) or the user denied permission.
 */
export async function readFromClipboard(): Promise<string | null> {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** Capture one clipboard snapshot; the packaged app reads text and image synchronously. */
export async function readClipboardContent(): Promise<ClipboardContent> {
  if (window.muxusDesktop?.readClipboardContent) {
    return (await window.muxusDesktop.readClipboardContent()) ?? { kind: 'unavailable' };
  }
  const text = await readFromClipboard();
  if (text === null) return { kind: 'unavailable' };
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

/**
 * Copy text to the clipboard. The async Clipboard API only exists in secure
 * contexts (https/localhost/Electron); when the UI is served over plain http
 * on a LAN address it is undefined, so fall back to a hidden textarea +
 * execCommand. Returns whether the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or transient failure — try the legacy path.
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
