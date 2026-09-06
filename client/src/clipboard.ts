/**
 * Read text from the clipboard. The async Clipboard API has no legacy read
 * fallback (execCommand('paste') never worked reliably), so this returns null
 * when the API is unavailable (plain-http LAN) or the user denied permission.
 */
export async function readFromClipboard(): Promise<string | null> {
  if (window.muxusDesktop) {
    try { return await window.muxusDesktop.readClipboard(); } catch { return null; }
  }
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * Copy text to the clipboard. The async Clipboard API only exists in secure
 * contexts (https/localhost); when the UI is served over plain http
 * on a LAN address it is undefined, so fall back to a hidden textarea +
 * execCommand. Returns whether the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (window.muxusDesktop) {
    try { return await window.muxusDesktop.writeClipboard(text); } catch { return false; }
  }
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
