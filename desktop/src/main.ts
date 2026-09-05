import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Screen, Utils } from 'electrobun/main';
import { startServer, SystemVaultKeyStore, type RunningServer } from '@muxus/server';
import type { AppWindowLaunch, CommandLineLaunch, UpdateCheckResult } from '@muxus/shared';
import { version } from '../package.json';
import type { DesktopRPC } from './rpc.js';
import { parseWindowLaunch } from './policy.js';
import { ClientState } from './state.js';
import { installedUserDataPath, isDevelopmentBuild, userDataPath } from './paths.js';
import { seedDevelopmentDatabase } from './development-database.js';
import { importLoginShellEnvironment } from './login-shell-environment.js';
import { initMainLog, installCrashCapture, mainLog, mainLogPath } from './main-log.js';
import { canHandleCommandLineLaunch, initialCommandLineLaunch, parseCommandLineLaunchData } from './command-line.js';
import { workspaceOwnershipUpdate } from './workspace-window-state.js';
import { pointInsideAnyWindow } from './tab-detach.js';
import { readLocalMobaXtermSessions } from './mobaxterm.js';
import { listLocalFontFamilies } from './fonts.js';
import { checkForUpdate } from './update-check.js';

type Window = BrowserWindow<ReturnType<typeof BrowserView.defineRPC<DesktopRPC>>>;
const windows = new Set<Window>();
const launches = new Map<Window, AppWindowLaunch>();
const activeWorkspaces = new Map<Window, string>();
const readyWindows = new Set<Window>();
const bootstrapLaunches = new Map<Window, CommandLineLaunch>();
const pendingLaunches: CommandLineLaunch[] = [];
const userData = userDataPath();
const resources = path.resolve('../Resources/app');
const windowStateFile = path.join(userData, 'window-state.json');
const isMac = process.platform === 'darwin';
let primary: Window | undefined;
let focused: Window | undefined;
let server: RunningServer | undefined;
let preload: string;
let state: ClientState;
let closing: Promise<void> | undefined;
let quitReady = false;
let updateCheck: Promise<UpdateCheckResult> | undefined;

function focus(win?: Window): void {
  if (win?.isMinimized()) win.unminimize();
  win?.activate();
}

function deliverLaunches(): void {
  if (!pendingLaunches.length) return;
  const target = [...windows].find((win) => canHandleCommandLineLaunch(launches.get(win)));
  if (!target) return;
  if (readyWindows.has(target)) for (const launch of pendingLaunches.splice(0)) target.webview.rpc?.send.commandLineLaunch(launch);
  focus(target);
}

function activate(value?: string): void {
  if (closing) return;
  let launch: CommandLineLaunch | undefined;
  try { if (value) launch = parseCommandLineLaunchData(JSON.parse(value)); } catch { /* Invalid handoff. */ }
  if (launch) pendingLaunches.push(launch);
  if (server && ![...windows].some((win) => canHandleCommandLineLaunch(launches.get(win)))) createWindow();
  deliverLaunches();
  if (!launch) focus(focused ?? primary);
}

function loadFrame(): { width: number; height: number; x?: number; y?: number; maximized?: boolean } {
  try {
    const frame = JSON.parse(readFileSync(windowStateFile, 'utf8'));
    if (![frame.width, frame.height].every((value) => Number.isFinite(value) && value >= 500 && value <= 16_384)) throw new Error('Invalid frame');
    const visible = Screen.getAllDisplays().some(({ workArea: b }) => frame.x < b.x + b.width && frame.x + frame.width > b.x && frame.y < b.y + b.height && frame.y + frame.height > b.y);
    return { width: frame.width, height: frame.height, ...(visible ? { x: frame.x, y: frame.y } : {}), maximized: frame.maximized === true };
  } catch { return { width: 1440, height: 900 }; }
}

function openWindow(value: unknown): void {
  if (closing) return;
  const launch = parseWindowLaunch(value);
  if (!launch) return;
  if (launch.kind === 'workspace' && launch.workspaceId) {
    const existing = [...windows].find((win) => {
      const pending = launches.get(win);
      return activeWorkspaces.get(win) === launch.workspaceId || (pending?.kind === 'workspace' && pending.workspaceId === launch.workspaceId);
    });
    if (existing) { focus(existing); return; }
  }
  createWindow(launch);
}

