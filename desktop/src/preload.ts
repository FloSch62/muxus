import { Electroview } from 'electrobun/view';
import type { DesktopRPC, WindowAction } from './rpc.js';
import type { AppWindowLaunch, CommandLineLaunch } from '@muxus/shared';

const state: Record<string, string> = Object.create(null);
const pendingStateChanges = new Map<string, string | null>();
let hydrated = false;
const closeListeners = new Set<() => void>();
const cycleListeners = new Set<(backwards: boolean) => void>();
const launchListeners = new Set<(launch: CommandLineLaunch) => void>();
const pendingLaunches: CommandLineLaunch[] = [];
const subscribe = <T>(listeners: Set<T>, listener: T) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const rpc = Electroview.defineRPC<DesktopRPC>({
  maxRequestTime: 15_000,
  handlers: {
    requests: {},
    messages: {
      stateChanged: ({ name, value }) => {
        if (!hydrated) { pendingStateChanges.set(name, value); return; }
        if (value === null) delete state[name];
        else state[name] = value;
        window.dispatchEvent(new CustomEvent('muxus:state-changed', { detail: { name } }));
      },
      stateWriteFailed: () => {
        for (const [name, value] of Object.entries(state)) {
          try { localStorage.setItem(name, value); } catch { /* Storage unavailable. */ }
        }
      },
      closeTab: () => closeListeners.forEach((callback) => callback()),
      cycleTab: (backwards) => cycleListeners.forEach((callback) => callback(backwards)),
      commandLineLaunch: (launch) => {
        if (!launchListeners.size) pendingLaunches.push(launch);
        else launchListeners.forEach((callback) => callback(launch));
      },
    },
  },
});
new Electroview({ rpc });

// Hydrate before importing the SPA: Zustand reads persisted state at module load.
const documentReady = new Promise<void>((resolve) => {
  if (document.readyState !== 'loading') resolve();
  else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
});
async function bootstrap() {
  // WebKitGTK can reset its socket during the first navigation. Electrobun
  // then uses native IPC, but a request already sent on the socket is lost.
  // Only this idempotent read is retried; actions are never replayed.
  for (let attempt = 0; ; attempt++) {
    try { return await rpc.request.bootstrap(undefined, { maxRequestTime: 2000 }); }
    catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || error.message !== 'RPC request timed out.') throw error;
    }
  }
}
window.muxusDesktopReady = documentReady.then(bootstrap).then(({ platform, authToken, state: snapshot, launch, commandLineLaunch }) => {
  Object.assign(state, snapshot);
  // A native IPC batch may contain a response followed by newer state changes
  // before this promise continuation runs. Apply those after its snapshot.
  for (const [name, value] of pendingStateChanges) {
    if (value === null) delete state[name]; else state[name] = value;
  }
  pendingStateChanges.clear();
  hydrated = true;
  window.muxusDesktop = {
    platform,
    authToken,
    commandLineLaunch,
    windowLaunch: launch,
    stateStorage: {
      getItem: (name: string) => state[name] ?? null,
      setItem(name: string, value: string) {
        state[name] = value;
        rpc.send.stateChanged({ name, value });
      },
      removeItem(name: string) {
        delete state[name];
        rpc.send.stateChanged({ name, value: null });
      },
    },
    getAppInfo: () => rpc.request.getAppInfo(),
    checkForUpdate: (options?: { force?: boolean }) => rpc.request.checkForUpdate(options),
    selectPrivateKey: () => rpc.request.selectPrivateKey(),
    readMobaXtermSessions: () => rpc.request.readMobaXtermSessions(),
    listLocalFontFamilies: () => rpc.request.listLocalFontFamilies(),
    readClipboard: () => rpc.request.clipboardRead(),
    writeClipboard: (text: string) => rpc.request.clipboardWrite(text),
    setZoomFactor: (factor: number) => rpc.send.setZoomFactor(factor),
    setTitlebarHeight: (height: number) => rpc.send.setTitlebarHeight(height),
    setActiveWorkspace: (workspaceId?: string, workspaceTitle?: string, clearReloadLaunch?: boolean) => rpc.send.activeWorkspace({ workspaceId, workspaceTitle, clearReloadLaunch }),
    focusWindow: () => rpc.send.focusWindow(),
    onCommandLineLaunch: (callback: (value: CommandLineLaunch) => void) => {
      const dispose = subscribe(launchListeners, callback);
      pendingLaunches.splice(0).forEach(callback);
      return dispose;
    },
    openWindow: (value: AppWindowLaunch) => rpc.send.openWindow(value),
    detachTab: (value: Extract<AppWindowLaunch, { kind: 'tab-transfer' }>) => rpc.request.detachTab(value),
    onCloseTab: (callback: () => void) => subscribe(closeListeners, callback),
    onCycleTab: (callback: (backwards: boolean) => void) => subscribe(cycleListeners, callback),
    closeWindow: () => rpc.send.closeWindow(),
    minimizeWindow: () => rpc.send.minimizeWindow(),
    toggleMaximize: () => rpc.send.toggleMaximize(),
  };
  rpc.send.ready();

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const mod = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    // Linux has no native application menu. Dispatch window commands through
    // the same typed handler used by menu actions on macOS and Windows.
    let action: WindowAction | undefined;
    if (mod && !event.altKey) {
      if (key === 'r' && event.shiftKey) action = 'reload';
      else if (key === 'q' && platform === 'darwin') action = 'quit';
      else if (key === 'i' && event.shiftKey) action = 'devtools';
    }
    if (key === 'f11' && !mod) action = 'fullscreen';
    if (action) {
      event.preventDefault();
      rpc.send.windowAction(action);
      return;
    }
    if (platform === 'darwin' && mod && key === 'w' && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      closeListeners.forEach((callback) => callback());
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && key === 'tab') {
      event.preventDefault();
      cycleListeners.forEach((callback) => callback(event.shiftKey));
    }
  }, true);
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin && ['https:', 'http:', 'mailto:'].includes(url.protocol)) {
      event.preventDefault();
      rpc.send.openExternal(url.href);
    }
  }, true);
});
