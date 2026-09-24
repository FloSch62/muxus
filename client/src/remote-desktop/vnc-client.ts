import type RFB from '@novnc/novnc';

export interface VncConnectOptions {
  target: HTMLElement;
  url: string;
  protocols: string[];
  viewOnly: boolean;
  resizeRemote: boolean;
  shareClipboard: boolean;
  onConnect: () => void;
  onCredentialsRequired: (types: Array<'username' | 'password'>) => void;
  /** `securityFailure` is set when the server rejected the credentials. */
  onDisconnect: (details: { clean: boolean; securityFailure?: string; failure?: string }) => void;
  onRemoteClipboard: (text: string) => void;
}

/** Plain-language versions of the failures noVNC reports while connecting. */
export function describeVncFailure(details: string | undefined): string | undefined {
  if (!details) return undefined;
  if (/Unsupported security types/i.test(details)) {
    return (
      'The VNC server offers no sign-in method Muxus supports; it may require TLS encryption. ' +
      'Allow VNC password authentication (VncAuth) on the server, or reach it through an SSH gateway without TLS.'
    );
  }
  if (/Unsupported VeNCrypt/i.test(details)) return 'The server uses a VeNCrypt version Muxus does not support.';
  if (/Security negotiation failed|Security handshake failed/i.test(details)) {
    return 'The VNC server rejected the password.';
  }
  // The backend closes the stream with a readable reason when it cannot connect.
  const closed = /Connection closed \(code: \d+, reason: (.+)\)$/.exec(details)?.[1];
  if (closed) return closed;
  if (/Connection closed/i.test(details)) return 'The connection to the VNC server closed during the handshake.';
  return details.replace(/^(RFB failure|Failed when connecting|Failed while connected): /, '');
}

/**
 * One noVNC client. noVNC draws into its own canvas inside `target`, scales
 * it to fit, and handles keyboard and pointer input itself.
 */
export class VncConnection {
  private readonly rfb: RFB;
  private lastFailure: string | undefined;
  private securityFailure: string | undefined;
  private lastClipboardText: string | undefined;

  /** noVNC loads with the first VNC connection, so RDP-only use never fetches it. */
  static async open(options: VncConnectOptions): Promise<VncConnection> {
    const { default: Rfb } = await import('@novnc/novnc');
    return new VncConnection(Rfb, options);
  }

  private constructor(
    Rfb: typeof RFB,
    private readonly options: VncConnectOptions,
  ) {
    this.rfb = new Rfb(options.target, options.url, { wsProtocols: options.protocols });
    this.rfb.scaleViewport = true;
    this.rfb.resizeSession = options.resizeRemote;
    this.rfb.viewOnly = options.viewOnly;
    this.rfb.focusOnClick = true;
    this.rfb.background = 'transparent';
    this.captureFailures();
    this.rfb.addEventListener('connect', () => options.onConnect());
    this.rfb.addEventListener('credentialsrequired', (event) => {
      const types = (event as CustomEvent<{ types?: string[] }>).detail.types ?? ['password'];
      options.onCredentialsRequired(
        types.filter((type): type is 'username' | 'password' => type === 'username' || type === 'password'),
      );
    });
    this.rfb.addEventListener('securityfailure', (event) => {
      const detail = (event as CustomEvent<{ status?: number; reason?: string }>).detail;
      this.securityFailure = detail.reason || 'Authentication failed.';
    });
    this.rfb.addEventListener('serververification', () => {
      // RealVNC's RSA-AES handshake asks the client to approve the server key.
      (this.rfb as unknown as { approveServer?: () => void }).approveServer?.();
    });
    this.rfb.addEventListener('clipboard', (event) => {
      if (!options.shareClipboard) return;
      const text = (event as CustomEvent<{ text: string }>).detail.text;
      this.lastClipboardText = text;
      options.onRemoteClipboard(text);
    });
    this.rfb.addEventListener('disconnect', (event) => {
      const clean = (event as CustomEvent<{ clean: boolean }>).detail.clean;
      options.onDisconnect({
        clean,
        securityFailure: this.securityFailure,
        failure: clean ? undefined : describeVncFailure(this.lastFailure),
      });
    });
  }

  /** noVNC reports why it failed only to its logger; keep the detail for the UI. */
  private captureFailures(): void {
    const rfb = this.rfb as unknown as { _fail?: (details: string) => boolean };
    const original = rfb._fail;
    if (typeof original !== 'function') return;
    rfb._fail = (details: string) => {
      this.lastFailure = details;
      return original.call(this.rfb, details);
    };
  }

  sendCredentials(credentials: { username?: string; password?: string }): void {
    this.rfb.sendCredentials(credentials);
  }

  sendCtrlAltDel(): void {
    this.rfb.sendCtrlAltDel();
  }

  focus(): void {
    this.rfb.focus({ preventScroll: true });
  }

  blur(): void {
    this.rfb.blur();
  }

  /** Hand local clipboard text to the server (VNC has no lazy clipboard). */
  sendClipboardText(text: string): void {
    if (!this.options.shareClipboard || text === this.lastClipboardText) return;
    this.lastClipboardText = text;
    this.rfb.clipboardPasteFrom(text);
  }

  disconnect(): void {
    this.rfb.disconnect();
  }
}
