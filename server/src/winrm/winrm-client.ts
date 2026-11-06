import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { HttpConnection, type HttpResponse } from './http-connection.js';
import { authenticateMessage, negotiateMessage, parseChallenge, type NtlmSession } from './ntlm.js';

export type WinrmAuth = 'negotiate' | 'basic';

export interface WinrmEndpoint {
  host: string;
  port: number;
  https: boolean;
  auth: WinrmAuth;
  username: string;
  password: string;
  /** Opens the TCP (or TLS) stream to the server, directly or through a gateway. */
  openStream(): Promise<Duplex>;
}

/** The server turned the credentials down; asking again may help. */
export class WinrmAuthError extends Error {}

/** A SOAP fault from the WinRM service. */
export class WinrmFault extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }

  /** A Receive that waited the whole operation timeout without output. */
  get timedOut(): boolean {
    return /TimedOut|2150858793/.test(`${this.code} ${this.message}`);
  }
}

const SOAP_TYPE = 'application/soap+xml;charset=UTF-8';
const BOUNDARY = '--Encrypted Boundary';
const ENCRYPTED_TYPE =
  'multipart/encrypted;protocol="application/HTTP-SPNEGO-session-encrypted";boundary="Encrypted Boundary"';
const PATH = '/wsman';

/**
 * One authenticated HTTP connection to a WinRM service. Over plain HTTP the
 * NTLM session seals every message (what Windows requires by default); over
 * HTTPS the TLS channel protects them and messages go as they are.
 */
export class WinrmChannel {
  private session: NtlmSession | undefined;
  private pendingAuthorization: string | undefined;

  private constructor(
    private readonly http: HttpConnection,
    private readonly endpoint: WinrmEndpoint,
  ) {}

  static async open(endpoint: WinrmEndpoint): Promise<WinrmChannel> {
    const stream = await endpoint.openStream();
    const channel = new WinrmChannel(new HttpConnection(stream, `${endpoint.host}:${endpoint.port}`), endpoint);
    if (endpoint.auth === 'negotiate') await channel.negotiate();
    return channel;
  }

  get closed(): boolean {
    return this.http.closed;
  }

  close(): void {
    this.http.close();
  }

  private async negotiate(): Promise<void> {
    const first = await this.http.request(
      PATH,
      {
        Authorization: `Negotiate ${negotiateMessage().toString('base64')}`,
        'Content-Type': SOAP_TYPE,
      },
      Buffer.alloc(0),
    );
    const token = /Negotiate\s+([A-Za-z0-9+/=]+)/.exec(first.headers.get('www-authenticate') ?? '')?.[1];
    if (first.status !== 401 || !token) {
      throw new Error(
        first.status === 401
          ? 'The WinRM server does not offer Negotiate (NTLM) authentication.'
          : `The WinRM server answered the login with HTTP ${first.status}.`,
      );
    }
    const auth = authenticateMessage({
      username: this.endpoint.username,
      password: this.endpoint.password,
      challenge: parseChallenge(Buffer.from(token, 'base64')),
    });
    this.session = auth.session;
    // The third message rides on the first real request.
    this.pendingAuthorization = `Negotiate ${auth.message.toString('base64')}`;
  }

  /** Post one envelope and return the response envelope; faults throw. */
  async post(envelope: string): Promise<string> {
    const body = Buffer.from(envelope, 'utf8');
    const headers: Record<string, string> = {};
    let payload: Buffer<ArrayBufferLike> = body;
    const encrypt = this.endpoint.auth === 'negotiate' && !this.endpoint.https;
    if (encrypt) {
      headers['Content-Type'] = ENCRYPTED_TYPE;
      payload = this.encrypt(body);
    } else {
      headers['Content-Type'] = SOAP_TYPE;
    }
    if (this.endpoint.auth === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${this.endpoint.username}:${this.endpoint.password}`).toString('base64')}`;
    } else if (this.pendingAuthorization) {
      headers.Authorization = this.pendingAuthorization;
      this.pendingAuthorization = undefined;
    }
    const response = await this.http.request(PATH, headers, payload);
    if (response.status === 401) {
      throw new WinrmAuthError('The WinRM server rejected the user name or password.');
    }
    const text = this.responseText(response);
    if (response.status === 500 || /<(?:\w+:)?Fault\b/.test(text)) throw faultFrom(text, response.status);
    if (response.status !== 200) throw new Error(`The WinRM server answered with HTTP ${response.status}.`);
    return text;
  }

