import type { AppInfo, AppWindowLaunch, UpdateCheckResult } from '@muxus/shared';

function fragmentValues(): URLSearchParams {
  const hash = window.location.hash;
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

async function nativeFetch<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T | undefined> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) return undefined;
    if (response.status === 204) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Install the Wails implementation of the preload bridge before any persisted
 * Zustand store is imported. Browser mode deliberately does nothing.
 */
export async function initializeWailsDesktop(): Promise<void> {
  const fragment = fragmentValues();
  if (fragment.get('shell') !== '1') return;

  const token = fragment.get('token') ?? '';
  const platform = fragment.get('platform') ?? '';
  const runtime = await import('@wailsio/runtime');
  const snapshot =
    (await nativeFetch<Record<string, string>>(token, '/api/desktop/state')) ?? {};

  const fireAndForget = (path: string, init: RequestInit) => {
    void nativeFetch(token, path, init);
  };
  const listen = <T>(name: string, callback: (data: T) => void): (() => void) =>
    runtime.Events.On(name, (event) => callback(event.data as T));

  listen('muxus:state:write-failed', () => {
    try {
      for (const [name, value] of Object.entries(snapshot)) {
        window.localStorage.setItem(name, value);
      }
    } catch {
      // The disk store and browser fallback are both unavailable.
    }
  });

  window.muxusDesktop = {
    runtime: 'wails',
    platform,
    authToken: token,
    stateStorage: {
      getItem(name) {
        return snapshot[name] ?? null;
      },
      setItem(name, value) {
        snapshot[name] = value;
        fireAndForget(`/api/desktop/state/${encodeURIComponent(name)}`, {
          method: 'PUT',
          body: JSON.stringify({ value }),
        });
      },
      removeItem(name) {
        delete snapshot[name];
        fireAndForget(`/api/desktop/state/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        });
      },
    },
    setTitleBarOverlay() {
      // Wails renders the non-macOS caption buttons in the web toolbar.
    },
    setZoomFactor(factor) {
      void runtime.Window.SetZoom(Math.min(2, Math.max(0.5, factor)));
    },
    getAppInfo() {
      return nativeFetch<AppInfo>(token, '/api/app/info');
    },
    async checkForUpdate(options) {
      const suffix = options?.force ? '?force=true' : '';
      return (
        (await nativeFetch<UpdateCheckResult>(
          token,
          `/api/app/update-check${suffix}`,
        )) ?? {
          available: false,
          currentVersion: '0.0.0',
          reason: 'network',
        }
      );
    },
    async selectPrivateKey() {
      const info = await nativeFetch<AppInfo>(token, '/api/app/info');
      const result = await runtime.Dialogs.OpenFile({
        Title: 'Choose SSH private key',
        Directory: info ? `${info.homeDir}/.ssh` : undefined,
        ButtonText: 'Use key',
        CanChooseFiles: true,
        CanChooseDirectories: false,
        ShowHiddenFiles: true,
        AllowsMultipleSelection: false,
      });
      return typeof result === 'string' && result ? result : undefined;
    },
    openWindow(launch: AppWindowLaunch) {
      fireAndForget('/api/desktop/windows', {
        method: 'POST',
        body: JSON.stringify(launch),
      });
    },
    onCloseTab(callback) {
      return listen('muxus:close-tab', callback);
    },
    onCycleTab(callback) {
      return listen<boolean>('muxus:cycle-tab', (value) => callback(value === true));
    },
    closeWindow() {
      void runtime.Window.Close();
    },
    minimizeWindow() {
      void runtime.Window.Minimise();
    },
    async toggleMaximizeWindow() {
      await runtime.Window.ToggleMaximise();
      return runtime.Window.IsMaximised();
    },
    isWindowMaximized() {
      return runtime.Window.IsMaximised();
    },
  };
}
