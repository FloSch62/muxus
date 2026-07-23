import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import fixPath from 'fix-path';
import { startServer, type RunningServer } from '@muxus/server';

// GUI apps on macOS/Linux don't inherit the shell PATH; ssh-agent sockets
// and the user's login shell tooling need it.
fixPath();

// Without this the Linux WM_CLASS becomes the package.json name
// ("@muxus/electron") and never matches the .desktop StartupWMClass,
// leaving the window without taskbar/dock icon.
app.setName('Muxus');

// Not named __dirname: the esbuild banner defines that identifier for the
// bundled CJS deps, and banner names can't be renamed around.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// Must match the client TopBar height: its toolbar doubles as the titlebar.
const TITLEBAR_HEIGHT = 52;

let mainWindow: BrowserWindow | undefined;
let server: RunningServer | undefined;
let closing: Promise<void> | undefined;

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

interface AppInfo {
  name: string;
  version: string;
}

const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const clientStateFile = () => path.join(app.getPath('userData'), 'client-state.json');

function isMainWindowSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!mainWindow && event.sender === mainWindow.webContents;
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1440, height: 900 };
  try {
    const state = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as WindowState;
    if (typeof state.width !== 'number' || typeof state.height !== 'number') return fallback;
    return state;
  } catch {
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getNormalBounds();
  const state: WindowState = { ...bounds, maximized: win.isMaximized() };
  try {
    writeFileSync(windowStateFile(), JSON.stringify(state));
  } catch {
    /* state is a nicety; never block shutdown on it */
  }
}

let clientStateCache: Record<string, string> | undefined;

function loadClientState(): Record<string, string> {
  if (!clientStateCache) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(clientStateFile(), 'utf8'));
      clientStateCache =
        !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          ? {}
          : Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      clientStateCache = {};
    }
  }
  return clientStateCache;
}

function saveClientState(state: Record<string, string>): void {
  const file = clientStateFile();
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  clientStateCache = state;
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function windowIcon(): string | undefined {
  if (process.platform !== 'linux') return undefined; // win: exe icon, mac: bundle icon
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.resolve(moduleDir, '../build/icons/256x256.png');
}

function overlayColors(): { color: string; symbolColor: string } {
  // Match the client's default theme (prefers-color-scheme) until the app
  // reports its actual theme over the bridge; values = titleBarColors() in
  // client/src/theme.ts (the TopBar's AppBar background).
  // On Linux the overlay background is fully transparent: the web AppBar (and
  // any modal backdrop) shows through, so that region dims in the same
  // compositor frame as the rest of the page — only the glyphs are native.
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: isLinux ? '#00000000' : dark ? '#151518' : '#f4f4f5',
    symbolColor: dark ? '#e6e6ea' : '#1c1c21',
  };
}

function openAllowedExternalUrl(rawUrl: string): void {
  try {
    const parsed = new URL(rawUrl);
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return;
    void shell.openExternal(parsed.toString()).catch(() => undefined);
  } catch {
    /* malformed or relative URLs are never handed to the OS */
  }
}

function createWindow(url: string): void {
  const state = loadWindowState();
  const appOrigin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 500,
    title: 'Muxus',
    show: false,
    icon: windowIcon(),
    // Frameless look on every platform: the client's TopBar is the titlebar
    // (drag region + env(titlebar-area-*) paddings live in the client CSS).
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    titleBarOverlay: isMac ? true : { ...overlayColors(), height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(moduleDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  if (state.maximized) mainWindow.maximize();
  // The menu stays installed so its accelerators (zoom, reload, devtools,
  // fullscreen) keep working, but the bar itself is macOS-only chrome.
  if (!isMac) mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', () => {
    if (mainWindow) saveWindowState(mainWindow);
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: external }) => {
    openAllowedExternalUrl(external);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    try {
      if (new URL(destination).origin === appOrigin) return;
    } catch {
      /* malformed destinations are blocked below */
    }
    event.preventDefault();
    openAllowedExternalUrl(destination);
  });
  mainWindow.webContents.on('will-redirect', (event, destination) => {
    try {
      if (new URL(destination).origin === appOrigin) return;
    } catch {
      /* malformed destinations are blocked below */
    }
    event.preventDefault();
    openAllowedExternalUrl(destination);
  });
  // Cmd/Ctrl+W is the OS "close window" accelerator. Hand it to the renderer
  // so it can close the focused terminal tab first, and only close the whole
  // window when no tab is open. Ctrl+Tab & friends cycle tabs.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'w' && !input.alt && !input.shift && (isMac ? input.meta && !input.control : input.control && !input.meta)) {
      event.preventDefault();
      mainWindow?.webContents.send('muxus:close-tab');
      return;
    }
    if (input.control && !input.meta && !input.alt && key === 'tab') {
      event.preventDefault();
      mainWindow?.webContents.send('muxus:cycle-tab', input.shift);
      return;
    }
    if (isMac && input.meta && input.shift && !input.control && !input.alt && (input.code === 'BracketLeft' || input.code === 'BracketRight')) {
      event.preventDefault();
      mainWindow?.webContents.send('muxus:cycle-tab', input.code === 'BracketLeft');
    }
  });
  void mainWindow.loadURL(url);
}

