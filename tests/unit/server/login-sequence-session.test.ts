import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { LoginSequence, SavedHostProfile } from '@muxus/shared';
import {
  TERMINAL_SESSION_CLOSE_REASON,
  terminalWebSocketProtocols,
  type TerminalServerMessage,
} from '@muxus/shared/ws-protocol';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'login-sequence-session-token';
const MASTER = 'master-pass-12';
const SECRET = 'enable-Secret-4711';

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * A console server behind Telnet: a banner that must be answered with
 * RETURN, a user name, then a password prompt that comes a beat later and,
 * like a real one, does not echo. Telnet negotiation from the client is
 * ignored.
 */
function startFakeConsole(): Promise<{ server: net.Server; port: number; connections: () => number }> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    let stage: 'banner' | 'user' | 'password' | 'shell' = 'banner';
    let line = '';
    let iac = 0;
    socket.on('error', () => undefined);
    socket.write('\x1b[1mcore-sw1 console\x1b[0m\r\nPress RET');
    setTimeout(() => socket.write('URN to get started.'), 40);
    socket.on('data', (data: Buffer) => {
      for (const byte of data) {
        // IAC WILL/WONT/DO/DONT <option> and IAC SB … IAC SE.
        if (iac > 0) {
          if (iac === 1) iac = byte === 250 ? 3 : byte >= 251 ? 2 : 0;
          else if (iac === 2) iac = 0;
          else if (byte === 240) iac = 0;
          continue;
        }
        if (byte === 255) {
          iac = 1;
          continue;
        }
        if (byte === 0 || byte === 10) continue;
        if (byte !== 13) {
          line += String.fromCharCode(byte);
          if (stage !== 'password') socket.write(Buffer.from([byte]));
          continue;
        }
        const entered = line;
        line = '';
        if (stage === 'banner') {
          stage = 'user';
          socket.write('\r\n\r\nUsername: ');
        } else if (stage === 'user') {
          stage = 'password';
          socket.write('\r\n');
          setTimeout(() => socket.write('Pass'), 60);
          setTimeout(() => socket.write('word: '), 90);
        } else if (stage === 'password') {
          if (entered === SECRET) {
            stage = 'shell';
            socket.write('\r\ncore-sw1>');
          } else {
            socket.write('\r\n% Access denied\r\nPassword: ');
          }
        } else {
          socket.write(`\r\nreceived ${digest(entered)}\r\ncore-sw1>`);
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, connections: () => connections }),
    );
  });
}

let built: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let scratch: string;
let device: Awaited<ReturnType<typeof startFakeConsole>>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'muxus-login-sequence-'));
  vi.stubEnv('HOME', scratch);
  built = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  );
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  base = `127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
  device = await startFakeConsole();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  await built.app.close();
  await new Promise((resolve) => device.server.close(resolve));
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
  const response = await built.app.inject({ method, url, headers: auth(), payload: payload as never });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
  return { body: response.json() as T, raw: response.body };
}

async function createSecret(policy: 'never' | 'credential'): Promise<string> {
  await api('POST', '/api/password-vault/create', { password: MASTER, unlockPolicy: policy });
  const created = await api<{ secret: { id: string } }>('POST', '/api/password-vault/secrets', {
    name: 'Console password',
    value: SECRET,
    masterPassword: MASTER,
  });
  return created.body.secret.id;
}

async function telnetHost(metadata: Record<string, unknown> = {}): Promise<SavedHostProfile> {
  const saved = await api<SavedHostProfile>('PUT', '/api/profiles', {
    name: 'core-sw1',
    profile: { kind: 'telnet', host: '127.0.0.1', port: device.port },
  });
  await api('PATCH', `/api/profiles/${saved.body.id}/metadata`, { group: 'Network/Consoles', ...metadata });
  return saved.body;
}

function loginSteps(secretId: string): LoginSequence {
  return {
    steps: [
      { id: '1', kind: 'wait', pattern: 'Press RETURN', timeoutSeconds: 5 },
      { id: '2', kind: 'send', text: '', enter: true },
      { id: '3', kind: 'wait', pattern: 'Username:', timeoutSeconds: 5 },
      { id: '4', kind: 'send', text: 'admin', enter: true },
      // The prompt arrives in two chunks, and only after a pause.
      { id: '5', kind: 'wait', pattern: '[Pp]assword:\\s*$', regex: true, timeoutSeconds: 5 },
      { id: '6', kind: 'secret', secretId, enter: true },
    ],
  };
}

interface Session {
  socket: WebSocket;
  terminalId: string;
  output: () => string;
  messages: TerminalServerMessage[];
  sequence: () => Array<Extract<TerminalServerMessage, { op: 'login-sequence' }>>;
}

async function openSocket(first: object): Promise<Omit<Session, 'terminalId'>> {
  const socket = new WebSocket(`ws://${base}/ws/terminal`, terminalWebSocketProtocols(TOKEN));
  sockets.push(socket);
  const messages: TerminalServerMessage[] = [];
  let output = '';
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) output += data.toString('utf8');
    else messages.push(JSON.parse(data.toString('utf8')) as TerminalServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify(first));
  return {
    socket,
    output: () => output,
    messages,
    sequence: () =>
      messages.filter(
        (message): message is Extract<TerminalServerMessage, { op: 'login-sequence' }> =>
          message.op === 'login-sequence',
      ),
  };
}

