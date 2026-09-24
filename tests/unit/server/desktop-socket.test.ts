import { createHash, X509Certificate } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DESKTOP_RDP_WS_PATH,
  DESKTOP_TICKET_PROTOCOL_PREFIX,
  DESKTOP_VNC_WS_PATH,
  terminalWebSocketProtocols,
  type DesktopServerMessage,
} from '@muxus/shared/ws-protocol';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { DesktopTickets } from '../../../server/src/remote-desktop/desktop-socket.js';

const TOKEN = 'desktop-socket-test-token';

/** Self-signed P-256 certificate for the fake RDP server (valid until 2126). */
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBijCCAS+gAwIBAgIUPTlx/wKVtLsVO0U3wZfD4rXynqgwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOcmRwLm11eHVzLnRlc3QwIBcNMjYwOTI0MTU0NzI4WhgPMjEy
NjA4MzExNTQ3MjhaMBkxFzAVBgNVBAMMDnJkcC5tdXh1cy50ZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEwQ/R8JYkDXHTekz21csVDCuFJWA0KfI4ds0fhKjE
suY+BdGh9nx39N3oN3431swMBfQ15jQN7bvT19dSyHzVUaNTMFEwHQYDVR0OBBYE
FL+fNkTerPkje0NzQDJTSuK1IMZMMB8GA1UdIwQYMBaAFL+fNkTerPkje0NzQDJT
SuK1IMZMMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAMRoLMzy
oaU+Ln9UhnFQhUTn1a5vff4YA5VSCwDmo2m+AiEAr36LIvt2vzYXvOcLiD5S2IC8
qFqy+UwGqP02HkIH6Ys=
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUMEJjrQv5A6WS7Rw
q4UKUmJMYMcFCiMJ29wURxvZd/yhRANCAATBD9HwliQNcdN6TPbVyxUMK4UlYDQp
8jh2zR+EqMSy5j4F0aH2fHf03eg3fjfWzAwF9DXmNA3tu9PX11LIfNVR
-----END PRIVATE KEY-----`;
const CERTIFICATE_DER = new X509Certificate(TEST_CERTIFICATE).raw;

/** The X.224 Connection Request IronRDP sends (SSL | HYBRID | HYBRID_EX). */
const X224_REQUEST = Buffer.from(
  '0300002b26e00000000000436f6f6b69653a206d737473686173683d6d757875730d0a010008000b000000',
  'hex',
);
const confirmFor = (protocol: number) =>
  Buffer.from(`030000130ed00000123400020108000${protocol}000000`, 'hex');
const REFUSAL = Buffer.from('030000130ed000000000000300080005000000', 'hex');

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
let base: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  ({ app, ctx } = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  ));
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await app.close();
});

function listen(server: net.Server): Promise<number> {
  cleanups.push(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** A VNC server that greets like RFB 3.8 and echoes everything back. */
async function fakeVncServer(): Promise<number> {
  return listen(
    net.createServer((socket) => {
      socket.write('RFB 003.008\n');
      socket.on('data', (data) => socket.write(data));
    }),
  );
}

/** An RDP server's front half: X.224 confirm, then TLS, then an echo. */
async function fakeRdpServer(
  confirm: Buffer,
  { resetAfterTls = false } = {},
): Promise<{ port: number; requests: Buffer[] }> {
  const requests: Buffer[] = [];
  const port = await listen(
    net.createServer((socket) => {
      socket.once('data', (request) => {
        requests.push(request);
        socket.write(confirm);
        if (confirm === REFUSAL) return;
        const secure = new tls.TLSSocket(socket, { isServer: true, cert: TEST_CERTIFICATE, key: TEST_KEY });
        if (resetAfterTls) secure.once('secure', () => setTimeout(() => socket.resetAndDestroy(), 20));
        secure.on('data', (data) => secure.write(Buffer.concat([Buffer.from('echo:'), data])));
        secure.on('error', () => socket.destroy());
      });
    }),
  );
  return { port, requests };
}

/** Minimal DER for an RDCleanPath request (version, destination, proxy_auth, X.224). */
function rdCleanPathRequest(ticket: string, destination: string): Buffer {
  const tlv = (tag: number, value: Buffer) => {
    const length = value.length < 0x80 ? Buffer.from([value.length]) : Buffer.from([0x81, value.length]);
    return Buffer.concat([Buffer.from([tag]), length, value]);
  };
  return tlv(
    0x30,
    Buffer.concat([
      tlv(0xa0, tlv(0x02, Buffer.from([0x0d, 0x3e]))),
      tlv(0xa2, tlv(0x0c, Buffer.from(destination))),
      tlv(0xa3, tlv(0x0c, Buffer.from(ticket))),
      tlv(0xa6, tlv(0x04, X224_REQUEST)),
    ]),
  );
}

/** A control socket that queues server messages so tests can await them in order. */
class Control {
  private readonly queue: DesktopServerMessage[] = [];
  private readonly waiters: Array<(message: DesktopServerMessage) => void> = [];
  readonly socket: WebSocket;
  readonly opened: Promise<void>;

  constructor() {
    this.socket = new WebSocket(`${base}/ws/desktop`, terminalWebSocketProtocols(TOKEN));
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as DesktopServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    cleanups.push(() => this.socket.close());
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The next message that is not a status line. */
  async next(): Promise<DesktopServerMessage> {
    for (;;) {
      const message =
        this.queue.shift() ?? (await new Promise<DesktopServerMessage>((resolve) => this.waiters.push(resolve)));
      if (message.op !== 'status') return message;
    }
  }
}

function openRdpStream(): Promise<{ socket: WebSocket; messages: Buffer[]; next: () => Promise<Buffer> }> {
  // IronRDP opens this socket itself: no bearer-token subprotocol.
  const socket = new WebSocket(`${base}${DESKTOP_RDP_WS_PATH}`);
  const messages: Buffer[] = [];
  const waiters: Array<(data: Buffer) => void> = [];
  socket.on('message', (data: Buffer) => {
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else messages.push(data);
  });
  cleanups.push(() => socket.close());
  return new Promise((resolve, reject) => {
    socket.once('open', () =>
      resolve({
        socket,
        messages,
        next: () => {
          const queued = messages.shift();
          return queued ? Promise.resolve(queued) : new Promise((done) => waiters.push(done));
        },
      }),
    );
    socket.once('error', reject);
  });
}

describe('desktop tickets', () => {
  it('are single use, bound to a protocol, and expire', () => {
    const tickets = new DesktopTickets(50);
    const session = { closed: false } as never;
    const first = tickets.issue(session, 'vnc');
    expect(tickets.redeem(first, 'rdp')).toBeUndefined();
    const second = tickets.issue(session, 'vnc');
    expect(tickets.redeem(second, 'vnc')).toBe(session);
    expect(tickets.redeem(second, 'vnc')).toBeUndefined();
    const closed = tickets.issue({ closed: true } as never, 'rdp');
    expect(tickets.redeem(closed, 'rdp')).toBeUndefined();
  });
});

describe('/ws/desktop', () => {
  it('relays a VNC stream opened with a ticket, once', async () => {
    const port = await fakeVncServer();
    const control = new Control();
    await control.opened;
    control.send({ op: 'connect', profile: { kind: 'vnc', host: '127.0.0.1', port } });
    const ready = await control.next();
    expect(ready).toMatchObject({ op: 'ready', ticket: expect.any(String) });
    const ticket = (ready as Extract<DesktopServerMessage, { op: 'ready' }>).ticket;
    expect(ready).not.toHaveProperty('credentials');

    const protocols = [...terminalWebSocketProtocols(TOKEN), `${DESKTOP_TICKET_PROTOCOL_PREFIX}${ticket}`];
    const stream = new WebSocket(`${base}${DESKTOP_VNC_WS_PATH}`, protocols);
    cleanups.push(() => stream.close());
    const received: string[] = [];
    const greeted = new Promise<void>((resolve) => {
      stream.on('message', (data: Buffer) => {
        received.push(data.toString('utf8'));
        if (received.join('').includes('hello')) resolve();
      });
    });
    await new Promise((resolve) => stream.once('open', resolve));
    stream.send(Buffer.from('hello'));
    await greeted;
    expect(received.join('')).toBe('RFB 003.008\nhello');

    // The ticket is spent: a second stream is refused.
    const replay = new WebSocket(`${base}${DESKTOP_VNC_WS_PATH}`, protocols);
    const code = await new Promise<number>((resolve) => replay.once('close', (closeCode) => resolve(closeCode)));
    expect(code).toBe(1008);
  });

  it('dials a saved host with its current settings and tells the client which', async () => {
    const port = await fakeVncServer();
    const saved = ctx.database.saveSavedHostProfile({
      name: 'design-vm',
      profile: { kind: 'vnc', host: '127.0.0.1', port, viewOnly: true, shareClipboard: false },
    });
    const control = new Control();
    await control.opened;
    // The tab still holds the settings from before the host was edited.
    control.send({
      op: 'connect',
      profile: { kind: 'vnc', profileId: saved.id, host: 'old-name', port: 5900, shareClipboard: true },
    });
    const ready = (await control.next()) as Extract<DesktopServerMessage, { op: 'ready' }>;
    expect(ready.op).toBe('ready');
    expect(ready.profile).toMatchObject({
      kind: 'vnc',
      profileId: saved.id,
      host: '127.0.0.1',
      port,
      viewOnly: true,
      shareClipboard: false,
    });
  });

  it('asks for VNC credentials when the server wants them', async () => {
    const control = new Control();
    await control.opened;
    control.send({ op: 'connect', profile: { kind: 'vnc', host: '127.0.0.1', port: 5900 } });
    expect(await control.next()).toMatchObject({ op: 'ready' });
    control.send({ op: 'credentials-request', types: ['password'] });
    const prompt = await control.next();
    expect(prompt).toMatchObject({
      op: 'auth-prompt',
      name: 'VNC authentication',
      host: '127.0.0.1:5900',
      prompts: [{ prompt: 'Password', echo: false }],
    });
    control.send({ op: 'auth-response', answers: ['secret'] });
    expect(await control.next()).toEqual({ op: 'credentials', credentials: { password: 'secret' } });
  });

  it('refuses a stream socket without a valid ticket', async () => {
    const stream = new WebSocket(`${base}${DESKTOP_VNC_WS_PATH}`, [
      ...terminalWebSocketProtocols(TOKEN),
      `${DESKTOP_TICKET_PROTOCOL_PREFIX}forged`,
    ]);
    const code = await new Promise<number>((resolve) => stream.once('close', (closeCode) => resolve(closeCode)));
    expect(code).toBe(1008);

    const rdp = await openRdpStream();
    rdp.socket.send(rdCleanPathRequest('forged-ticket', '127.0.0.1:3389'));
    const error = await rdp.next();
    // RDCleanPathErr with HTTP status 401.
    expect(error.toString('hex')).toContain('a104020201' + '91');
  });

  it('runs the RDCleanPath handshake, pins the certificate, and relays RDP', async () => {
    const server = await fakeRdpServer(confirmFor(1));
    const control = new Control();
    await control.opened;
    control.send({
      op: 'connect',
      profile: { kind: 'rdp', host: '127.0.0.1', port: server.port, username: 'alice' },
    });
    const prompt = await control.next();
    expect(prompt).toMatchObject({
      op: 'auth-prompt',
      name: 'Remote Desktop logon',
      prompts: [{ prompt: 'Password', echo: false }],
    });
    control.send({ op: 'auth-response', answers: ['hunter2'] });
    const ready = (await control.next()) as Extract<DesktopServerMessage, { op: 'ready' }>;
    expect(ready).toMatchObject({ op: 'ready', credentials: { username: 'alice', password: 'hunter2' } });

    const rdp = await openRdpStream();
    rdp.socket.send(rdCleanPathRequest(ready.ticket, `127.0.0.1:${server.port}`));
    const challenge = await control.next();
    expect(challenge).toMatchObject({
      op: 'certificate',
      host: '127.0.0.1',
      port: server.port,
      state: 'new',
      subject: 'CN=rdp.muxus.test',
      fingerprint: createHash('sha256').update(CERTIFICATE_DER).digest('hex').toUpperCase().match(/../g)!.join(':'),
    });
    control.send({ op: 'certificate-response', accept: true });

    const response = await rdp.next();
    expect(server.requests[0]).toEqual(X224_REQUEST);
    expect(response.includes(confirmFor(1))).toBe(true);
    expect(response.includes(CERTIFICATE_DER)).toBe(true);
    rdp.socket.send(Buffer.from('fastpath'));
    expect((await rdp.next()).toString()).toBe('echo:fastpath');
    rdp.socket.close();

    // Retry: a new ticket, and the pinned certificate is no longer questioned.
    control.send({ op: 'retry' });
    const again = (await control.next()) as Extract<DesktopServerMessage, { op: 'ready' }>;
    expect(again.op).toBe('ready');
    const second = await openRdpStream();
    second.socket.send(rdCleanPathRequest(again.ticket, `127.0.0.1:${server.port}`));
    const secondResponse = await second.next();
    expect(secondResponse.includes(CERTIFICATE_DER)).toBe(true);
  });

  it('pins a VNC server key, asks again when it changes, and ignores keys for RDP', async () => {
    const fingerprint = (seed: string) =>
      createHash('sha256').update(seed).digest('hex').toUpperCase().match(/../g)!.join(':');
    const key = { op: 'server-key', bits: 2048, fingerprint: fingerprint('a'), signature: '01-23-45-67-89-ab-cd-ef' };
    const connect = async (port: number) => {
      const control = new Control();
      await control.opened;
      control.send({ op: 'connect', profile: { kind: 'vnc', host: 'VNC.lab', port } });
      expect(await control.next()).toMatchObject({ op: 'ready' });
      return control;
    };

    const first = await connect(5900);
    first.send(key);
    expect(await first.next()).toEqual({
      op: 'certificate',
      kind: 'rsa-key',
      host: 'VNC.lab',
      port: 5900,
      fingerprint: key.fingerprint,
      bits: 2048,
      signature: key.signature,
      state: 'new',
    });
    first.send({ op: 'certificate-response', accept: true });
    expect(await first.next()).toEqual({ op: 'server-key-verdict', accept: true });
    expect(ctx.database.trustedDesktopIdentity('vnc.lab', 5900)).toEqual({
      fingerprint: key.fingerprint,
      subject: 'RSA 2048-bit key 01-23-45-67-89-ab-cd-ef',
    });

    // The pinned key passes without a prompt; a different one is a warning.
    const second = await connect(5900);
    second.send(key);
    expect(await second.next()).toEqual({ op: 'server-key-verdict', accept: true });
    second.send({ ...key, fingerprint: fingerprint('b') });
    expect(await second.next()).toMatchObject({
      op: 'certificate',
      kind: 'rsa-key',
      state: 'mismatch',
      previous: key.fingerprint,
    });
    second.send({ op: 'certificate-response', accept: false });
    expect(await second.next()).toEqual({ op: 'server-key-verdict', accept: false });
    expect(ctx.database.trustedDesktopIdentity('vnc.lab', 5900)?.fingerprint).toBe(key.fingerprint);

    // Another port is another server.
    const other = await connect(5901);
    other.send(key);
    expect(await other.next()).toMatchObject({ op: 'certificate', state: 'new' });

    // RDP never asks about VNC keys; the next message is the logon prompt's answer.
    const rdp = new Control();
    await rdp.opened;
    rdp.send({ op: 'connect', profile: { kind: 'rdp', host: '127.0.0.1', port: 3389, username: 'alice' } });
    expect(await rdp.next()).toMatchObject({ op: 'auth-prompt' });
    rdp.send(key);
    rdp.send({ op: 'auth-response', answers: ['hunter2'] });
    expect(await rdp.next()).toMatchObject({ op: 'ready' });
  });

  it('survives the server dropping the connection while the certificate prompt is open', async () => {
    const server = await fakeRdpServer(confirmFor(1), { resetAfterTls: true });
    const control = new Control();
    await control.opened;
    control.send({ op: 'connect', profile: { kind: 'rdp', host: '127.0.0.1', port: server.port, username: 'eve' } });
    await control.next();
    control.send({ op: 'auth-response', answers: ['pw'] });
    const ready = (await control.next()) as Extract<DesktopServerMessage, { op: 'ready' }>;
    const rdp = await openRdpStream();
    rdp.socket.send(rdCleanPathRequest(ready.ticket, `127.0.0.1:${server.port}`));
    expect(await control.next()).toMatchObject({ op: 'certificate' });
    // The reset lands while the prompt is still open; answer afterwards.
    await new Promise((resolve) => setTimeout(resolve, 150));
    control.send({ op: 'certificate-response', accept: true });
    const error = await rdp.next();
    // wsa_last_error 10054 (WSAECONNRESET) instead of a crashed server.
    expect(error.toString('hex')).toContain('a2040202' + '2746');
    control.send({ op: 'retry' });
    expect(await control.next()).toMatchObject({ op: 'ready' });
  });

  it('keeps a connected session when remembering its password fails', async () => {
    const control = new Control();
    await control.opened;
    control.send({ op: 'connect', profile: { kind: 'vnc', host: '127.0.0.1', port: 5900 } });
    await control.next();
    control.send({ op: 'credentials-request', types: ['password'] });
    expect(await control.next()).toMatchObject({ op: 'auth-prompt', rememberPassword: { existing: false } });
    control.send({ op: 'auth-response', answers: ['secret'], rememberPassword: true });
    expect(await control.next()).toMatchObject({ op: 'credentials' });
    control.send({ op: 'connected' });
    // No vault yet: creating one is offered, and a mismatched confirmation fails.
    expect(await control.next()).toMatchObject({ op: 'auth-prompt', purpose: 'vault-create' });
    control.send({ op: 'auth-response', answers: ['master-password-1', 'something-else'] });
    const note = await new Promise<DesktopServerMessage>((resolve) => {
      control.socket.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString('utf8')) as DesktopServerMessage;
        if (message.op === 'status') resolve(message);
      });
    });
    expect(note).toMatchObject({ op: 'status', message: expect.stringContaining('could not be remembered') });
    control.send({ op: 'retry' });
    expect(await control.next()).toMatchObject({ op: 'ready' });
  });

  it('passes a server refusal back as a negotiation error', async () => {
    const server = await fakeRdpServer(REFUSAL);
    const control = new Control();
    await control.opened;
    control.send({ op: 'connect', profile: { kind: 'rdp', host: '127.0.0.1', port: server.port, username: 'bob' } });
    await control.next();
    control.send({ op: 'auth-response', answers: ['pw'] });
    const ready = (await control.next()) as Extract<DesktopServerMessage, { op: 'ready' }>;
    const rdp = await openRdpStream();
    rdp.socket.send(rdCleanPathRequest(ready.ticket, `127.0.0.1:${server.port}`));
    const error = await rdp.next();
    // error_code 2 (negotiation) carrying the server's X.224 refusal.
    expect(error.toString('hex')).toContain('a003020102');
    expect(error.includes(REFUSAL)).toBe(true);
  });

  it('reports a refused TCP connection with its socket error', async () => {
    const closed = net.createServer();
    const port = await listen(closed);
    closed.close();
    const control = new Control();
    await control.opened;
    control.send({ op: 'connect', profile: { kind: 'rdp', host: '127.0.0.1', port, username: 'bob' } });
    await control.next();
    control.send({ op: 'auth-response', answers: ['pw'] });
    const ready = (await control.next()) as Extract<DesktopServerMessage, { op: 'ready' }>;
    const rdp = await openRdpStream();
    rdp.socket.send(rdCleanPathRequest(ready.ticket, `127.0.0.1:${port}`));
    const error = await rdp.next();
    // wsa_last_error 10061 (WSAECONNREFUSED).
    expect(error.toString('hex')).toContain('a20402022' + '74d');
  });

  it('rejects terminal profiles and unknown saved hosts', async () => {
    const control = new Control();
    await control.opened;
    control.send({ op: 'connect', profile: { kind: 'rdp', host: 'x', port: 3389, profileId: 'missing' } });
    expect(await control.next()).toMatchObject({ op: 'exit', reason: 'failed', message: 'This saved host no longer exists.' });
  });
});