function createWindow(launch?: AppWindowLaunch): Window {
  if (!server) throw new Error('The embedded server is not ready');
  let win: Window;
  const rpc = BrowserView.defineRPC<DesktopRPC>({
    maxRequestTime: 30_000,
    handlers: {
      requests: {
        bootstrap: () => {
          // Bootstrap can be retried after a native transport reset. Reserve a
          // launch until the document acknowledges it, so a retry cannot lose it.
          if (!bootstrapLaunches.has(win) && canHandleCommandLineLaunch(launches.get(win))) {
            const launch = pendingLaunches.shift();
            if (launch) bootstrapLaunches.set(win, launch);
          }
          const commandLineLaunch = bootstrapLaunches.get(win);
          return { platform: process.platform, authToken: server!.token, state: state.snapshot(), launch: launches.get(win), commandLineLaunch };
        },
        getAppInfo: () => ({ name: 'Muxus', version }),
        checkForUpdate: (options) => {
          if (options?.force === true) updateCheck = checkForUpdate(true);
          return updateCheck ??= checkForUpdate();
        },
        selectPrivateKey: async () => (await Utils.openFileDialog({ startingFolder: path.join(homedir(), '.ssh'), canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false }))[0] || undefined,
        readMobaXtermSessions: () => readLocalMobaXtermSessions(),
        listLocalFontFamilies: () => listLocalFontFamilies(),
        clipboardRead: () => Utils.clipboardReadText(),
        clipboardWrite: (text) => {
          if (typeof text !== 'string') return false;
          Utils.clipboardWriteText(text);
          return true;
        },
        detachTab: (value) => {
          const parsed = parseWindowLaunch(value);
          if (parsed?.kind !== 'tab-transfer' || closing) return false;
          const bounds = [...windows].filter((other) => other.isVisible() && !other.isMinimized()).map((other) => other.getFrame());
          if (pointInsideAnyWindow(Screen.getCursorScreenPoint(), bounds)) return false;
          createWindow(parsed);
          return true;
        },
      },
      messages: {
        ready: () => {
          bootstrapLaunches.delete(win);
          readyWindows.add(win);
          deliverLaunches();
        },
        stateChanged: ({ name, value }) => {
          if (typeof name !== 'string' || (value !== null && typeof value !== 'string')) return;
          state.change(name, value);
          for (const other of windows) if (other !== win) other.webview.rpc?.send.stateChanged({ name, value });
        },
        openWindow,
        activeWorkspace: ({ workspaceId, workspaceTitle, clearReloadLaunch }) => {
          const update = workspaceOwnershipUpdate(launches.get(win), workspaceId, workspaceTitle, clearReloadLaunch);
          if (!update.accepted) return;
          if (update.reloadLaunch) launches.set(win, update.reloadLaunch); else launches.delete(win);
          if (update.activeWorkspaceId) activeWorkspaces.set(win, update.activeWorkspaceId); else activeWorkspaces.delete(win);
        },
        windowAction: (action) => performAction(action, win),
        closeWindow: () => win.requestClose(),
        minimizeWindow: () => win.minimize(),
        toggleMaximize: () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); },
        focusWindow: () => focus(win),
        setZoomFactor: (value) => { if (typeof value === 'number' && Number.isFinite(value)) win.setPageZoom(Math.min(2, Math.max(0.5, value))); },
        setTitlebarHeight: (height) => {
          if (isMac && typeof height === 'number' && Number.isFinite(height) && height >= 14 && height <= 200) win.setWindowButtonPosition(16, (height - 14) / 2);
        },
        openExternal,
      },
    },
  });
  const frame = loadFrame();
  if (launch?.kind === 'sftp') { frame.width = Math.max(960, Math.min(frame.width, 1280)); frame.height = Math.max(640, Math.min(frame.height, 900)); }
  win = new BrowserWindow({
    title: launch ? `${launch.title} — Muxus` : 'Muxus',
    url: new URL(server.url).origin,
    // Only the trusted application document receives the privileged bridge.
    preload: `if (location.origin === ${JSON.stringify(new URL(server.url).origin)}) { ${preload} }`,
    rpc, renderer: 'native',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden', frame,
    navigationRules: JSON.stringify(['^*', `${new URL(server.url).origin}/*`]),
  });
  if (isMac) win.setWindowButtonPosition(16, 19);
  windows.add(win);
  if (launch) launches.set(win, launch);
  focused = win;
  primary ??= win;
  let normalFrame = win.getFrame();
  if (frame.maximized && win === primary) win.maximize();
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const saveFrame = () => {
    clearTimeout(frameTimer);
    if (win !== primary) return;
    const maximized = win.isMaximized();
    if (!maximized && !win.isFullScreen()) normalFrame = win.getFrame();
    try { writeFileSync(windowStateFile, JSON.stringify({ ...normalFrame, maximized }), { mode: 0o600 }); }
    catch (error) { mainLog('warn', 'could not save window bounds', error); }
  };
  const scheduleFrameSave = () => { clearTimeout(frameTimer); frameTimer = setTimeout(saveFrame, 200); };
  win.on('resize', scheduleFrameSave);
  win.on('move', scheduleFrameSave);
  win.on('will-close', saveFrame);
  win.on('focus', () => { focused = win; });
  win.on('close', () => {
    clearTimeout(frameTimer);
    const pending = bootstrapLaunches.get(win);
    if (pending) pendingLaunches.unshift(pending);
    bootstrapLaunches.delete(win);
    windows.delete(win); launches.delete(win); activeWorkspaces.delete(win); readyWindows.delete(win);
    if (primary === win) primary = windows.values().next().value;
    if (focused === win) focused = primary;
    if (!windows.size) void shutdown();
  });
  win.webview.on('will-navigate', () => readyWindows.delete(win));
  return win;
}

