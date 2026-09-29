import {
  ClipboardData,
  DesktopSize,
  DeviceEvent,
  Extension,
  InputTransaction,
  IronErrorKind,
  loadIronRdp,
  RotationUnit,
  SessionBuilder,
  type IronError,
  type Session,
} from './ironrdp.js';
import { SCANCODE, scancodeForCode } from './scancodes.js';

/** Modifier flags on every key event, with the scancodes that produce them. */
const MODIFIERS = [
  { flag: 'shiftKey', codes: [0x2a, 0x36] },
  { flag: 'ctrlKey', codes: [0x1d, 0xe01d] },
  { flag: 'altKey', codes: [0x38, 0xe038] },
  { flag: 'metaKey', codes: [0xe05b, 0xe05c] },
] as const;
const MODIFIER_CODES = new Set<number>(MODIFIERS.flatMap((modifier) => [...modifier.codes]));

/** Why an RDP connection attempt failed, in the terms the UI acts on. */
export type RdpFailureKind = 'credentials' | 'refused' | 'failed';

export class RdpFailure extends Error {
  constructor(
    message: string,
    readonly kind: RdpFailureKind,
  ) {
    super(message);
  }
}

/** RDP's display-control limits ([MS-RDPEDISP] 2.2.2.2.1): 200–8192, width even. */
export function rdpDesktopSize(width: number, height: number): { width: number; height: number } {
  const clamp = (value: number) => Math.max(200, Math.min(8192, Math.floor(value)));
  return { width: clamp(width) & ~1, height: clamp(height) };
}

/** Split `DOMAIN\user` the way mstsc does when no domain is configured separately. */
export function rdpLogon(username: string, domain: string | undefined): { username: string; domain: string } {
  if (!domain) {
    const slash = username.indexOf('\\');
    if (slash > 0) return { domain: username.slice(0, slash), username: username.slice(slash + 1) };
  }
  return { username, domain: domain ?? '' };
}

const WSA_MESSAGES: Record<number, string> = {
  10060: 'The connection timed out.',
  10061: 'The remote computer refused the connection. Is Remote Desktop enabled, and is the port right?',
  10065: 'The remote computer is unreachable.',
  10051: 'The network is unreachable.',
  10054: 'The remote computer closed the connection.',
  11001: 'The host name could not be resolved.',
  11002: 'The host name could not be resolved right now.',
};

const NEGOTIATION_MESSAGES: Array<[RegExp, string]> = [
  [/HYBRID_REQUIRED|hybrid.*required/i, 'The server requires Network Level Authentication, which it could not complete.'],
  [/SSL_NOT_ALLOWED/i, 'The server only allows the legacy RDP security layer, which Muxus does not support. Enable TLS or NLA on the server.'],
  [/SSL_CERT_NOT_ON_SERVER/i, 'The server has no TLS certificate configured.'],
  [/SSL_WITH_USER_AUTH/i, 'The server requires TLS with user authentication (RDSTLS), which Muxus does not support.'],
  [/SSL_REQUIRED/i, 'The server requires TLS but refused it.'],
];

/** Turn IronRDP's error object into a sentence and the kind the UI branches on. */
export function describeRdpError(error: unknown): RdpFailure {
  const iron = error as Partial<IronError> | undefined;
  if (!iron || typeof iron.kind !== 'function') {
    return new RdpFailure(error instanceof Error ? error.message : String(error), 'failed');
  }
  const kind = iron.kind();
  const trace = typeof iron.backtrace === 'function' ? iron.backtrace() : '';
  const firstLine = trace.split('\n').find((line) => line.trim())?.trim() ?? 'The connection failed.';
  switch (kind) {
    case IronErrorKind.WrongPassword:
    case IronErrorKind.LogonFailure:
      return new RdpFailure('The user name or password is incorrect.', 'credentials');
    case IronErrorKind.AccessDenied:
      return new RdpFailure('The remote computer denied access to this account.', 'refused');
    case IronErrorKind.NegotiationFailure: {
      const match = NEGOTIATION_MESSAGES.find(([pattern]) => pattern.test(trace));
      return new RdpFailure(match?.[1] ?? `Security negotiation failed: ${firstLine}`, 'refused');
    }
    case IronErrorKind.RDCleanPath: {
      const details = iron.rdcleanpathDetails?.();
      const wsa = details?.wsaErrorCode;
      if (wsa !== undefined && WSA_MESSAGES[wsa]) return new RdpFailure(WSA_MESSAGES[wsa], 'failed');
      if (details?.httpStatusCode === 403) {
        return new RdpFailure('The server certificate was not trusted.', 'refused');
      }
      if (details?.tlsAlertCode !== undefined) {
        return new RdpFailure(`The TLS handshake failed (alert ${details.tlsAlertCode}).`, 'failed');
      }
      return new RdpFailure('Muxus could not connect to the remote computer.', 'failed');
    }
    case IronErrorKind.ProxyConnect:
      return new RdpFailure('Could not reach the Muxus backend.', 'failed');
    default:
      // Servers other than Windows (FreeRDP, GNOME Remote Desktop) reject an
      // NLA logon with a bare CredSSP error status rather than LOGON_FAILURE.
      if (/CredSSP|NTLM|SEC_E_LOGON_DENIED/i.test(trace)) {
        return new RdpFailure('The user name or password is incorrect.', 'credentials');
      }
      if (/WebSocket Closed|read frame|connection reset|broken pipe/i.test(trace)) {
        return new RdpFailure('The connection to the remote computer was lost.', 'failed');
      }
      return new RdpFailure(firstLine, 'failed');
  }
}

