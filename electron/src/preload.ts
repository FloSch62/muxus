import { contextBridge, ipcRenderer } from 'electron';

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
  setTitleBarOverlay(options: { color: string; symbolColor: string }) {
    ipcRenderer.send('muxus:set-titlebar-overlay', options);
  },
  getAppInfo() {
    return ipcRenderer.invoke('muxus:get-app-info');
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