function openExternal(value: unknown): void {
  if (typeof value !== 'string') return;
  try { if (['https:', 'http:', 'mailto:'].includes(new URL(value).protocol)) Utils.openExternal(value); }
  catch { /* Invalid external link. */ }
}

function performAction(action: string, win?: Window): void {
  switch (action) {
    case 'quit': void shutdown(); break;
    case 'close-tab': win?.webview.rpc?.send.closeTab(); break;
    case 'close-window': win?.requestClose(); break;
    case 'previous-tab': win?.webview.rpc?.send.cycleTab(true); break;
    case 'next-tab': win?.webview.rpc?.send.cycleTab(false); break;
    case 'reload': win?.webview.executeJavascript('location.reload()'); break;
    case 'devtools': win?.webview.openDevTools(); break;
    case 'fullscreen': if (win) win.setFullScreen(!win.isFullScreen()); break;
  }
}

function buildMenu(): void {
  ApplicationMenu.setApplicationMenu([
    ...(isMac ? [{ label: 'Muxus', submenu: [{ label: 'About Muxus', role: 'about' }, { type: 'separator' as const }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'showAll' }, { type: 'separator' as const }, { label: 'Quit Muxus', action: 'quit', accelerator: 'Command+q' }] }] : []),
    { label: 'File', submenu: [{ label: 'Close Tab', action: 'close-tab', ...(isMac ? { accelerator: 'Command+w' } : {}) }, { label: 'Close Window', action: 'close-window' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Reload', action: 'reload' }, { label: 'Developer Tools', action: 'devtools' }, { label: 'Full Screen', action: 'fullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Previous Tab', action: 'previous-tab' }, { label: 'Next Tab', action: 'next-tab' }] },
  ]);
  Electrobun.events.on('application-menu-clicked', (event) => performAction(event.data.action, focused ?? primary));
}

function shutdown(): Promise<void> {
  return closing ??= (async () => {
    state?.flush(false);
    const timer = setTimeout(() => {
      state?.flush(false);
      mainLog('warn', 'server shutdown timed out after 5000ms; forcing application exit');
      quitReady = true;
      Utils.quit();
    }, 5000);
    try { await server?.close(); instanceChannel.postMessage({ type: 'shutdown' }); }
    catch (error) { mainLog('error', 'embedded server shutdown failed', error); }
    finally { clearTimeout(timer); state?.flush(false); quitReady = true; Utils.quit(); }
  })();
}

Electrobun.events.on('before-quit', (event) => {
  if (quitReady) return;
  event.response = { allow: false };
  void shutdown();
});
Electrobun.events.on('reopen', () => activate());
Electrobun.events.on('new-window-open', (event) => {
  const detail = event.data.detail;
  openExternal(typeof detail === 'string' ? detail : detail.url);
});
const instanceChannel = new BroadcastChannel('muxus-instance');
instanceChannel.onmessage = (event: MessageEvent<{ type: string; link?: string }>) => {
  if (event.data.type === 'activate') activate(event.data.link);
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

async function start(): Promise<void> {
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  if (process.env.MUXUS_DESKTOP_DATA) writeFileSync(path.join(userData, 'runtime.pid'), String(process.pid), { mode: 0o600 });
  initMainLog(userData);
  installCrashCapture();
  mainLog('info', `Muxus ${version} starting on ${process.platform}/${process.arch} (Electrobun, Bun ${process.versions.bun})`);
  await importLoginShellEnvironment(undefined, undefined, undefined, (error) => mainLog('warn', 'could not import the login shell environment', error));
  if (isDevelopmentBuild() && !process.env.MUXUS_DESKTOP_DATA) {
    const seed = await seedDevelopmentDatabase(installedUserDataPath(), userData, new SystemVaultKeyStore());
    mainLog('info', `development database: ${seed.databaseCopied ? 'refreshed' : 'retained'}; vault key: ${seed.automaticVaultKey}`);
  }
  state = new ClientState(path.join(userData, 'client-state.json'), (error) => {
    mainLog('error', 'could not persist client state; retrying', error);
    for (const win of windows) win.webview.rpc?.send.stateWriteFailed();
  });
  process.env.MUXUS_VERSION = version;
  preload = readFileSync(path.join(resources, 'preload.js'), 'utf8');
  server = await startServer({ port: 0, openBrowser: false, prettyLogs: false,
    databasePath: path.join(userData, 'muxus.sqlite3'),
    historyPath: isDevelopmentBuild() || process.env.MUXUS_DESKTOP_DATA ? path.join(userData, 'history') : undefined,
    staticRoot: path.join(resources, 'client'),
  });
  mainLog('info', `server listening at ${new URL(server.url).origin}`);
  const initial = initialCommandLineLaunch();
  if (initial) pendingLaunches.push(initial);
  buildMenu();
  createWindow();
  instanceChannel.postMessage({ type: 'ready' });
}

void start().catch(async (error: unknown) => {
  mainLog('error', 'desktop startup failed', error);
  await Utils.showMessageBox({ type: 'error', title: 'Muxus failed to start', message: String(error), detail: `Details: ${mainLogPath() ?? 'unavailable'}` });
  await shutdown();
});
