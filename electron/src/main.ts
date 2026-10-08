import { randomUUID } from 'node:crypto';
import { constants as fsConstants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { access, readFile, rm, stat } from 'node:fs/promises';
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
  nativeImage,
  nativeTheme,
  screen,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import electronUpdater from 'electron-updater';
import {
  startServer,
  SystemVaultKeyStore,
  type RunningServer,
} from '@muxus/server';
import { isNewerVersion } from '@muxus/shared';
import type {
  AppWindowLaunch,
  CommandLineLaunch,
  DesktopUpdateState,
  LocalOpenApplication,
  LocalOpenResult,
  LocalOpenTarget,
  LocalProgramChoice,
  MobaXtermSessionSource,
  UpdateCheckResult,
} from '@muxus/shared';
import {
  canHandleCommandLineLaunch,
  parseCommandLineLaunch,
  parseCommandLineLaunchData,
} from './command-line.js';
import {
  developmentUserDataPath,
  seedDevelopmentDatabase,
} from './development-database.js';
import {
  currentDesktops,
  desktopApplicationFromText,
  detectIconTheme,
  expandExec,
  LinuxApplicationCatalog,
  type DesktopApplication,
} from './linux-applications.js';
import {
  createLocalCopy,
  launchEnvironment,
  markAsDownloaded,
  purgeStaleLocalCopies,
  runOpener,
  startDetached,
  type LocalCopy,
} from './local-open.js';
import { importLoginShellEnvironment } from './login-shell-environment.js';
import { initMainLog, installCrashCapture, mainLog, mainLogPath } from './main-log.js';
import { readLocalMobaXtermSessions } from './mobaxterm.js';
import { workspaceOwnershipUpdate } from './workspace-window-state.js';
import { pointInsideAnyWindow } from './tab-detach.js';
import { checkStoreUpdate, isStoreDistribution, storePageUrl, type DistributionMetadata } from './store-updates.js';
import { DesktopUpdater, updateDisabledReason } from './updater.js';
import { StoreUpdater } from './store-updater.js';
import { createStoreBridge } from './store-bridge.js';

// Name first: userData (and with it the log location) derives from it.
app.setName('Muxus');
const installedUserDataPath = app.getPath('userData');
const isDevelopment = !app.isPackaged;
const distributionMetadata = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as DistributionMetadata;
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
const commandLineLaunches = new Map<number, CommandLineLaunch>();
const deferredCommandLineLaunches: CommandLineLaunch[] = [];
const activeWorkspaceByWebContents = new Map<number, string>();
let server: RunningServer | undefined;
let closing: Promise<void> | undefined;
let updateCheck: Promise<UpdateCheckResult> | undefined;
let desktopUpdater: DesktopUpdater | StoreUpdater | undefined;
let quittingForUpdate = false;

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
  const storeResult = await checkStoreUpdate(distributionMetadata, process.windowsStore === true, currentVersion, force, (url) => shell.openExternal(url));
  if (storeResult) return storeResult;
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

function createWindow(
  url: string,
  launch?: AppWindowLaunch,
  commandLineLaunch?: CommandLineLaunch,
): BrowserWindow {
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
  if (commandLineLaunch) commandLineLaunches.set(webContentsId, commandLineLaunch);
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
    commandLineLaunches.delete(webContentsId);
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

ipcMain.on('muxus:command-line-launch', (event) => {
  if (!isManagedWindowSender(event)) {
    event.returnValue = undefined;
    return;
  }
  event.returnValue = commandLineLaunches.get(event.sender.id);
  commandLineLaunches.delete(event.sender.id);
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

// In-app updates (electron-updater, or Microsoft Store for Store packages).
ipcMain.handle('muxus:update:state', (event) =>
  isManagedWindowSender(event) ? desktopUpdater?.getState() : undefined,
);
ipcMain.handle('muxus:update:check', (event) =>
  isManagedWindowSender(event) ? desktopUpdater?.check() : undefined,
);
ipcMain.handle('muxus:update:open-store', async (event) => {
  if (isManagedWindowSender(event) && desktopUpdater instanceof StoreUpdater) {
    await shell.openExternal(storePageUrl(distributionMetadata));
  }
});
ipcMain.handle('muxus:update:download', (event) =>
  isManagedWindowSender(event) && desktopUpdater instanceof DesktopUpdater ? desktopUpdater.download() : undefined,
);
ipcMain.handle('muxus:update:install', (event) =>
  isManagedWindowSender(event) && desktopUpdater?.requestInstall() === true,
);
// Background checks follow the renderer's "Notify me" preference.
ipcMain.on('muxus:update:automatic-checks', (event, enabled: unknown) => {
  if (isManagedWindowSender(event) && typeof enabled === 'boolean') desktopUpdater?.setAutomaticChecks(enabled);
});

/** Width and height from a PNG's IHDR chunk, read without decoding the pixels. */
function pngDimensions(png: Uint8Array): { width: number; height: number } | undefined {
  // 8-byte signature, then the IHDR chunk: length, type, width, height.
  if (png.byteLength < 24) return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return undefined;
  if (view.getUint32(12) !== 0x49484452) return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

ipcMain.handle(
  'muxus:read-clipboard-content',
  async (event): Promise<DesktopClipboardContent | undefined> => {
    if (!isManagedWindowSender(event)) return undefined;
    const text = await clipboard.readText();
    if (text) return { kind: 'text', text };

    const item = (await clipboard.read()).find((candidate) => candidate.types.includes('image/png'));
    if (!item) return { kind: 'empty' };
    // Every type but the bookmark one resolves to a Blob.
    const blob = (await item.getType('image/png')) as Blob;
    if (blob.size > CLIPBOARD_IMAGE_MAX_BYTES) {
      throw new Error('The clipboard image is too large to paste.');
    }

    // Check the header before anything decodes it: a small PNG can still
    // declare dimensions that would need gigabytes once expanded.
    const png = new Uint8Array(await blob.arrayBuffer());
    const size = pngDimensions(png);
    if (!size) throw new Error('The clipboard image could not be read.');
    const { width, height } = size;
    const pixels = width * height;
    if (
      width <= 0 ||
      height <= 0 ||
      !Number.isFinite(pixels) ||
      pixels > CLIPBOARD_IMAGE_MAX_PIXELS ||
      png.byteLength > CLIPBOARD_IMAGE_MAX_BYTES
    ) {
      throw new Error('The clipboard image is too large to paste.');
    }
    return { kind: 'image', png };
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
  'muxus:select-log-file',
  async (event, defaultPath: unknown): Promise<string | undefined> => {
    const win = senderWindow(event);
    if (!win) return undefined;
    const suggested =
      typeof defaultPath === 'string' && path.isAbsolute(defaultPath) ? defaultPath : undefined;
    if (suggested) {
      // The dialog opens in its folder only if it exists; Muxus would create it anyway.
      try {
        mkdirSync(path.dirname(suggested), { recursive: true });
      } catch {
        // The dialog falls back to its own starting folder.
      }
    }
    const result = await dialog.showSaveDialog(win, {
      title: 'Log session to file',
      defaultPath: suggested,
      buttonLabel: 'Start logging',
      filters: [
        { name: 'Log files', extensions: ['log', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
      // An existing file is appended to, never replaced.
      properties: ['createDirectory'],
    });
    return result.canceled ? undefined : result.filePath;
  },
);

ipcMain.on('muxus:show-item-in-folder', (event, file: unknown) => {
  if (!isManagedWindowSender(event)) return;
  if (typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(file);
});

// "Open with": the renderer downloads a remote file, streams it here in
// chunks, and the copy is opened with a local program. The renderer only
// ever names a program by an ID this process handed out, so it cannot make
// Muxus run an arbitrary executable.
const LOCAL_COPY_CHUNK_MAX_BYTES = 16 * 1024 * 1024;
const MAX_REMOTE_FILE_NAME_LENGTH = 1024;
const PROGRAM_ICON_PIXELS = 48;
const MAX_SVG_ICON_BYTES = 256 * 1024;

type PickedProgram =
  | { kind: 'mac-app'; path: string }
  | { kind: 'executable'; path: string }
  | { kind: 'desktop-entry'; application: DesktopApplication };

let linuxApplications: LinuxApplicationCatalog | undefined;
const pickedPrograms = new Map<string, PickedProgram>();
const localCopies = new Map<string, LocalCopy & { owner: number }>();
const localCopyOwners = new Set<number>();
const programIcons = new Map<string, Promise<string | undefined>>();

function linuxApplicationCatalog(): LinuxApplicationCatalog {
  const home = app.getPath('home');
  linuxApplications ??= new LinuxApplicationCatalog(process.env, home, {
    iconTheme: () => detectIconTheme(process.env, home),
  });
  return linuxApplications;
}

/** A program icon as a small data: URL; theme PNGs can be 512px and larger. */
function programIconDataUrl(file: string): Promise<string | undefined> {
  let icon = programIcons.get(file);
  if (!icon) {
    icon = (async () => {
      try {
        if (file.endsWith('.svg')) {
          const info = await stat(file);
          if (!info.isFile() || info.size > MAX_SVG_ICON_BYTES) return undefined;
          return `data:image/svg+xml;base64,${(await readFile(file)).toString('base64')}`;
        }
        const image = nativeImage.createFromBuffer(await readFile(file));
        if (image.isEmpty()) return undefined;
        return (
          image.getSize().width > PROGRAM_ICON_PIXELS
            ? image.resize({ width: PROGRAM_ICON_PIXELS, quality: 'best' })
            : image
        ).toDataURL();
      } catch {
        return undefined;
      }
    })();
    programIcons.set(file, icon);
  }
  return icon;
}

function localCopyRoot(): string {
  if (!isLinux) return path.join(app.getPath('temp'), 'muxus-open');
  // Strict snaps (Ubuntu's Firefox among them) get a private /tmp and cannot
  // read hidden folders at the top of the home directory, so Linux copies
  // live in a hidden folder inside Downloads. Without a Downloads folder the
  // lookup returns home itself; the shared /tmp then needs a per-user name.
  const downloads = app.getPath('downloads');
  return path.resolve(downloads) === path.resolve(app.getPath('home'))
    ? path.join(app.getPath('temp'), `muxus-open-${process.getuid?.() ?? 'user'}`)
    : path.join(downloads, '.muxus-open');
}

function ownedLocalCopy(event: IpcMainInvokeEvent, id: unknown) {
  const copy = typeof id === 'string' ? localCopies.get(id) : undefined;
  return copy && copy.owner === event.sender.id ? copy : undefined;
}

async function discardLocalCopy(id: string): Promise<void> {
  const copy = localCopies.get(id);
  if (!copy) return;
  localCopies.delete(id);
  await copy.handle.close().catch(() => undefined);
  await rm(copy.directory, { recursive: true, force: true }).catch(() => undefined);
}

function parseLocalOpenTarget(value: unknown): LocalOpenTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const target = value as Record<string, unknown>;
  if (target.kind === 'default' || target.kind === 'system-chooser') {
    return { kind: target.kind };
  }
  if (target.kind === 'application' && typeof target.id === 'string' && target.id.length <= 500) {
    return { kind: 'application', id: target.id };
  }
  return undefined;
}

async function openLocalCopy(file: string, target: LocalOpenTarget): Promise<void> {
  if (target.kind === 'default') {
    if (isLinux) {
      // Electron's openPath runs xdg-open with Electron's own environment.
      try {
        await runOpener('xdg-open', [file], { env: launchEnvironment(process.env) });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    const failure = await shell.openPath(file);
    if (failure) throw new Error(failure);
    return;
  }
  if (target.kind === 'system-chooser') {
    if (process.platform !== 'win32') throw new Error('No system chooser on this platform');
    // OpenAs_RunDLL takes the rest of the command line, unquoted, as the path.
    const rundll32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
    await startDetached(rundll32, [`shell32.dll,OpenAs_RunDLL ${file}`], {
      windowsVerbatimArguments: true,
    });
    return;
  }

  const picked = pickedPrograms.get(target.id);
  if (picked?.kind === 'mac-app') {
    await runOpener('/usr/bin/open', ['-a', picked.path, file]);
    return;
  }
  if (picked?.kind === 'executable') {
    await startDetached(picked.path, [file], {
      cwd: app.getPath('home'),
      env: launchEnvironment(process.env),
    });
    return;
  }
  const application =
    picked?.kind === 'desktop-entry'
      ? picked.application
      : isLinux
        ? await linuxApplicationCatalog().find(target.id)
        : undefined;
  if (!application) throw new Error('That program is no longer installed');
  const argv = expandExec(application, file);
  if (!argv) throw new Error(`${application.name} has an unreadable launch command`);
  const [command, ...args] = argv;
  await startDetached(command!, args, {
    cwd: application.workingDirectory ?? app.getPath('home'),
    env: launchEnvironment(process.env),
  });
}

ipcMain.handle(
  'muxus:local-open:applications',
  async (event, fileName: unknown): Promise<LocalOpenApplication[] | undefined> => {
    if (!isManagedWindowSender(event) || !isLinux) return undefined;
    if (typeof fileName !== 'string' || fileName.length > MAX_REMOTE_FILE_NAME_LENGTH) return undefined;
    const catalog = linuxApplicationCatalog();
    const { choices } = await catalog.applicationsFor(fileName);
    return Promise.all(
      choices.map(async ({ application, recommended, isDefault }) => {
        const iconFile = await catalog.iconFile(application);
        const icon = iconFile ? await programIconDataUrl(iconFile) : undefined;
        return {
          id: application.id,
          name: application.name,
          ...(icon ? { icon } : {}),
          ...(recommended ? { recommended } : {}),
          ...(isDefault ? { isDefault } : {}),
        };
      }),
    );
  },
);

ipcMain.handle(
  'muxus:local-open:choose-program',
  async (event): Promise<LocalProgramChoice | undefined> => {
    const win = senderWindow(event);
    if (!win || (!isMac && !isLinux)) return undefined;
    const result = await dialog.showOpenDialog(
      win,
      isMac
        ? {
            title: 'Choose an application',
            defaultPath: '/Applications',
            buttonLabel: 'Open',
            properties: ['openFile'],
            filters: [{ name: 'Applications', extensions: ['app'] }],
          }
        : { title: 'Choose a program', buttonLabel: 'Open', properties: ['openFile'] },
    );
    const file = result.canceled ? undefined : result.filePaths[0];
    if (!file) return undefined;

    let program: PickedProgram;
    let name: string;
    if (isMac) {
      program = { kind: 'mac-app', path: file };
      name = path.basename(file, '.app');
    } else if (file.endsWith('.desktop')) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return { message: `${path.basename(file)} could not be read.` };
      }
      const application = desktopApplicationFromText(text, path.basename(file), file, {
        currentDesktops: currentDesktops(process.env),
      });
      if (!application) return { message: `${path.basename(file)} does not describe a program Muxus can start.` };
      program = { kind: 'desktop-entry', application };
      name = application.name;
    } else {
      try {
        await access(file, fsConstants.X_OK);
      } catch {
        return { message: `${path.basename(file)} is not an executable program.` };
      }
      program = { kind: 'executable', path: file };
      name = path.basename(file);
    }
    const id = `picked:${randomUUID()}`;
    pickedPrograms.set(id, program);
    return { application: { id, name } };
  },
);

ipcMain.handle('muxus:local-open:begin', async (event, name: unknown): Promise<string | undefined> => {
  if (!isManagedWindowSender(event)) return undefined;
  if (typeof name !== 'string' || !name || name.length > MAX_REMOTE_FILE_NAME_LENGTH) return undefined;
  const root = localCopyRoot();
  void purgeStaleLocalCopies(root);
  const copy = await createLocalCopy(root, name);
  const id = randomUUID();
  const owner = event.sender.id;
  localCopies.set(id, { ...copy, owner });
  // A window closed mid-transfer leaves no half-written copy behind.
  if (!localCopyOwners.has(owner)) {
    localCopyOwners.add(owner);
    event.sender.once('destroyed', () => {
      localCopyOwners.delete(owner);
      for (const [copyId, unfinished] of localCopies) {
        if (unfinished.owner === owner) void discardLocalCopy(copyId);
      }
    });
  }
  return id;
});

ipcMain.handle('muxus:local-open:write', async (event, id: unknown, chunk: unknown): Promise<boolean> => {
  const copy = ownedLocalCopy(event, id);
  if (!copy || !(chunk instanceof Uint8Array) || chunk.byteLength > LOCAL_COPY_CHUNK_MAX_BYTES) {
    return false;
  }
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await copy.handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
  return true;
});

ipcMain.handle('muxus:local-open:cancel', async (event, id: unknown): Promise<void> => {
  if (ownedLocalCopy(event, id)) await discardLocalCopy(id as string);
});

ipcMain.handle(
  'muxus:local-open:finish',
  async (event, id: unknown, value: unknown): Promise<LocalOpenResult> => {
    const copy = ownedLocalCopy(event, id);
    const target = parseLocalOpenTarget(value);
    if (!copy || !target) {
      if (copy) await discardLocalCopy(id as string);
      return { ok: false, message: 'The downloaded copy is no longer available.' };
    }
    localCopies.delete(id as string);
    try {
      await copy.handle.close();
      if (process.platform === 'win32') await markAsDownloaded(copy.file);
      await openLocalCopy(copy.file, target);
      return { ok: true };
    } catch (err) {
      mainLog('warn', `could not open ${copy.file} locally`, err);
      await rm(copy.directory, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
);

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
      ((profile.kind === 'rdp' || profile.kind === 'vnc') &&
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

const initialCommandLineLaunch = parseCommandLineLaunch(process.argv);

function commandLineLaunchWindow(): BrowserWindow | undefined {
  return [...managedWindows].find((candidate) =>
    canHandleCommandLineLaunch(windowLaunches.get(candidate.webContents.id)),
  );
}

// Electron may reorder split-form custom switches in second-instance argv.
// Preserve the launch parsed by the invoking process as structured data.
if (!app.requestSingleInstanceLock(initialCommandLineLaunch ?? {})) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData) => {
    const launch =
      parseCommandLineLaunchData(additionalData) ??
      parseCommandLineLaunch(commandLine);
    const win = launch
      ? (commandLineLaunchWindow() ?? (appUrl ? createWindow(appUrl) : undefined))
      : (primaryWindow ?? [...managedWindows][0]);
    if (!win) {
      if (launch) deferredCommandLineLaunches.push(launch);
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (launch) {
      const send = () => {
        if (!win.isDestroyed()) {
          win.webContents.send('muxus:command-line-launch-requested', launch);
        }
      };
      if (win.webContents.isLoadingMainFrame()) {
        win.webContents.once('did-finish-load', send);
      } else {
        send();
      }
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
        // Windows builds ship VcXsrv for X11 forwarding (see scripts/vcxsrv.mjs).
        x11ServerDirectory:
          process.platform !== 'win32'
            ? undefined
            : app.isPackaged
              ? path.join(process.resourcesPath, 'vcxsrv')
              : path.resolve(moduleDir, '../vendor/vcxsrv'),
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
    void purgeStaleLocalCopies(localCopyRoot());
    buildMenu();
    const url = server.url;
    appUrl = url;
    const win = createWindow(url, undefined, initialCommandLineLaunch);
    desktopUpdater = createDesktopUpdater();
    if (deferredCommandLineLaunches.length > 0) {
      const launches = deferredCommandLineLaunches.splice(0);
      win.webContents.once('did-finish-load', () => {
        if (win.isDestroyed()) return;
        for (const launch of launches) {
          win.webContents.send('muxus:command-line-launch-requested', launch);
        }
      });
    }
  });

  // The server (and its SSH connections) is tied to the window, so quit
  // everywhere — including macOS — instead of lingering headless.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    desktopUpdater?.stop();
    flushClientState();
    if (!server) return;
    if (!closing) {
      const done = server.close().catch(() => undefined);
      closing = done;
      void done.then(() => {
        server = undefined;
        // An accepted update installs only after the server and its sessions
        // have closed; the installer then quits and relaunches Muxus.
        if (quittingForUpdate) {
          quittingForUpdate = false;
          if (desktopUpdater instanceof DesktopUpdater && desktopUpdater.finishInstall()) return;
        }
        app.quit();
      });
    }
    event.preventDefault();
  });
}

function createDesktopUpdater(): DesktopUpdater | StoreUpdater {
  const store = isStoreDistribution(distributionMetadata, process.windowsStore === true);
  const reason = updateDisabledReason({
    packaged: app.isPackaged,
    platform: process.platform,
    store,
    appImage: !!process.env.APPIMAGE,
  });
  const broadcast = (state: DesktopUpdateState) => {
    for (const win of managedWindows) {
      if (!win.isDestroyed()) win.webContents.send('muxus:update:changed', state);
    }
  };
  if (reason === 'store' && process.platform === 'win32') {
    return new StoreUpdater({
      version: app.getVersion(),
      broadcast,
      bridge: createStoreBridge(path.join(process.resourcesPath, 'store-updater', 'muxus-store-updater.exe'), () => {
        const focused = BrowserWindow.getFocusedWindow();
        const owner = focused && managedWindows.has(focused) ? focused : primaryWindow;
        if (!owner || owner.isDestroyed()) throw new Error('A Muxus window is required to contact Microsoft Store.');
        return owner.getNativeWindowHandle();
      }),
      beforeInstall: () => {
        // Windows can terminate the package during installation. Persist the
        // current state before handing control to its update/consent UI.
        flushClientState();
        if (primaryWindow && !primaryWindow.isDestroyed()) saveWindowState(primaryWindow);
      },
    });
  }
  return new DesktopUpdater({
    version: app.getVersion(),
    reason,
    broadcast,
    updater: reason ? undefined : electronUpdater.autoUpdater,
    prepareInstall: () => {
      quittingForUpdate = true;
      app.quit();
    },
    recoverInstall: () => {
      app.relaunch();
      app.exit(0);
    },
  });
}
