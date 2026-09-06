import type { RPCSchema } from 'electrobun/main';
import type { AppWindowLaunch, CommandLineLaunch, MobaXtermSessionSource, UpdateCheckResult } from '@muxus/shared';

export type WindowAction = 'quit' | 'close-tab' | 'close-window' | 'previous-tab' | 'next-tab' | 'reload' | 'devtools' | 'fullscreen';
export type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      bootstrap: { params: undefined; response: { platform: string; authToken: string; state: Record<string, string>; launch?: AppWindowLaunch; commandLineLaunch?: CommandLineLaunch } };
      getAppInfo: { params: undefined; response: { name: string; version: string } };
      checkForUpdate: { params: { force?: boolean } | undefined; response: UpdateCheckResult };
      selectPrivateKey: { params: undefined; response: string | undefined };
      readMobaXtermSessions: { params: undefined; response: MobaXtermSessionSource | undefined };
      listLocalFontFamilies: { params: undefined; response: string[] | undefined };
      detachTab: { params: AppWindowLaunch; response: boolean };
      clipboardRead: { params: undefined; response: string | null };
      clipboardWrite: { params: string; response: boolean };
    };
    messages: {
      ready: undefined;
      stateChanged: { name: string; value: string | null };
      openWindow: AppWindowLaunch;
      activeWorkspace: { workspaceId?: string; workspaceTitle?: string; clearReloadLaunch?: boolean };
      windowAction: WindowAction;
      closeWindow: undefined;
      minimizeWindow: undefined;
      toggleMaximize: undefined;
      focusWindow: undefined;
      setZoomFactor: number;
      setTitlebarHeight: number;
      openExternal: string;
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      stateChanged: { name: string; value: string | null };
      stateWriteFailed: undefined;
      closeTab: undefined;
      cycleTab: boolean;
      commandLineLaunch: CommandLineLaunch;
    };
  }>;
};
