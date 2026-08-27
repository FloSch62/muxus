import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  clipboard,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import {
  startServer,
  SystemVaultKeyStore,
  type RunningServer,
} from '@muxus/server';
import { isNewerVersion } from '@muxus/shared';
import type {
  AppWindowLaunch,
  MobaXtermSessionSource,
  UpdateCheckResult,
} from '@muxus/shared';
import {
  developmentUserDataPath,
  seedDevelopmentDatabase,
} from './development-database.js';
import { importLoginShellEnvironment } from './login-shell-environment.js';
import { initMainLog, installCrashCapture, mainLog, mainLogPath } from './main-log.js';
import { readLocalMobaXtermSessions } from './mobaxterm.js';
import { workspaceOwnershipUpdate } from './workspace-window-state.js';
import { pointInsideAnyWindow } from './tab-detach.js';

// Name first: userData (and with it the log location) derives from it.
app.setName('Muxus');
const installedUserDataPath = app.getPath('userData');
const isDevelopment = !app.isPackaged;
if (isDevelopment) {
  const userDataPath = developmentUserDataPath(installedUserDataPath);
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  app.setPath('userData', userDataPath);
}
initMainLog(app.getPath('userData'));
installCrashCapture();
mainLog(
  'info',
  `Muxus ${app.getVersion()} starting on ${process.platform}/${process.arch} (Electron ${process.versions.electron})`,
);
importLoginShellEnvironment(undefined, undefined, undefined, (err) =>
  mainLog('warn', 'could not import the login shell environment', err),
);

// Keep the native Wayland app_id (and the X11 fallback's WM_CLASS) aligned
// with the installed desktop file. Electron selects Wayland automatically
// when the session supports it; no display-backend flag is needed.
if (process.platform === 'linux') app.setDesktopName('muxus.desktop');

// Not named __dirname: the esbuild banner defines that identifier for the
// bundled CJS deps, and banner names can't be renamed around.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// Must match the client TopBar height: its toolbar doubles as the titlebar.
const TITLEBAR_HEIGHT = 52;
const UPDATE_MANIFEST_URL = 'https://flosch62.github.io/muxus/latest.json';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const CLIPBOARD_IMAGE_MAX_BYTES = 18 * 1024 * 1024;
const CLIPBOARD_IMAGE_MAX_PIXELS = 32 * 1024 * 1024;

let primaryWindow: BrowserWindow | undefined;
let appUrl: string | undefined;
const managedWindows = new Set<BrowserWindow>();
const windowLaunches = new Map<number, AppWindowLaunch>();
const activeWorkspaceByWebContents = new Map<number, string>();
let server: RunningServer | undefined;
let closing: Promise<void> | undefined;
let updateCheck: Promise<UpdateCheckResult> | undefined;

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

type DesktopClipboardContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; png: Uint8Array<ArrayBuffer> }
  | { kind: 'empty' };

interface UpdateManifest {
  version?: unknown;
  releaseName?: unknown;
  releaseUrl?: unknown;
  publishedAt?: unknown;
}

const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const clientStateFile = () => path.join(app.getPath('userData'), 'client-state.json');

function senderWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return win && managedWindows.has(win) ? win : undefined;
}

function isManagedWindowSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return senderWindow(event) !== undefined;
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
    {
      // The stock view menu claims Cmd/Ctrl +/-/0 for page zoom, which would
      // scale the whole window out from under the terminal's own font zoom.
      // Window scale is a preference instead (Settings → Appearance).
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
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

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function releaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
    if (!url.pathname.startsWith('/FloSch62/muxus/releases/')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const url = new URL(UPDATE_MANIFEST_URL);
    if (force) url.searchParams.set('t', String(Date.now()));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Muxus/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (response.status === 404) return { available: false, currentVersion, reason: 'no-release' };
    if (!response.ok) return { available: false, currentVersion, reason: `manifest-${response.status}` };

    const manifest = (await response.json()) as UpdateManifest;
    const version = typeof manifest.version === 'string' ? manifest.version : undefined;
    if (!version) return { available: false, currentVersion, reason: 'missing-version' };

    const latestVersion = normalizeVersion(version);
    if (!isNewerVersion(latestVersion, currentVersion)) return { available: false, currentVersion, latestVersion };

    const downloadUrl = releaseUrl(manifest.releaseUrl);
    if (!downloadUrl) return { available: false, currentVersion, latestVersion, reason: 'missing-release-url' };

    return {
      available: true,
      currentVersion,
      latestVersion,
      releaseName: typeof manifest.releaseName === 'string' && manifest.releaseName ? manifest.releaseName : undefined,
      releaseUrl: downloadUrl,
      publishedAt: typeof manifest.publishedAt === 'string' ? manifest.publishedAt : undefined,
    };
  } catch (err) {
    return {
      available: false,
      currentVersion,
      reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function createWindow(url: string, launch?: AppWindowLaunch): BrowserWindow {
  const state = loadWindowState();
  const appOrigin = new URL(url).origin;
  const isPrimary = !primaryWindow;
  const win = new BrowserWindow({
    width: launch?.kind === 'sftp' ? Math.max(960, Math.min(state.width, 1280)) : state.width,
    height: launch?.kind === 'sftp' ? Math.max(640, Math.min(state.height, 900)) : state.height,
    x: state.x === undefined || isPrimary ? state.x : state.x + 28,
    y: state.y === undefined || isPrimary ? state.y : state.y + 28,
    minWidth: 800,
    minHeight: 500,
    title: launch ? `${launch.title} — Muxus` : 'Muxus',
    // Restored terminals can keep `ready-to-show` from firing on some Windows
    // GPU paths. Show immediately with the titlebar's background color so the
    // native window can participate in composition while the UI initializes.
    show: true,
    backgroundColor: overlayColors().color,
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
  managedWindows.add(win);
  const webContentsId = win.webContents.id;
  if (launch) windowLaunches.set(webContentsId, launch);
  if (isPrimary) primaryWindow = win;
  if (state.maximized && isPrimary) win.maximize();
  // The menu stays installed so its accelerators (zoom, reload, devtools,
  // fullscreen) keep working, but the bar itself is macOS-only chrome.
  if (!isMac) win.setMenuBarVisibility(false);
  win.on('close', () => {
    if (win === primaryWindow) saveWindowState(win);
  });
  win.on('closed', () => {
    managedWindows.delete(win);
    windowLaunches.delete(webContentsId);
    activeWorkspaceByWebContents.delete(webContentsId);
    if (primaryWindow === win) primaryWindow = undefined;
  });
  // A dead renderer looks like "the app won't start" — leave its exit trace.
  win.webContents.on('render-process-gone', (_event, details) => {
    mainLog('error', `window renderer gone (${details.reason}, exit code ${details.exitCode})`);
  });
  win.webContents.setWindowOpenHandler(({ url: external }) => {
    openAllowedExternalUrl(external);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, destination) => {
    try {
      if (new URL(destination).origin === appOrigin) return;
    } catch {
      /* malformed destinations are blocked below */
    }
    event.preventDefault();
    openAllowedExternalUrl(destination);
  });
  win.webContents.on('will-redirect', (event, destination) => {
    try {
      if (new URL(destination).origin === appOrigin) return;
    } catch {
      /* malformed destinations are blocked below */
    }
    event.preventDefault();
    openAllowedExternalUrl(destination);
  });
  // Cmd+W is the macOS "close window" accelerator: hand it to the renderer so
  // it closes the focused terminal tab first, and only closes the whole window
  // when no tab is open. Ctrl+W is left alone everywhere else — the shell uses
  // it to delete a word, and Ctrl+Shift+W closes the tab instead. Ctrl+Tab &
  // friends cycle tabs.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (isMac && key === 'w' && !input.alt && !input.shift && input.meta && !input.control) {
      event.preventDefault();
      win.webContents.send('muxus:close-tab');
      return;
    }
    if (input.control && !input.meta && !input.alt && key === 'tab') {
      event.preventDefault();
      win.webContents.send('muxus:cycle-tab', input.shift);
      return;
    }
    if (isMac && input.meta && input.shift && !input.control && !input.alt && (input.code === 'BracketLeft' || input.code === 'BracketRight')) {
      event.preventDefault();
      win.webContents.send('muxus:cycle-tab', input.code === 'BracketLeft');
    }
  });
  void win.loadURL(url);
  return win;
}

ipcMain.on('muxus:close-window', (event) => {
  senderWindow(event)?.close();
});

interface TitleBarOverlayOptions {
  color: string;
  symbolColor: string;
  height: number;
}

const overlayOptionsByWindow = new WeakMap<BrowserWindow, TitleBarOverlayOptions>();

/** Repaint the native overlay, sized to the window's current scale. */
function applyTitleBarOverlay(win: BrowserWindow, options: TitleBarOverlayOptions): void {
  if (isMac) return;
  overlayOptionsByWindow.set(win, options);
  try {
    win.setTitleBarOverlay({
      color: options.color,
      symbolColor: options.symbolColor,
      height: Math.round(options.height * win.webContents.getZoomFactor()),
    });
  } catch {
    /* overlay not supported in this environment */
  }
}

ipcMain.on('muxus:set-titlebar-overlay', (event, options: unknown) => {
  if (isMac) return;
  const win = senderWindow(event);
  if (!win) return;
  const { color, symbolColor, height } = (options ?? {}) as {
    color?: unknown;
    symbolColor?: unknown;
    height?: unknown;
  };
  if (
    typeof color !== 'string' ||
    typeof symbolColor !== 'string' ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height < 24 ||
    height > 200
  ) {
    return;
  }
  applyTitleBarOverlay(win, { color, symbolColor, height });
});

// Interface scale, driven by the preference rather than a zoom accelerator.
ipcMain.on('muxus:set-zoom-factor', (event, value: unknown) => {
  const win = senderWindow(event);
  if (!win || typeof value !== 'number' || !Number.isFinite(value)) return;
  win.webContents.setZoomFactor(Math.min(2, Math.max(0.5, value)));
  const options = overlayOptionsByWindow.get(win);
  if (options) applyTitleBarOverlay(win, options);
});

// One sync call, at preload time only: the boot snapshot the bridge serves
// getItem from. A sync handler must set returnValue on every path — a missed
// reply parks the renderer main thread forever.
ipcMain.on('muxus:state:get-all', (event) => {
  try {
    event.returnValue = isManagedWindowSender(event) ? { ...loadClientState() } : {};
  } catch {
    event.returnValue = {};
  }
});

ipcMain.on('muxus:auth-token', (event) => {
  event.returnValue = isManagedWindowSender(event) ? (server?.token ?? '') : '';
});

ipcMain.on('muxus:window-launch', (event) => {
  event.returnValue = isManagedWindowSender(event)
    ? windowLaunches.get(event.sender.id)
    : undefined;
});

ipcMain.on('muxus:open-window', (event, value: unknown) => {
  if (!isManagedWindowSender(event) || !appUrl) return;
  const launch = parseWindowLaunch(value);
  if (!launch) return;
  if (launch.kind === 'workspace' && launch.workspaceId) {
    const existing = [...managedWindows].find((candidate) => {
      const webContentsId = candidate.webContents.id;
      if (activeWorkspaceByWebContents.get(webContentsId) === launch.workspaceId) return true;
      const pending = windowLaunches.get(webContentsId);
      return pending?.kind === 'workspace' && pending.workspaceId === launch.workspaceId;
    });
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
  }
  createWindow(appUrl, launch);
});

ipcMain.handle('muxus:detach-tab', (event, value: unknown): boolean => {
  if (!isManagedWindowSender(event) || !appUrl) return false;
  const launch = parseWindowLaunch(value);
  if (launch?.kind !== 'tab-transfer') return false;
  const cursor = screen.getCursorScreenPoint();
  const bounds = [...managedWindows]
    .filter(
      (candidate) =>
        !candidate.isDestroyed() && candidate.isVisible() && !candidate.isMinimized(),
    )
    .map((candidate) => candidate.getBounds());
  if (pointInsideAnyWindow(cursor, bounds)) return false;
  createWindow(appUrl, launch);
  return true;
});

ipcMain.on(
  'muxus:active-workspace',
  (event, value: unknown, title: unknown, clearLaunch: unknown) => {
    if (!isManagedWindowSender(event)) return;
    const update = workspaceOwnershipUpdate(
      windowLaunches.get(event.sender.id),
      value,
      title,
      clearLaunch,
    );
    if (!update.accepted) return;

    if (update.reloadLaunch) windowLaunches.set(event.sender.id, update.reloadLaunch);
    else windowLaunches.delete(event.sender.id);
    if (!update.activeWorkspaceId) {
      activeWorkspaceByWebContents.delete(event.sender.id);
      return;
    }
    activeWorkspaceByWebContents.set(event.sender.id, update.activeWorkspaceId);
  },
);

ipcMain.on('muxus:focus-window', (event) => {
  const win = senderWindow(event);
  if (!win || !managedWindows.has(win)) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
    for (const win of managedWindows) {
      win.webContents.send('muxus:state:write-failed');
    }
    scheduleClientStateFlush(state, STATE_RETRY_MS);
  }
}

ipcMain.on('muxus:state:set-item', (event, name: unknown, value: unknown) => {
  if (!isManagedWindowSender(event) || typeof name !== 'string' || typeof value !== 'string') return;
  scheduleClientStateFlush({ ...loadClientState(), [name]: value });
});

ipcMain.on('muxus:state:remove-item', (event, name: unknown) => {
  if (!isManagedWindowSender(event) || typeof name !== 'string') return;
  const next = { ...loadClientState() };
  delete next[name];
  scheduleClientStateFlush(next);
});

ipcMain.handle('muxus:get-app-info', (event): AppInfo | undefined => {
  if (!isManagedWindowSender(event)) return undefined;
  return { name: app.getName(), version: app.getVersion() };
});

ipcMain.handle('muxus:check-for-update', async (event, options?: { force?: unknown }): Promise<UpdateCheckResult> => {
  if (!isManagedWindowSender(event)) {
    return { available: false, currentVersion: app.getVersion(), reason: 'invalid-sender' };
  }
  if (options?.force === true) updateCheck = checkForUpdate(true);
  updateCheck ??= checkForUpdate();
  return updateCheck;
});

ipcMain.handle(
  'muxus:read-clipboard-content',
  (event): DesktopClipboardContent | undefined => {
    if (!isManagedWindowSender(event)) return undefined;
    const text = clipboard.readText();
    if (text) return { kind: 'text', text };

    const image = clipboard.readImage();
    if (image.isEmpty()) return { kind: 'empty' };
    const { width, height } = image.getSize();
    const pixels = width * height;
    if (
      width <= 0 ||
      height <= 0 ||
      !Number.isFinite(pixels) ||
      pixels > CLIPBOARD_IMAGE_MAX_PIXELS
    ) {
      throw new Error('The clipboard image is too large to paste.');
    }

    const png = image.toPNG();
    if (png.byteLength > CLIPBOARD_IMAGE_MAX_BYTES) {
      throw new Error('The clipboard image is too large to paste.');
    }
    return { kind: 'image', png: Uint8Array.from(png) };
  },
);

ipcMain.handle('muxus:select-private-key', async (event): Promise<string | undefined> => {
  const win = senderWindow(event);
  if (!win) return undefined;
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose SSH private key',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    buttonLabel: 'Use key',
    properties: ['openFile', 'showHiddenFiles'],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle(
  'muxus:read-mobaxterm-sessions',
  async (event): Promise<MobaXtermSessionSource | undefined> => {
    if (!isManagedWindowSender(event)) return undefined;
    return readLocalMobaXtermSessions();
  },
);

function parseWindowLaunch(value: unknown): AppWindowLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const launch = value as Record<string, unknown>;
  if (launch.kind === 'workspace') {
    if (
      typeof launch.title !== 'string' ||
      launch.title.length === 0 ||
      launch.title.length > 200 ||
      (launch.workspaceId !== undefined &&
        (typeof launch.workspaceId !== 'string' ||
          launch.workspaceId.length === 0 ||
          launch.workspaceId.length > 200))
    ) {
      return undefined;
    }
    return value as AppWindowLaunch;
  }
  if (launch.kind === 'session') {
    if (
      typeof launch.title !== 'string' ||
      launch.title.length > 500 ||
      !launch.profile ||
      typeof launch.profile !== 'object'
    ) {
      return undefined;
    }
    const profile = launch.profile as Record<string, unknown>;
    const valid =
      (profile.kind === 'local' &&
        (profile.shell === undefined || typeof profile.shell === 'string') &&
        (profile.cwd === undefined || typeof profile.cwd === 'string')) ||
      (profile.kind === 'ssh' &&
        typeof profile.target === 'string' &&
        profile.target.length > 0 &&
        profile.target.length <= 500) ||
      (profile.kind === 'telnet' &&
        validProfileId(profile.profileId) &&
        typeof profile.host === 'string' &&
        profile.host.length > 0 &&
        profile.host.length <= 253 &&
        (profile.port === undefined ||
          (typeof profile.port === 'number' &&
            Number.isInteger(profile.port) &&
            profile.port >= 1 &&
            profile.port <= 65_535))) ||
      (profile.kind === 'serial' &&
        validProfileId(profile.profileId) &&
        typeof profile.path === 'string' &&
        profile.path.length > 0 &&
        profile.path.length <= 4096 &&
        (profile.baudRate === undefined ||
          (typeof profile.baudRate === 'number' &&
            Number.isInteger(profile.baudRate) &&
            profile.baudRate >= 1 &&
            profile.baudRate <= 12_000_000)) &&
        (profile.dataBits === undefined || [5, 6, 7, 8].includes(profile.dataBits as number)) &&
        (profile.stopBits === undefined || [1, 1.5, 2].includes(profile.stopBits as number)) &&
        (profile.parity === undefined ||
          ['none', 'even', 'odd', 'mark', 'space'].includes(profile.parity as string)) &&
        (profile.flowControl === undefined ||
          ['none', 'hardware', 'software'].includes(profile.flowControl as string)));
    if (!valid) return undefined;
    return value as AppWindowLaunch;
  }
  if (launch.kind === 'tab-transfer') {
    if (
      typeof launch.transferId !== 'string' ||
      launch.transferId.length === 0 ||
      launch.transferId.length > 200 ||
      typeof launch.title !== 'string' ||
      launch.title.length > 500
    ) {
      return undefined;
    }
    return value as AppWindowLaunch;
  }
  if (
    launch.kind !== 'sftp' ||
    typeof launch.connId !== 'string' ||
    launch.connId.length === 0 ||
    launch.connId.length > 200 ||
    typeof launch.title !== 'string' ||
    launch.title.length > 500 ||
    (launch.path !== undefined && (typeof launch.path !== 'string' || launch.path.length > 4096))
  ) {
    return undefined;
  }
  return value as AppWindowLaunch;
}

function validProfileId(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length >= 1 && value.length <= 200)
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = primaryWindow ?? [...managedWindows][0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    process.env.MUXUS_VERSION = app.getVersion();
    try {
      if (isDevelopment) {
        const seed = await seedDevelopmentDatabase(
          installedUserDataPath,
          app.getPath('userData'),
          new SystemVaultKeyStore(),
        );
        mainLog(
          'info',
          seed.databaseCopied
            ? 'refreshed the development database from the installed app'
            : 'installed app database not found; using the development database',
        );
        if (seed.automaticVaultKey === 'missing' || seed.automaticVaultKey === 'unavailable') {
          mainLog(
            'warn',
            'automatic password-vault access could not be copied; the development vault may require repair with its master password',
          );
        }
      }
      const userDataPath = app.getPath('userData');
      server = await startServer({
        port: 0,
        openBrowser: false,
        prettyLogs: false,
        databasePath: path.join(userDataPath, 'muxus.sqlite3'),
        historyPath: isDevelopment ? path.join(userDataPath, 'history') : undefined,
        staticRoot: app.isPackaged
          ? path.join(process.resourcesPath, 'client')
          : path.resolve(moduleDir, '../../client/dist'),
      });
    } catch (err) {
      mainLog('error', 'the embedded server failed to start', err);
      const logPath = mainLogPath();
      dialog.showErrorBox(
        'Muxus failed to start',
        `${err instanceof Error ? err.message : String(err)}${
          logPath ? `\n\nDetails were written to:\n${logPath}` : ''
        }`,
      );
      app.quit();
      return;
    }
    mainLog('info', `server listening at ${server.url}`);
    buildMenu();
    const url = server.url;
    appUrl = url;
    createWindow(url);
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
