import {
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

/** What a renderer asks for when it opens a saved web host. */
export interface WebWindowRequest {
  /** Saved host ID: one window and one cookie jar per host. */
  key: string;
  url: string;
  title: string;
  /** `socks5://127.0.0.1:<port>` through the host's SSH gateway; absent connects directly. */
  proxy?: string;
  /** The forward behind `proxy`; the window stops it when it closes. */
  forwardId?: string;
}

/**
 * `opened` for a new window; `focused` when it was already open (a proxy
 * sent along is then not needed and is stopped); `invalid` for a request
 * that cannot be shown.
 */
export type WebWindowResult = 'opened' | 'focused' | 'invalid';

const KEY = /^[A-Za-z0-9_-]{1,200}$/;
const PROXY = /^socks5:\/\/127\.0\.0\.1:\d{1,5}$/;
const FORWARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

const windows = new Map<string, BrowserWindow>();
/** Windows a page opened (target=_blank), by the host window they belong to. */
const popups = new Map<BrowserWindow, Set<BrowserWindow>>();
/** Stops a page's proxy forward; set by {@link registerWebWindows}. */
let stopForward: (id: string) => void = () => {};
/** Certificates the user accepted, per window, as `host fingerprint`. */
const acceptedCertificates = new WeakMap<WebContents, Set<string>>();
const pendingCertificates = new WeakMap<WebContents, Map<string, Promise<boolean>>>();

export function parseWebWindowRequest(value: unknown): WebWindowRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { key, url, title, proxy, forwardId } = value as Record<string, unknown>;
  if (typeof key !== 'string' || !KEY.test(key)) return undefined;
  if (typeof url !== 'string' || url.length > 4096 || !isWebUrl(url)) return undefined;
  if (typeof title !== 'string' || title.length > 500) return undefined;
  if (proxy !== undefined && (typeof proxy !== 'string' || !PROXY.test(proxy))) return undefined;
  if (forwardId !== undefined && (typeof forwardId !== 'string' || !FORWARD_ID.test(forwardId))) return undefined;
  return { key, url, title, ...(proxy ? { proxy } : {}), ...(forwardId ? { forwardId } : {}) };
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Open (or focus) the browser window for one web host. The window has its
 * own persistent session, so a host keeps its logins and never shares
 * cookies with another host or with Muxus itself. With a proxy, every
 * request, DNS lookups included, goes through the SOCKS5 forward on the
 * host's SSH gateway; names only the gateway knows resolve there.
 */
export async function openWebWindow(
  request: WebWindowRequest,
  options: { icon?: string },
): Promise<WebWindowResult> {
  if (focusWebWindow(request.key)) {
    // Another app window got here first; its proxy serves the page.
    if (request.forwardId) stopForward(request.forwardId);
    return 'focused';
  }

  const partition = `persist:muxus-web-${request.key}`;
  const webSession = session.fromPartition(partition);
  await webSession.setProxy(
    request.proxy
      ? // `<-loopback>` sends localhost through the gateway too, so a page
        // served on the gateway's own loopback interface opens.
        { proxyRules: request.proxy, proxyBypassRules: '<-loopback>' }
      : { mode: 'direct' },
  );
  // Pages never get the camera, microphone, location or notifications.
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: request.title,
    ...(options.icon ? { icon: options.icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  windows.set(request.key, win);
  const prefix = `${request.title} — `;
  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(title ? `${prefix}${title}` : request.title);
  });
  guardContents(win, win, partition);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const contents = win.webContents;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const history = contents.navigationHistory;
    if ((input.alt && input.key === 'ArrowLeft') || (mod && input.key === '[')) {
      if (history.canGoBack()) history.goBack();
      event.preventDefault();
    } else if ((input.alt && input.key === 'ArrowRight') || (mod && input.key === ']')) {
      if (history.canGoForward()) history.goForward();
      event.preventDefault();
    } else if (input.key === 'F5' || (mod && input.key.toLowerCase() === 'r')) {
      contents.reload();
      event.preventDefault();
    }
  });
  win.webContents.on('context-menu', (_event, params) => {
    const contents = win.webContents;
    const history = contents.navigationHistory;
    Menu.buildFromTemplate([
      { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
      { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
    ]).popup({ window: win });
  });

  win.on('closed', () => {
    if (windows.get(request.key) === win) windows.delete(request.key);
    // Pages it opened would be left on a proxy that is about to stop.
    for (const popup of popups.get(win) ?? []) if (!popup.isDestroyed()) popup.close();
    popups.delete(win);
    if (request.forwardId) stopForward(request.forwardId);
  });
  win.loadURL(request.url).catch(() => {
    // Chromium shows its own error page; nothing to add here.
  });
  return 'opened';
}

/** Bring a host's open window to the front; false when it has none. */
export function focusWebWindow(key: string): boolean {
  const existing = windows.get(key);
  if (!existing || existing.isDestroyed()) return false;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
  return true;
}

/** Close every web window, as the last app window closes; each stops its proxy. */
export function closeAllWebWindows(): void {
  for (const win of windows.values()) if (!win.isDestroyed()) win.close();
}

/**
 * A page window, or a window it opened, stays on http(s) and in its host's
 * session and proxy; windows it opens get the same rules and close with the
 * host window.
 */
function guardContents(owner: BrowserWindow, win: BrowserWindow, partition: string): void {
  win.webContents.setWindowOpenHandler(({ url }) =>
    isWebUrl(url)
      ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        }
      : { action: 'deny' },
  );
  win.webContents.on('did-create-window', (child) => {
    const children = popups.get(owner) ?? new Set<BrowserWindow>();
    popups.set(owner, children);
    children.add(child);
    child.on('closed', () => children.delete(child));
    guardContents(owner, child, partition);
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isWebUrl(url)) event.preventDefault();
  });
}

