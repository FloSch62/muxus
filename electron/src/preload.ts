import { contextBridge, ipcRenderer } from 'electron';
import type { AppWindowLaunch, MobaXtermSessionSource } from '@muxus/shared';

// Client state is mirrored here and persisted with fire-and-forget messages.
// sendSync is deliberately avoided for the steady-state path: it parks the
// renderer main thread in an untimed wait, and a single lost reply freezes
// the whole UI permanently. The one sync call left is the boot-time snapshot
// below, before the page loads.
const stateSnapshot: Record<string, string> = (() => {
  try {
    const all = ipcRenderer.sendSync('muxus:state:get-all') as unknown;
    return all && typeof all === 'object' ? (all as Record<string, string>) : {};
  } catch {
    return {};
  }
})();

const authToken: string = (() => {
  try {
    const value: unknown = ipcRenderer.sendSync('muxus:auth-token');
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
})();

const windowLaunch: AppWindowLaunch | undefined = (() => {
  try {
    const value: unknown = ipcRenderer.sendSync('muxus:window-launch');
    return value && typeof value === 'object' ? (value as AppWindowLaunch) : undefined;
  } catch {
    return undefined;
  }
})();

interface LocalFontData {
  family?: unknown;
}

type QueryLocalFonts = () => Promise<LocalFontData[]>;

type DesktopClipboardContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; png: Uint8Array<ArrayBuffer> }
  | { kind: 'empty' };

let localFontFamilies: Promise<string[] | undefined> | undefined;

/**
 * Chromium owns the cross-platform OS-font lookup. Keep the fingerprintable
 * result inside the trusted desktop app and expose family names only.
 */
function listLocalFontFamilies(): Promise<string[] | undefined> {
  localFontFamilies ??= (async () => {
    const fontWindow = globalThis as typeof globalThis & {
      queryLocalFonts?: QueryLocalFonts;
    };
    const query = fontWindow.queryLocalFonts;
    if (!query) return undefined;
    try {
      const fonts = await query.call(fontWindow);
      const families = new Map<string, string>();
      for (const font of fonts) {
        if (typeof font.family !== 'string') continue;
        const family = font.family.trim();
        if (!family || family.length > 200) continue;
        families.set(family.toLowerCase(), family);
      }
      return [...families.values()].sort((left, right) => left.localeCompare(right));
    } catch {
      return undefined;
    }
  })();
  return localFontFamilies;
}

// The disk-side write failed in the main process: mirror the snapshot into
// origin-scoped localStorage so a relaunch on the same origin can migrate it
// back (muxusStateStorage.getItem reads browser storage when the desktop
// store has no value).
ipcRenderer.on('muxus:state:write-failed', () => {
  try {
    for (const [name, value] of Object.entries(stateSnapshot)) window.localStorage.setItem(name, value);
  } catch {
    /* browser storage unavailable — nothing left to fall back to */
  }
});

// Desktop bridge for stable client state plus native window integrations.
contextBridge.exposeInMainWorld('muxusDesktop', {
  platform: process.platform,
  authToken,
  windowLaunch,
  stateStorage: {
    getItem(name: string): string | null {
      return stateSnapshot[name] ?? null;
    },
    setItem(name: string, value: string): void {
      stateSnapshot[name] = value;
      ipcRenderer.send('muxus:state:set-item', name, value);
    },
    removeItem(name: string): void {
      delete stateSnapshot[name];
      ipcRenderer.send('muxus:state:remove-item', name);
    },
  },
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }) {
    ipcRenderer.send('muxus:set-titlebar-overlay', options);
  },
  setZoomFactor(factor: number) {
    ipcRenderer.send('muxus:set-zoom-factor', factor);
  },
  getAppInfo() {
    return ipcRenderer.invoke('muxus:get-app-info');
  },
  checkForUpdate(options?: { force?: boolean }) {
    return ipcRenderer.invoke('muxus:check-for-update', options);
  },
  /** Capture OS clipboard text or a validated PNG in one main-process snapshot. */
  readClipboardContent(): Promise<DesktopClipboardContent | undefined> {
    return ipcRenderer.invoke('muxus:read-clipboard-content');
  },
  /** Open a native single-file picker and return only the user-selected path. */
  selectPrivateKey(): Promise<string | undefined> {
    return ipcRenderer.invoke('muxus:select-private-key');
  },
  /** Read bookmark-only session data from the current Windows user's MobaXterm install. */
  readMobaXtermSessions(): Promise<MobaXtermSessionSource | undefined> {
    return ipcRenderer.invoke('muxus:read-mobaxterm-sessions');
  },
  /** List font families exposed by the operating system to Chromium. */
  listLocalFontFamilies,
  openWindow(launch: AppWindowLaunch): void {
    ipcRenderer.send('muxus:open-window', launch);
  },
  /** Detach a tab only when the native cursor is outside every Muxus window. */
  detachTab(launch: Extract<AppWindowLaunch, { kind: 'tab-transfer' }>): Promise<boolean> {
    return ipcRenderer.invoke('muxus:detach-tab', launch);
  },
  setActiveWorkspace(
    workspaceId?: string,
    workspaceTitle?: string,
    clearReloadLaunch?: boolean,
  ): void {
    ipcRenderer.send(
      'muxus:active-workspace',
      workspaceId,
      workspaceTitle,
      clearReloadLaunch,
    );
  },
  focusWindow(): void {
    ipcRenderer.send('muxus:focus-window');
  },
  // Fires when the user presses the OS close-window chord (Cmd/Ctrl+W).
  // Returns an unsubscribe. The renderer closes the focused terminal tab; it
  // never closes the window from this chord.
  onCloseTab(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on('muxus:close-tab', listener);
    return () => ipcRenderer.removeListener('muxus:close-tab', listener);
  },
  // Fires on the tab-cycling chords (Ctrl+Tab, macOS Cmd+Shift+[/]);
  // backwards=true cycles left. Returns an unsubscribe.
  onCycleTab(callback: (backwards: boolean) => void): () => void {
    const listener = (_event: unknown, backwards: unknown): void => callback(backwards === true);
    ipcRenderer.on('muxus:cycle-tab', listener);
    return () => ipcRenderer.removeListener('muxus:cycle-tab', listener);
  },
  closeWindow(): void {
    ipcRenderer.send('muxus:close-window');
  },
});