ipcMain.on('muxus:close-window', (event) => {
  if (!isMainWindowSender(event)) return;
  mainWindow?.close();
});

ipcMain.on('muxus:set-titlebar-overlay', (event, options: unknown) => {
  if (isMac || !isMainWindowSender(event)) return;
  const win = mainWindow;
  if (!win) return;
  const { color, symbolColor } = (options ?? {}) as { color?: unknown; symbolColor?: unknown };
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return;
  try {
    win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  } catch {
    /* overlay not supported in this environment */
  }
});

// One sync call, at preload time only: the boot snapshot the bridge serves
// getItem from. A sync handler must set returnValue on every path — a missed
// reply parks the renderer main thread forever.
ipcMain.on('muxus:state:get-all', (event) => {
  try {
    event.returnValue = isMainWindowSender(event) ? { ...loadClientState() } : {};
  } catch {
    event.returnValue = {};
  }
});

ipcMain.on('muxus:auth-token', (event) => {
  event.returnValue = isMainWindowSender(event) ? (server?.token ?? '') : '';
});

// Steady-state writes are fire-and-forget so the renderer never blocks on
// persistence; bursts (fast clicking flips several stores at once) coalesce
// into one disk write.
const STATE_FLUSH_MS = 150;
const STATE_RETRY_MS = 5_000;
let stateFlushTimer: NodeJS.Timeout | undefined;
let pendingClientState: Record<string, string> | undefined;

function scheduleClientStateFlush(state: Record<string, string>, delay = STATE_FLUSH_MS): void {
  pendingClientState = state;
  clientStateCache = state;
  stateFlushTimer ??= setTimeout(() => {
    stateFlushTimer = undefined;
    flushClientState();
  }, delay);
}

function flushClientState(): void {
  if (stateFlushTimer !== undefined) {
    clearTimeout(stateFlushTimer);
    stateFlushTimer = undefined;
  }
  const state = pendingClientState;
  if (!state) return;
  try {
    saveClientState(state);
    pendingClientState = undefined;
  } catch {
    // Disk write failed (full disk, permissions …): keep the state pending
    // and retry with backoff, and tell the renderer so it can mirror the
    // snapshot into browser storage as a fallback.
    mainWindow?.webContents.send('muxus:state:write-failed');
    scheduleClientStateFlush(state, STATE_RETRY_MS);
  }
}

ipcMain.on('muxus:state:set-item', (event, name: unknown, value: unknown) => {
  if (!isMainWindowSender(event) || typeof name !== 'string' || typeof value !== 'string') return;
  scheduleClientStateFlush({ ...loadClientState(), [name]: value });
});

ipcMain.on('muxus:state:remove-item', (event, name: unknown) => {
  if (!isMainWindowSender(event) || typeof name !== 'string') return;
  const next = { ...loadClientState() };
  delete next[name];
  scheduleClientStateFlush(next);
});

ipcMain.handle('muxus:get-app-info', (event): AppInfo | undefined => {
  if (!isMainWindowSender(event)) return undefined;
  return { name: app.getName(), version: app.getVersion() };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    process.env.MUXUS_VERSION = app.getVersion();
    try {
      server = await startServer({
        port: 0,
        openBrowser: false,
        prettyLogs: false,
        databasePath: path.join(app.getPath('userData'), 'muxus.sqlite3'),
        staticRoot: app.isPackaged
          ? path.join(process.resourcesPath, 'client')
          : path.resolve(moduleDir, '../../client/dist'),
      });
    } catch (err) {
      console.error('failed to start muxus server', err);
      app.quit();
      return;
    }
    buildMenu();
    createWindow(server.url);
  });

  // The server (and its SSH connections) is tied to the window, so quit
  // everywhere — including macOS — instead of lingering headless.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    flushClientState();
    if (!server) return;
    if (!closing) {
      const done = server.close().catch(() => undefined);
      closing = done;
      void done.then(() => {
        server = undefined;
        app.quit();
      });
    }
    event.preventDefault();
  });
}
