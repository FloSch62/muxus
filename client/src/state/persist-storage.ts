import type { StateStorage } from 'zustand/middleware';

function desktopStorage() {
  return typeof window === 'undefined' ? undefined : window.muxusDesktop?.stateStorage;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Prefers the Electron desktop store (survives the random-port origin),
 *  falling back to localStorage — and migrating between the two. */
export const muxusStateStorage: StateStorage = {
  getItem(name) {
    const desktop = desktopStorage();
    if (desktop) {
      try {
        const value = desktop.getItem(name);
        if (value !== null) return value;
      } catch {
        /* fall back to browser storage */
      }
    }

    const value = browserStorage()?.getItem(name) ?? null;
    if (desktop && value !== null) {
      try {
        desktop.setItem(name, value);
      } catch {
        /* best-effort migration from origin-scoped storage */
      }
    }
    return value;
  },
  setItem(name, value) {
    const desktop = desktopStorage();
    if (desktop) {
      try {
        desktop.setItem(name, value);
        return;
      } catch {
        /* fall back to browser storage */
      }
    }
    browserStorage()?.setItem(name, value);
  },
  removeItem(name) {
    const desktop = desktopStorage();
    if (desktop) {
      try {
        desktop.removeItem(name);
      } catch {
        /* also clear browser storage below */
      }
    }
    browserStorage()?.removeItem(name);
  },
};

/**
 * Call back when another window saves or removes `name`; returns unsubscribe.
 * Desktop windows hear it from the main process, browser tabs from the
 * storage event (which never fires in the tab that wrote).
 */
export function onStateItemChange(name: string, callback: () => void): () => void {
  const desktop = desktopStorage();
  if (desktop) {
    return desktop.onChange((changed) => {
      if (changed === name) callback();
    });
  }
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: StorageEvent) => {
    // A null key means the whole storage was cleared.
    if (event.key === name || event.key === null) callback();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