  private encrypt(body: Buffer): Buffer {
    const { signature, sealed } = this.session!.seal(body);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(signature.length);
    return Buffer.concat([
      Buffer.from(
        `${BOUNDARY}\r\n` +
          '\tContent-Type: application/HTTP-SPNEGO-session-encrypted\r\n' +
          `\tOriginalContent: type=${SOAP_TYPE};Length=${body.length}\r\n` +
          `${BOUNDARY}\r\n` +
          '\tContent-Type: application/octet-stream\r\n',
        'latin1',
      ),
      length,
      signature,
      sealed,
      Buffer.from(`${BOUNDARY}--\r\n`, 'latin1'),
    ]);
  }

  private responseText(response: HttpResponse): string {
    const type = response.headers.get('content-type') ?? '';
    if (!/multipart\/encrypted/i.test(type)) return response.body.toString('utf8');
    const marker = Buffer.from('\tContent-Type: application/octet-stream\r\n', 'latin1');
    const start = response.body.indexOf(marker);
    if (start < 0 || !this.session) throw new Error('The WinRM server sent an unreadable encrypted message.');
    const data = response.body.subarray(start + marker.length);
    const end = data.lastIndexOf(Buffer.from(BOUNDARY, 'latin1'));
    const part = end >= 0 ? data.subarray(0, end) : data;
    const signatureLength = part.readUInt32LE(0);
    const signature = part.subarray(4, 4 + signatureLength);
    const sealed = part.subarray(4 + signatureLength);
    const expected = Number(/Length=(\d+)/.exec(response.body.subarray(0, start).toString('latin1'))?.[1]);
    const plain = this.session.unseal(sealed, signature);
    return (Number.isInteger(expected) ? plain.subarray(0, expected) : plain).toString('utf8');
  }
}

function faultFrom(text: string, status: number): WinrmFault {
  const message =
    xmlText(/<(?:\w+:)?Message\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Message>/.exec(text)?.[1]) ||
    xmlText(/<(?:\w+:)?Text\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Text>/.exec(text)?.[1]) ||
    `The WinRM server reported an error (HTTP ${status}).`;
  const code = [
    /<(?:\w+:)?WSManFault\b[^>]*\bCode="(\d+)"/.exec(text)?.[1],
    /<(?:\w+:)?Subcode>\s*<(?:\w+:)?Value>([^<]+)</.exec(text)?.[1],
  ]
    .filter(Boolean)
    .join(' ');
  return new WinrmFault(message.trim(), code);
}

export function xmlText(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- WS-Management shell (MS-WSMV) ---

const SHELL_URI = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd';
const ACTION = {
  create: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create',
  delete: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete',
  command: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command',
  send: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Send',
  receive: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive',
  signal: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Signal',
};
export const SIGNAL = {
  ctrlC: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/ctrl_c',
  ctrlBreak: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/ctrl_break',
  terminate: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/terminate',
};
const DONE = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done';

export function envelope(
  to: string,
  action: string,
  body: string,
  options: { shellId?: string; options?: Record<string, string>; timeoutSeconds?: number } = {},
): string {
  const selector = options.shellId
    ? `<wsman:SelectorSet><wsman:Selector Name="ShellId">${escapeXml(options.shellId)}</wsman:Selector></wsman:SelectorSet>`
    : '';
  const optionSet = options.options
    ? `<wsman:OptionSet>${Object.entries(options.options)
        .map(([name, value]) => `<wsman:Option Name="${name}">${escapeXml(value)}</wsman:Option>`)
        .join('')}</wsman:OptionSet>`
    : '';
  return (
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" ' +
    'xmlns:wsmv="http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd" ' +
    'xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">' +
    '<s:Header>' +
    `<wsa:To>${escapeXml(to)}</wsa:To>` +
    '<wsa:ReplyTo><wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>' +
    '<wsman:MaxEnvelopeSize s:mustUnderstand="true">153600</wsman:MaxEnvelopeSize>' +
    `<wsa:MessageID>uuid:${randomUUID().toUpperCase()}</wsa:MessageID>` +
    '<wsman:Locale xml:lang="en-US" s:mustUnderstand="false"/>' +
    '<wsmv:DataLocale xml:lang="en-US" s:mustUnderstand="false"/>' +
    `<wsman:OperationTimeout>PT${options.timeoutSeconds ?? 20}S</wsman:OperationTimeout>` +
    `<wsman:ResourceURI s:mustUnderstand="true">${SHELL_URI}</wsman:ResourceURI>` +
    `<wsa:Action s:mustUnderstand="true">${action}</wsa:Action>` +
    selector +
    optionSet +
    '</s:Header>' +
    `<s:Body>${body}</s:Body>` +
    '</s:Envelope>'
  );
}

export interface ReceiveResult {
  /** Output in arrival order. */
  chunks: Array<{ stream: 'stdout' | 'stderr'; data: Buffer }>;
  /** Set once the command has finished. */
  exitCode?: number;
  done: boolean;
}

export function parseReceive(text: string): ReceiveResult {
  const chunks: ReceiveResult['chunks'] = [];
  const stream = /<(?:\w+:)?Stream\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Stream>)/g;
  for (let match = stream.exec(text); match; match = stream.exec(text)) {
    const name = /\bName="([^"]+)"/.exec(match[1] ?? '')?.[1];
    const content = (match[2] ?? '').trim();
    if (!content || (name !== 'stdout' && name !== 'stderr')) continue;
    chunks.push({ stream: name, data: Buffer.from(content, 'base64') });
  }
  const state = /<(?:\w+:)?CommandState\b[^>]*\bState="([^"]+)"/.exec(text)?.[1];
  const exit = /<(?:\w+:)?ExitCode>(-?\d+)</.exec(text)?.[1];
  return {
    chunks,
    done: state === DONE,
    ...(exit === undefined ? {} : { exitCode: Number(exit) }),
  };
}

