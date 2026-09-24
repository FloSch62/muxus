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
  /**
   * An RSA-AES server presented its key; resolve true to continue. The
   * handshake waits, and no credentials are sent until the key is trusted.
   */
  onServerKey: (key: VncServerKey) => Promise<boolean>;
  /** `securityFailure` is set when the server rejected the credentials. */
  onDisconnect: (details: { clean: boolean; securityFailure?: string; failure?: string }) => void;
  onRemoteClipboard: (text: string) => void;
}

export interface VncServerKey {
  bits: number;
  /** Colon-separated SHA-256, the value that is pinned. */
  fingerprint: string;
  /** The first 8 bytes of the SHA-1, the fingerprint TigerVNC's viewer shows. */
  signature: string;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));

/**
 * Fingerprints of an RSA-AES server key as noVNC hands it over: the 4-byte
 * key length in bits, then the modulus and exponent, as the server sent them.
 */
export async function vncServerKey(publicKey: Uint8Array): Promise<VncServerKey> {
  const data = new Uint8Array(publicKey);
  const bits = new DataView(data.buffer).getUint32(0);
  const [sha256, sha1] = await Promise.all([
    crypto.subtle.digest('SHA-256', data),
    crypto.subtle.digest('SHA-1', data),
  ]);
  return {
    bits,
    fingerprint: hex(new Uint8Array(sha256)).join(':').toUpperCase(),
    signature: hex(new Uint8Array(sha1).subarray(0, 8)).join('-'),
  };
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
  /** Set when the connection ended over the server key, not a network failure. */
  private keyFailure: string | undefined;
  private closed = false;
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
    this.rfb.addEventListener('serververification', (event) => {
      const detail = (event as CustomEvent<{ type: string; publickey: Uint8Array }>).detail;
      void this.verifyServer(detail);
    });
    this.rfb.addEventListener('clipboard', (event) => {
      if (!options.shareClipboard) return;
      const text = (event as CustomEvent<{ text: string }>).detail.text;
      this.lastClipboardText = text;
      options.onRemoteClipboard(text);
    });
    this.rfb.addEventListener('disconnect', (event) => {
      this.closed = true;
      const clean = (event as CustomEvent<{ clean: boolean }>).detail.clean;
      options.onDisconnect({
        clean,
        securityFailure: this.securityFailure,
        failure: this.keyFailure ?? (clean ? undefined : describeVncFailure(this.lastFailure)),
      });
    });
  }

  /** RSA-AES servers identify with a key; the handshake waits for approval. */
  private async verifyServer(detail: { type: string; publickey: Uint8Array }): Promise<void> {
    let trusted = false;
    if (detail.type !== 'RSA') {
      this.keyFailure = `The VNC server identified itself with an unsupported ${detail.type} key.`;
    } else {
      try {
        trusted = await this.options.onServerKey(await vncServerKey(detail.publickey));
        if (!trusted) this.keyFailure = 'The VNC server key was not trusted.';
      } catch (err) {
        this.keyFailure = `The VNC server key could not be checked: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (this.closed) return;
    if (trusted) this.rfb.approveServer();
    else this.rfb.disconnect();
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
    if (this.closed) return;
    this.closed = true;
    this.rfb.disconnect();
  }
}
