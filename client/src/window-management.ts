import type { AppWindowLaunch } from '@muxus/shared';
import { authToken } from './api/http.js';

const LAUNCH_FRAGMENT_KEY = 'launch';

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function isAppWindowLaunch(value: unknown): value is AppWindowLaunch {
  if (!value || typeof value !== 'object') return false;
  const launch = value as Record<string, unknown>;
  if (launch.kind === 'session') {
    if (typeof launch.title !== 'string' || !launch.profile || typeof launch.profile !== 'object') {
      return false;
    }
    const profile = launch.profile as Record<string, unknown>;
    return (
      (profile.kind === 'local' &&
        (profile.shell === undefined || typeof profile.shell === 'string') &&
        (profile.cwd === undefined || typeof profile.cwd === 'string')) ||
      (profile.kind === 'ssh' && typeof profile.target === 'string' && profile.target.length > 0)
    );
  }
  return (
    launch.kind === 'sftp' &&
    typeof launch.connId === 'string' &&
    launch.connId.length > 0 &&
    typeof launch.title === 'string' &&
    (launch.path === undefined || typeof launch.path === 'string')
  );
}

export function encodeAppWindowLaunch(launch: AppWindowLaunch): string {
  return encodeBase64Url(JSON.stringify(launch));
}

export function decodeAppWindowLaunch(value: string): AppWindowLaunch | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(value));
    return isAppWindowLaunch(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Consume the one-shot launch payload supplied by Electron or a browser URL. */
export function consumeAppWindowLaunch(): AppWindowLaunch | undefined {
  if (window.muxusDesktop?.windowLaunch) return window.muxusDesktop.windowLaunch;

  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  const encoded = fragment.get(LAUNCH_FRAGMENT_KEY);
  if (!encoded) return undefined;

  fragment.delete(LAUNCH_FRAGMENT_KEY);
  const nextFragment = fragment.toString();
  url.hash = nextFragment ? `#${nextFragment}` : '';
  window.history.replaceState({}, '', url.toString());
  return decodeAppWindowLaunch(encoded);
}

/** Ask the desktop shell for a native window, with a same-origin browser fallback. */
export function openAppWindow(launch: AppWindowLaunch): void {
  if (window.muxusDesktop) {
    window.muxusDesktop.openWindow(launch);
    return;
  }

  const url = new URL(window.location.href);
  url.search = '';
  const fragment = new URLSearchParams();
  fragment.set(LAUNCH_FRAGMENT_KEY, encodeAppWindowLaunch(launch));
  const token = authToken();
  if (token) fragment.set('token', token);
  url.hash = fragment.toString();
  window.open(url.toString(), '_blank', 'noopener');
}
