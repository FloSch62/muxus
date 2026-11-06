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
}

/** `closed` once the window is gone; `focused` when it was already open. */
export type WebWindowResult = 'closed' | 'focused' | 'invalid';

const KEY = /^[A-Za-z0-9_-]{1,200}$/;
const PROXY = /^socks5:\/\/127\.0\.0\.1:\d{1,5}$/;

const windows = new Map<string, BrowserWindow>();
/** Certificates the user accepted, per window, as `host fingerprint`. */
const acceptedCertificates = new WeakMap<WebContents, Set<string>>();
const pendingCertificates = new WeakMap<WebContents, Map<string, Promise<boolean>>>();

export function parseWebWindowRequest(value: unknown): WebWindowRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { key, url, title, proxy } = value as Record<string, unknown>;
  if (typeof key !== 'string' || !KEY.test(key)) return undefined;
  if (typeof url !== 'string' || url.length > 4096 || !isWebUrl(url)) return undefined;
  if (typeof title !== 'string' || title.length > 500) return undefined;
  if (proxy !== undefined && (typeof proxy !== 'string' || !PROXY.test(proxy))) return undefined;
  return { key, url, title, ...(proxy ? { proxy } : {}) };
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
  const existing = windows.get(request.key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
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
  // Links that open a new window stay in this host's session and proxy.
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
  win.webContents.on('will-navigate', (event, url) => {
    if (!isWebUrl(url)) event.preventDefault();
  });
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

  const closed = new Promise<WebWindowResult>((resolve) => {
    win.on('closed', () => {
      if (windows.get(request.key) === win) windows.delete(request.key);
      resolve('closed');
    });
  });
  win.loadURL(request.url).catch(() => {
    // Chromium shows its own error page; nothing to add here.
  });
  return closed;
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
  return [...windows.values()].some(
    (win) => !win.isDestroyed() && win.webContents.session === contents.session,
  );
}

/** Wire the IPC call; `allowed` says whether the sender is a Muxus app window. */
export function registerWebWindows(
  allowed: (event: IpcMainInvokeEvent) => boolean,
  options: () => { icon?: string },
): void {
  ipcMain.handle('muxus:web:open', async (event, value: unknown): Promise<WebWindowResult> => {
    if (!allowed(event)) return 'invalid';
    const request = parseWebWindowRequest(value);
    if (!request) return 'invalid';
    return openWebWindow(request, options());
  });
}
