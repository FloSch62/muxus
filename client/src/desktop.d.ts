import type { AppInfo, AppWindowLaunch, UpdateCheckResult } from '@muxus/shared';

declare global {
  /** Native desktop bridge (absent in regular browsers). */
  interface Window {
    muxusDesktop?: {
      /** Native runtime implementation. */
      runtime?: 'wails';
      /** Wails host platform ('linux', 'win32', 'darwin', …). */
      platform: string;
      /** Per-run backend credential delivered in the never-transmitted URL fragment. */
      authToken: string;
      /** One-shot payload describing the content of a secondary app window. */
      windowLaunch?: AppWindowLaunch;
      stateStorage: {
        getItem(name: string): string | null;
        setItem(name: string, value: string): void;
        removeItem(name: string): void;
      };
      setTitleBarOverlay(options: { color: string; symbolColor: string }): void;
      /** Scale the whole window natively (the interface zoom preference). */
      setZoomFactor(factor: number): void;
      getAppInfo(): Promise<AppInfo | undefined>;
      checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult>;
      /** Choose an SSH private key with the operating system's file picker. */
      selectPrivateKey(): Promise<string | undefined>;
      /** Open a secondary native application window. */
      openWindow(launch: AppWindowLaunch): void;
      /** Subscribe to the OS close-window chord (Cmd/Ctrl+W); returns unsubscribe. */
      onCloseTab(callback: () => void): () => void;
      /** Subscribe to the tab-cycling chords (Ctrl+Tab & friends); backwards=true cycles left. */
      onCycleTab(callback: (backwards: boolean) => void): () => void;
      /** Close the main window (fallback when no terminal tab is open). */
      closeWindow(): void;
      /** Frameless-window controls used by Wails on Windows and Linux. */
      minimizeWindow(): void;
      toggleMaximizeWindow(): Promise<boolean>;
      isWindowMaximized(): Promise<boolean>;
    };
  }
}

export {};
