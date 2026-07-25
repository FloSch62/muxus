const desktopPlatform = typeof window === 'undefined' ? undefined : window.muxusDesktop?.platform;
const browserPlatform = typeof navigator === 'undefined' ? '' : (navigator.platform ?? '');

/** True on macOS — the desktop app reports the real platform; browsers are sniffed. */
export const IS_MAC = desktopPlatform
  ? desktopPlatform === 'darwin'
  : /Mac|iP(hone|ad|od)/.test(browserPlatform);

/** Prefix for rendering a mod-key shortcut inline, e.g. "⌘1" / "Ctrl+1". */
export const HOTKEY_MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';
