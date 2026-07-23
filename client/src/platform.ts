/** True on macOS — the desktop app reports the real platform; browsers are sniffed. */
export const IS_MAC = window.muxusDesktop ? window.muxusDesktop.platform === 'darwin' : /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** Prefix for rendering a mod-key shortcut inline, e.g. "⌘1" / "Ctrl+1". */
export const HOTKEY_MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';