export interface RdpConnectOptions {
  canvas: HTMLCanvasElement;
  proxyAddress: string;
  ticket: string;
  /** host:port as the user configured it (shown to the server, used for Kerberos SPNs). */
  destination: string;
  username: string;
  password: string;
  domain?: string;
  width: number;
  height: number;
  shareClipboard: boolean;
  onCursor: (cursor: string) => void;
  onRemoteClipboard: (text: string) => void;
}

/**
 * A live RDP session drawn into one canvas. Input is translated from DOM
 * events (physical key codes → scancodes, CSS pixels → desktop pixels) and
 * applied as IronRDP input transactions.
 */
export class RdpConnection {
  /** Modifiers the server currently sees held down. */
  private readonly heldModifiers = new Set<number>();
  private lastClipboardText: string | undefined;
  private closed = false;

  private constructor(
    private readonly session: Session,
    private readonly canvas: HTMLCanvasElement,
    readonly shareClipboard: boolean,
  ) {}

  static async connect(options: RdpConnectOptions): Promise<RdpConnection> {
    await loadIronRdp();
    const logon = rdpLogon(options.username, options.domain);
    const size = rdpDesktopSize(options.width, options.height);
    let connection: RdpConnection | undefined;
    const builder = new SessionBuilder()
      .proxyAddress(options.proxyAddress)
      .authToken(options.ticket)
      .destination(options.destination)
      .username(logon.username)
      .password(options.password)
      .serverDomain(logon.domain)
      .desktopSize(new DesktopSize(size.width, size.height))
      .renderCanvas(options.canvas)
      .setCursorStyleCallbackContext(null)
      .setCursorStyleCallback(
        (kind: string, data?: string, hotspotX?: number, hotspotY?: number) => {
          if (kind === 'hidden') options.onCursor('none');
          else if (kind === 'url' && data !== undefined) {
            options.onCursor(`url(${data}) ${Math.round(hotspotX ?? 0)} ${Math.round(hotspotY ?? 0)}, default`);
          } else options.onCursor('default');
        },
      )
      .extension(new Extension('display_control', true))
      .extension(new Extension('autologon', true));
    if (options.shareClipboard) {
      builder
        .remoteClipboardChangedCallback((data: ClipboardData) => {
          for (const item of data.items()) {
            const value: unknown = item.value();
            if (item.mimeType() === 'text/plain' && typeof value === 'string') {
              connection?.rememberClipboard(value);
              options.onRemoteClipboard(value);
              return;
            }
          }
        })
        .forceClipboardUpdateCallback(() => {
          if (connection?.lastClipboardText !== undefined) {
            void connection.sendClipboardText(connection.lastClipboardText, true);
          }
        });
    }
    let session: Session;
    try {
      session = await builder.connect();
    } catch (err) {
      throw describeRdpError(err);
    }
    connection = new RdpConnection(session, options.canvas, options.shareClipboard);
    return connection;
  }

  /** Resolves with the server's reason once the session ends for any cause. */
  async run(): Promise<string> {
    try {
      const info = await this.session.run();
      return info.reason();
    } catch (err) {
      throw describeRdpError(err);
    } finally {
      this.closed = true;
    }
  }

  get desktopWidth(): number {
    return this.canvas.width;
  }

  get desktopHeight(): number {
    return this.canvas.height;
  }

  private apply(events: DeviceEvent[]): void {
    if (this.closed || events.length === 0) return;
    const transaction = new InputTransaction();
    for (const event of events) transaction.addEvent(event);
    try {
      this.session.applyInputs(transaction);
    } catch {
      /* the session is going away; its run() reports why */
    }
  }

