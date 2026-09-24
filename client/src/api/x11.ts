import { apiFetch } from './http.js';

/** Tell the server whether the bundled X server may share the clipboard; idempotent. */
export function setX11ClipboardSharing(clipboard: boolean): Promise<{ clipboard: boolean }> {
  return apiFetch<{ clipboard: boolean }>('/api/x11/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clipboard }),
  });
}
