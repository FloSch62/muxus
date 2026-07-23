import type { AppInfo } from '@muxus/shared';

declare global {
  /** Bridge exposed by the Electron preload (absent in regular browsers). */
  interface Window {
    muxusDesktop?: {
      /** Electron's process.platform ('linux', 'win32', 'darwin', …). */
      platform: string;
      /** Per-run backend credential delivered over the isolated preload bridge. */
      authToken: string;
      stateStorage: {
        getItem(name: string): string | null;
        setItem(name: string, value: string): void;
        removeItem(name: string): void;
      };
      setTitleBarOverlay(options: { color: string; symbolColor: string }): void;
      getAppInfo(): Promise<AppInfo | undefined>;
      /** Choose an SSH private key with the operating system's file picker. */
      selectPrivateKey(): Promise<string | undefined>;
      /** Subscribe to the OS close-window chord (Cmd/Ctrl+W); returns unsubscribe. */
      onCloseTab(callback: () => void): () => void;
      /** Subscribe to the tab-cycling chords (Ctrl+Tab & friends); backwards=true cycles left. */
      onCycleTab(callback: (backwards: boolean) => void): () => void;
      /** Close the main window (fallback when no terminal tab is open). */
      closeWindow(): void;
    };
  }
}

export {};