/** One remote shell: created, given a command, fed stdin, read until done, deleted. */
export class WinrmShell {
  private constructor(
    private readonly to: string,
    readonly shellId: string,
    readonly commandId: string,
  ) {}

  static async start(channel: WinrmChannel, endpoint: WinrmEndpoint, command: string): Promise<WinrmShell> {
    const to = `${endpoint.https ? 'https' : 'http'}://${endpoint.host}:${endpoint.port}${PATH}`;
    const created = await channel.post(
      envelope(
        to,
        ACTION.create,
        '<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>',
        { options: { WINRS_NOPROFILE: 'FALSE', WINRS_CODEPAGE: '65001' } },
      ),
    );
    const shellId =
      /<(?:\w+:)?Selector Name="ShellId">([^<]+)</.exec(created)?.[1] ??
      /<(?:\w+:)?ShellId>([^<]+)</.exec(created)?.[1];
    if (!shellId) throw new Error('The WinRM server did not return a shell.');
    const commanded = await channel.post(
      envelope(
        to,
        ACTION.command,
        `<rsp:CommandLine><rsp:Command>${escapeXml(command)}</rsp:Command></rsp:CommandLine>`,
        {
          shellId,
          options: { WINRS_CONSOLEMODE_STDIN: 'TRUE', WINRS_SKIP_CMD_SHELL: 'FALSE' },
        },
      ),
    );
    const commandId = /<(?:\w+:)?CommandId>([^<]+)</.exec(commanded)?.[1];
    if (!commandId) throw new Error('The WinRM server did not start the shell command.');
    return new WinrmShell(to, shellId, commandId);
  }

  send(channel: WinrmChannel, data: Buffer, end = false): Promise<string> {
    return channel.post(
      envelope(
        this.to,
        ACTION.send,
        `<rsp:Send><rsp:Stream Name="stdin" CommandId="${escapeXml(this.commandId)}"${end ? ' End="true"' : ''}>${data.toString('base64')}</rsp:Stream></rsp:Send>`,
        { shellId: this.shellId },
      ),
    );
  }

  async receive(channel: WinrmChannel): Promise<ReceiveResult> {
    try {
      return parseReceive(
        await channel.post(
          envelope(
            this.to,
            ACTION.receive,
            `<rsp:Receive><rsp:DesiredStream CommandId="${escapeXml(this.commandId)}">stdout stderr</rsp:DesiredStream></rsp:Receive>`,
            { shellId: this.shellId },
          ),
        ),
      );
    } catch (err) {
      // Nothing to read within the operation timeout: ask again.
      if (err instanceof WinrmFault && err.timedOut) return { chunks: [], done: false };
      throw err;
    }
  }

  signal(channel: WinrmChannel, code: string): Promise<string> {
    return channel.post(
      envelope(
        this.to,
        ACTION.signal,
        `<rsp:Signal CommandId="${escapeXml(this.commandId)}"><rsp:Code>${code}</rsp:Code></rsp:Signal>`,
        { shellId: this.shellId },
      ),
    );
  }

  delete(channel: WinrmChannel): Promise<string> {
    return channel.post(envelope(this.to, ACTION.delete, '', { shellId: this.shellId }));
  }
}
