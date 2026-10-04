import type {
  AppInfo,
  AppWindowLaunch,
  CommandLineLaunch,
  DesktopUpdateState,
  MobaXtermSessionSource,
  UpdateCheckResult,
} from '@muxus/shared';

type DesktopClipboardContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; png: Uint8Array<ArrayBuffer> }
  | { kind: 'empty' };

declare global {
  /** Bridge exposed by the Electron preload (absent in regular browsers). */
  interface Window {
    muxusDesktop?: {
      /** Electron's process.platform ('linux', 'win32', 'darwin', …). */
      platform: string;
      /** Per-run backend credential delivered over the isolated preload bridge. */
      authToken: string;
      /** One-shot payload describing the content of a secondary app window. */
      windowLaunch?: AppWindowLaunch;
      /** One-shot host, folder, or workspace target supplied to the executable. */
      commandLineLaunch?: CommandLineLaunch;
      stateStorage: {
        getItem(name: string): string | null;
        setItem(name: string, value: string): void;
        removeItem(name: string): void;
      };
      setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
      /** Scale the whole window natively (the interface zoom preference). */
      setZoomFactor(factor: number): void;
      getAppInfo(): Promise<AppInfo | undefined>;
      checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult>;
      /** In-app update state; `disabled` builds fall back to checkForUpdate. */
      getUpdateState(): Promise<DesktopUpdateState | undefined>;
      checkForUpdates(): Promise<DesktopUpdateState | undefined>;
      /** Store installations only: open the Muxus page in Microsoft Store. */
      openStore(): Promise<void>;
      downloadUpdate(): Promise<DesktopUpdateState | undefined>;
      /** Restart into a downloaded update, or start a Store update. */
      installUpdate(): Promise<boolean>;
      /** Turn background update checks on or off (the "Notify me" preference). */
      setAutomaticUpdateChecks(enabled: boolean): void;
      onUpdateState(callback: (state: DesktopUpdateState) => void): () => void;
      /** Capture OS clipboard text or a validated PNG in one main-process snapshot. */
      readClipboardContent(): Promise<DesktopClipboardContent | undefined>;
      /** Choose an SSH private key with the operating system's file picker. */
      selectPrivateKey(): Promise<string | undefined>;
      /** Choose where a session log file goes, starting from `defaultPath`. */
      selectLogFile(defaultPath: string): Promise<string | undefined>;
      /** Reveal a file in the operating system's file manager. */
      showItemInFolder(file: string): void;
      /** Read bookmark-only sessions from the current Windows user's MobaXterm install. */
      readMobaXtermSessions(): Promise<MobaXtermSessionSource | undefined>;
      /** List font families installed for the current operating-system user. */
      listLocalFontFamilies(): Promise<string[] | undefined>;
      /** Open a secondary native application window. */
      openWindow(launch: AppWindowLaunch): void;
      /** Subscribe to launch targets forwarded by later executable invocations. */
      onCommandLineLaunch(callback: (launch: CommandLineLaunch) => void): () => void;
      /** Open a tab-transfer window when the native cursor is outside every app window. */
      detachTab(
        launch: Extract<AppWindowLaunch, { kind: 'tab-transfer' }>,
      ): Promise<boolean>;
      /** Register the saved workspace currently owned by this native window. */
      setActiveWorkspace(
        workspaceId?: string,
        workspaceTitle?: string,
        clearReloadLaunch?: boolean,
      ): void;
      /** Bring this native window to the foreground. */
      focusWindow(): void;
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