async function connect(host: SavedHostProfile): Promise<Session> {
  const session = await openSocket({
    op: 'connect',
    profile: { kind: 'telnet', profileId: host.id, host: '127.0.0.1', port: device.port },
    title: 'core-sw1',
    cols: 80,
    rows: 24,
  });
  await vi.waitFor(() => expect(session.messages.some((message) => message.op === 'ready')).toBe(true));
  const announced = session.messages.find((message) => message.op === 'session');
  return { ...session, terminalId: announced?.op === 'session' ? announced.terminalId : '' };
}

describe('login sequences on a live session', () => {
  it('answers the prompts with a folder sequence and keeps the vault secret out of every record', async () => {
    const secretId = await createSecret('never');
    await api('PUT', '/api/folders/settings', { path: 'Network', auth: {}, loginSequence: loginSteps(secretId) });
    const host = await telnetHost();
    await api('PUT', '/api/session-history/log-files', {
      directory: scratch,
      filenamePattern: '{title}.log',
      timestamps: false,
    });
    await api('PUT', `/api/session-history/policy?profileKey=${encodeURIComponent(`profile:${host.id}`)}`, {
      enabled: true,
      captureInput: true,
      maxPartBytes: 1024 * 1024,
      maxParts: 2,
      logToFile: true,
    });

    const session = await connect(host);
    await vi.waitFor(() => expect(session.sequence().at(-1)?.state).toBe('done'), { timeout: 10_000 });
    // The sequence was announced before the tab was told the session is ready.
    const firstStep = session.messages.findIndex((message) => message.op === 'login-sequence');
    expect(firstStep).toBeLessThan(session.messages.findIndex((message) => message.op === 'ready'));
    expect(session.sequence().map(({ state, step, detail }) => `${state} ${step} ${detail}`)).toEqual([
      'running 1 Waiting for “Press RETURN”',
      'running 2 Pressing Enter',
      'running 3 Waiting for “Username:”',
      'running 4 Typing “admin” and Enter',
      'running 5 Waiting for a match of “[Pp]assword:\\s*$”',
      'running 6 Typing the secret “Console password” and Enter',
      'done 6 Typing the secret “Console password” and Enter',
    ]);
    await vi.waitFor(() => expect(session.output()).toContain('core-sw1>'));
    expect(session.output()).not.toContain('Access denied');
    expect(session.output()).not.toContain(SECRET);

    // The session is the user's from here on.
    session.socket.send(Buffer.from('show version\r'));
    await vi.waitFor(() => expect(session.output()).toContain(`received ${digest('show version')}`));

    const logState = session.messages.findLast((message) => message.op === 'logging-state');
    const historyId = logState?.op === 'logging-state' ? logState.sessionId : undefined;
    expect(historyId).toBeTruthy();
    session.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);

    await vi.waitFor(async () => {
      const typed = await api<{ sessions: unknown[] }>('GET', '/api/session-history?query=admin');
      expect(typed.body.sessions).toHaveLength(1);
    });
    const leaked = await api<{ sessions: unknown[] }>('GET', `/api/session-history?query=${SECRET}`);
    expect(leaked.body.sessions).toEqual([]);
    const raw = await built.app.inject({ method: 'GET', url: `/api/session-history/${historyId}/raw`, headers: auth() });
    const recorded = raw.body
      .trim()
      .split('\n')
      .map((line) => Buffer.from((JSON.parse(line) as { data: string }).data, 'base64').toString('utf8'))
      .join('');
    expect(recorded).toContain('admin\r');
    expect(recorded).toContain('core-sw1>');
    expect(recorded).not.toContain(SECRET);

    const [logFile] = readdirSync(scratch).filter((name) => name.endsWith('.log'));
    expect(logFile).toBeDefined();
    await vi.waitFor(() => expect(readFileSync(path.join(scratch, logFile!), 'utf8')).toContain('core-sw1>'));
    const logText = readFileSync(path.join(scratch, logFile!), 'utf8');
    expect(logText).toContain('admin');
    expect(logText).not.toContain(SECRET);
    const appLogs = await api('GET', '/api/logs');
    expect(appLogs.raw).not.toContain(SECRET);
  });

  it('stops at a step that times out and leaves the session open', async () => {
    const host = await telnetHost({
      loginSequence: {
        steps: [
          { id: '1', kind: 'wait', pattern: 'Login:', timeoutSeconds: 1 },
          { id: '2', kind: 'send', text: 'admin', enter: true },
        ],
      },
    });
    const session = await connect(host);
    await vi.waitFor(() => expect(session.sequence().at(-1)?.state).toBe('failed'), { timeout: 5_000 });
    expect(session.sequence().at(-1)).toMatchObject({
      step: 1,
      steps: 2,
      message: 'Step 1 timed out after 1 s waiting for “Login:”.',
    });
    expect(session.messages.some((message) => message.op === 'exit')).toBe(false);
    session.socket.send(Buffer.from('\r'));
    await vi.waitFor(() => expect(session.output()).toContain('Username: '));
    expect(session.output()).not.toContain('admin');
  });

  it('cancels on request, runs again on a new connect and not on a renderer reattach', async () => {
    const host = await telnetHost({
      loginSequence: {
        steps: [
          { id: '1', kind: 'wait', pattern: 'Press RETURN', timeoutSeconds: 5 },
          { id: '2', kind: 'send', text: '', enter: true },
          { id: '3', kind: 'wait', pattern: 'never shown', timeoutSeconds: 60 },
        ],
      },
    });
    const first = await connect(host);
    await vi.waitFor(() => expect(first.sequence().at(-1)?.step).toBe(3));
    await vi.waitFor(() => expect(first.output()).toContain('Username: '));

    // A renderer that drops and comes back reattaches to the same session.
    first.socket.close(4000, 'renderer reload');
    const again = await openSocket({ op: 'attach', terminalId: first.terminalId, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(again.messages.some((message) => message.op === 'ready')).toBe(true));
    expect(again.sequence()).toEqual([expect.objectContaining({ state: 'running', step: 3 })]);
    expect(device.connections()).toBe(1);

    again.socket.send(JSON.stringify({ op: 'cancel-login-sequence' }));
    await vi.waitFor(() => expect(again.sequence().at(-1)).toMatchObject({ state: 'cancelled', step: 3, steps: 3 }));
    again.socket.send(Buffer.from('operator\r'));
    await vi.waitFor(() => expect(again.output()).toContain('operator'));

    // A reconnect is a new session, and the sequence starts over.
    const reconnected = await connect(host);
    await vi.waitFor(() => expect(reconnected.sequence().at(-1)?.step).toBe(3));
    expect(device.connections()).toBe(2);
    expect(reconnected.sequence()[0]).toMatchObject({ state: 'running', step: 1 });
  });

  it('asks for the master password when the vault prompts for every use', async () => {
    const secretId = await createSecret('credential');
    const host = await telnetHost({ loginSequence: loginSteps(secretId) });
    const session = await connect(host);
    await vi.waitFor(
      () => expect(session.messages.some((message) => message.op === 'auth-prompt')).toBe(true),
      { timeout: 10_000 },
    );
    const prompt = session.messages.find((message) => message.op === 'auth-prompt');
    expect(prompt).toMatchObject({ purpose: 'vault-unlock', skipLabel: 'Stop login sequence' });
    // A resize while the prompt is open is handled normally, not taken as the answer.
    session.socket.send(JSON.stringify({ op: 'resize', cols: 100, rows: 30 }));
    session.socket.send(JSON.stringify({ op: 'auth-response', answers: ['wrong-master'] }));
    await vi.waitFor(() =>
      expect(session.messages.filter((message) => message.op === 'auth-prompt')).toHaveLength(2),
    );
    expect(session.messages.filter((message) => message.op === 'auth-prompt')[1]).toMatchObject({
      instructions: expect.stringMatching(/master password/i),
    });
    session.socket.send(JSON.stringify({ op: 'auth-response', answers: [MASTER] }));
    await vi.waitFor(() => expect(session.sequence().at(-1)?.state).toBe('done'));
    await vi.waitFor(() => expect(session.output()).toContain('core-sw1>'));
  });

  it('stops when the user declines to unlock the vault', async () => {
    const secretId = await createSecret('credential');
    const host = await telnetHost({ loginSequence: loginSteps(secretId) });
    const session = await connect(host);
    await vi.waitFor(
      () => expect(session.messages.some((message) => message.op === 'auth-prompt')).toBe(true),
      { timeout: 10_000 },
    );
    session.socket.send(JSON.stringify({ op: 'auth-response', answers: [], skipped: true }));
    await vi.waitFor(() =>
      expect(session.sequence().at(-1)).toMatchObject({
        state: 'failed',
        step: 6,
        message: 'Step 6: the password vault stayed locked.',
      }),
    );
    expect(session.messages.some((message) => message.op === 'exit')).toBe(false);
  });

  it('runs nothing for a host that switches the folder sequence off', async () => {
    await api('PUT', '/api/folders/settings', {
      path: 'Network',
      auth: {},
      loginSequence: { steps: [{ id: '1', kind: 'send', text: 'from-folder', enter: true }] },
    });
    const host = await telnetHost({ loginSequence: { steps: [] } });
    const session = await connect(host);
    await vi.waitFor(() => expect(session.output()).toContain('Press RETURN'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(session.sequence()).toEqual([]);
    expect(session.output()).not.toContain('from-folder');
  });
});