  /** Returns false for keys RDP has no scancode for, so the caller may let them be. */
  key(event: KeyboardEvent): boolean {
    const scancode = scancodeForCode(event.code);
    if (scancode === undefined) return false;
    const modifier = MODIFIER_CODES.has(scancode);
    if (event.type === 'keydown') {
      this.syncLockKeys(event);
      if (modifier) this.heldModifiers.add(scancode);
      this.apply([...(modifier ? [] : this.reconcileModifiers(event)), DeviceEvent.keyPressed(scancode)]);
    } else {
      if (modifier) this.heldModifiers.delete(scancode);
      this.apply([DeviceEvent.keyReleased(scancode)]);
    }
    return true;
  }

  /**
   * Bring the server's modifiers in line with the event's flags. A modifier
   * pressed before the canvas had focus (Shift held while clicking into the
   * desktop) never produced a keydown here, and one released elsewhere never
   * produced its keyup; either would otherwise change what the key types.
   */
  private reconcileModifiers(event: KeyboardEvent): DeviceEvent[] {
    const events: DeviceEvent[] = [];
    for (const { flag, codes } of MODIFIERS) {
      const held = codes.filter((code) => this.heldModifiers.has(code));
      if (event[flag] && held.length === 0) {
        this.heldModifiers.add(codes[0]);
        events.push(DeviceEvent.keyPressed(codes[0]));
      } else if (!event[flag]) {
        for (const code of held) {
          this.heldModifiers.delete(code);
          events.push(DeviceEvent.keyReleased(code));
        }
      }
    }
    return events;
  }

  private syncLockKeys(event: KeyboardEvent): void {
    if (this.closed) return;
    try {
      this.session.synchronizeLockKeys(
        event.getModifierState('ScrollLock'),
        event.getModifierState('NumLock'),
        event.getModifierState('CapsLock'),
        false,
      );
    } catch {
      /* closing */
    }
  }

  /** Map a pointer position in CSS pixels onto the remote desktop. */
  private desktopPoint(event: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * this.canvas.width;
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * this.canvas.height;
    return {
      x: Math.max(0, Math.min(this.canvas.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(this.canvas.height - 1, Math.round(y))),
    };
  }

  pointerMove(event: MouseEvent): void {
    const { x, y } = this.desktopPoint(event);
    this.apply([DeviceEvent.mouseMove(x, y)]);
  }

  pointerButton(event: MouseEvent, pressed: boolean): void {
    const { x, y } = this.desktopPoint(event);
    this.apply([
      DeviceEvent.mouseMove(x, y),
      pressed ? DeviceEvent.mouseButtonPressed(event.button) : DeviceEvent.mouseButtonReleased(event.button),
    ]);
  }

  wheel(event: WheelEvent): void {
    const vertical = event.deltaY !== 0;
    const delta = vertical ? event.deltaY : event.deltaX;
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? RotationUnit.Line
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? RotationUnit.Page
          : RotationUnit.Pixel;
    // RDP counts positive rotation away from the user; DOM deltas grow toward them.
    this.apply([DeviceEvent.wheelRotations(vertical, -delta, unit)]);
  }

  /** Let go of everything held down, e.g. when focus leaves mid-chord. */
  releaseAll(): void {
    this.heldModifiers.clear();
    if (this.closed) return;
    try {
      this.session.releaseAllInputs();
    } catch {
      /* closing */
    }
  }

  sendCtrlAltDel(): void {
    const keys = [SCANCODE.controlLeft, SCANCODE.altLeft, SCANCODE.delete];
    this.apply([...keys.map((key) => DeviceEvent.keyPressed(key)), ...keys.reverse().map((key) => DeviceEvent.keyReleased(key))]);
  }

  sendWindowsKey(): void {
    this.apply([DeviceEvent.keyPressed(SCANCODE.metaLeft), DeviceEvent.keyReleased(SCANCODE.metaLeft)]);
  }

  /** Ask the server for a desktop matching the pane (display control channel). */
  resize(width: number, height: number): void {
    if (this.closed) return;
    const size = rdpDesktopSize(width, height);
    if (size.width === this.canvas.width && size.height === this.canvas.height) return;
    try {
      this.session.resize(size.width, size.height);
    } catch {
      /* servers without display control keep their size; the view scales instead */
    }
  }

  private rememberClipboard(text: string): void {
    this.lastClipboardText = text;
  }

  /** Offer local clipboard text to the remote side (announced, fetched on paste). */
  async sendClipboardText(text: string, force = false): Promise<void> {
    if (this.closed || !this.shareClipboard) return;
    if (!force && text === this.lastClipboardText) return;
    this.lastClipboardText = text;
    const data = new ClipboardData();
    data.addText('text/plain', text);
    try {
      await this.session.onClipboardPaste(data);
    } catch {
      /* closing */
    }
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.shutdown();
    } catch {
      /* already gone */
    }
  }
}