/**
 * Internal web consoles often use self-signed certificates. Ask once per
 * certificate and window instead of refusing outright, the way a browser's
 * "proceed anyway" does. Only web host windows get this; the app's own
 * windows keep the default refusal.
 */
export function handleWebCertificateError(
  contents: WebContents,
  url: string,
  error: string,
  fingerprint: string,
  callback: (trust: boolean) => void,
): boolean {
  const owner = BrowserWindow.fromWebContents(contents);
  const isWebWindow =
    [...windows.values()].some((win) => !win.isDestroyed() && win.webContents === contents) ||
    (owner !== null && [...windows.values()].some((win) => win === owner.getParentWindow()));
  if (!isWebWindow && !isWebSession(contents)) return false;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw URL */
  }
  const accepted = acceptedCertificates.get(contents) ?? new Set<string>();
  acceptedCertificates.set(contents, accepted);
  const key = `${host} ${fingerprint}`;
  if (accepted.has(key)) {
    callback(true);
    return true;
  }
  const options = {
    type: 'warning' as const,
    buttons: ['Go back', 'Continue anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Certificate not trusted',
    message: `The certificate of ${host} is not trusted.`,
    detail: `${error}\n\n${fingerprint}\n\nContinue only if you expect this certificate, such as a device's self-signed one.`,
  };
  // A page loading many resources from one host asks once, not once per request.
  const asking = pendingCertificates.get(contents) ?? new Map<string, Promise<boolean>>();
  pendingCertificates.set(contents, asking);
  let answer = asking.get(key);
  if (!answer) {
    answer = (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)).then(
      ({ response }) => response === 1,
      () => false,
    );
    asking.set(key, answer);
    void answer.then((trust) => {
      asking.delete(key);
      if (trust) accepted.add(key);
    });
  }
  void answer.then(callback);
  return true;
}

function isWebSession(contents: WebContents): boolean {
  const all = [...windows.values(), ...[...popups.values()].flatMap((set) => [...set])];
  return all.some((win) => !win.isDestroyed() && win.webContents.session === contents.session);
}

/**
 * Wire the IPC calls; `allowed` says whether the sender is a Muxus app
 * window, and `stop` stops a proxy forward when its window is done with it.
 */
export function registerWebWindows(
  allowed: (event: IpcMainInvokeEvent) => boolean,
  options: () => { icon?: string },
  stop: (forwardId: string) => void,
): void {
  stopForward = stop;
  ipcMain.handle('muxus:web:open', async (event, value: unknown): Promise<WebWindowResult> => {
    if (!allowed(event)) return 'invalid';
    const request = parseWebWindowRequest(value);
    if (!request) {
      const forwardId = (value as { forwardId?: unknown } | null)?.forwardId;
      if (typeof forwardId === 'string' && FORWARD_ID.test(forwardId)) stop(forwardId);
      return 'invalid';
    }
    return openWebWindow(request, options());
  });
  ipcMain.handle('muxus:web:focus', (event, key: unknown): boolean =>
    allowed(event) && typeof key === 'string' && KEY.test(key) ? focusWebWindow(key) : false,
  );
}
