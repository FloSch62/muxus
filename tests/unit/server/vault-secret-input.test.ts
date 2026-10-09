import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  TERMINAL_SESSION_CLOSE_REASON,
  terminalWebSocketProtocols,
  type TerminalServerMessage,
} from '@muxus/shared/ws-protocol';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import { PasswordVault } from '../../../server/src/security/password-vault.js';
import { MemoryVaultKeyStore } from '../../../server/src/security/vault-key-store.js';
import {
  secretKeystrokes,
  typeVaultSecret,
} from '../../../server/src/security/vault-secret-input.js';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';

const TOKEN = 'vault-secret-input-token';
const MASTER = 'master-pass-12';
const SECRET = 'enable-Secret-4711';
const TYPED = 'typed-by-hand';

/**
 * The remote side of a password prompt: like `read -s`, it reads a line
 * without echoing it and answers with a digest, so the test can tell the
 * secret arrived (Enter included) while it never appears in the output.
 */
const SILENT_PROMPT = `
process.stdin.setRawMode(true);
let line = Buffer.alloc(0);
process.stdout.write('Password: ');
process.stdin.on('data', (chunk) => {
  line = Buffer.concat([line, chunk]);
  let end;
  while ((end = line.indexOf(13)) >= 0) {
    const digest = require('node:crypto').createHash('sha256').update(line.subarray(0, end)).digest('hex').slice(0, 16);
    line = line.subarray(end + 1);
    process.stdout.write('\\r\\nreceived ' + digest + '\\r\\nPassword: ');
  }
});
`;

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

let built: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let scratch: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'muxus-vault-secret-'));
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
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  await built.app.close();
  rmSync(scratch, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function api<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await built.app.inject({ method, url, headers: auth(), payload: payload as never });
  return { status: response.statusCode, body: response.json() as T, raw: response.body };
}

async function createSecret(policy: 'never' | 'credential' = 'never'): Promise<string> {
  await api('POST', '/api/password-vault/create', { password: MASTER, unlockPolicy: policy });
  const created = await api<{ secret: { id: string } }>('POST', '/api/password-vault/secrets', {
    name: 'Core enable',
    value: SECRET,
    masterPassword: MASTER,
  });
  expect(created.status).toBe(200);
  expect(created.raw).not.toContain(SECRET);
  return created.body.secret.id;
}

/** A live local session running the silent prompt, as the renderer would open it. */
async function openPromptSession(): Promise<{
  socket: WebSocket;
  terminalId: string;
  output: () => string;
  messages: TerminalServerMessage[];
}> {
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
  socket.send(
    JSON.stringify({
      op: 'connect',
      profile: { kind: 'local', shell: process.execPath, args: ['-e', SILENT_PROMPT] },
      title: 'Router',
      cols: 80,
      rows: 24,
    }),
  );
  await vi.waitFor(() => expect(messages.some((message) => message.op === 'ready')).toBe(true));
  const session = messages.find((message) => message.op === 'session');
  await vi.waitFor(() => expect(output).toContain('Password: '), { timeout: 10_000 });
  return {
    socket,
    terminalId: session && session.op === 'session' ? session.terminalId : '',
    output: () => output,
    messages,
  };
}

describe('typing vault secrets into sessions', () => {
  it('types the secret like a keypress but keeps it out of history, log files and app logs', async () => {
    const secretId = await createSecret();
    await api('PUT', '/api/logs/settings', { debugEnabled: true });
    const session = await openPromptSession();
    const logFile = path.join(scratch, 'router.log');
    session.socket.send(
      JSON.stringify({
        op: 'set-logging',
        enabled: true,
        captureInput: true,
        logToFile: true,
        logFilePath: logFile,
      }),
    );
    await vi.waitFor(() =>
      expect(
        session.messages.some(
          (message) => message.op === 'logging-state' && message.enabled && message.captureInput && !!message.filePath,
        ),
      ).toBe(true),
    );

    // Typed input is recorded, which is what makes the secret's absence meaningful.
    session.socket.send(Buffer.from(`${TYPED}\r`));
    await vi.waitFor(() => expect(session.output()).toContain(`received ${digest(TYPED)}`));

    const sent = await api<{ sent: number }>('POST', `/api/password-vault/secrets/${secretId}/send`, {
      terminalIds: [session.terminalId],
      enter: true,
    });
    expect(sent).toMatchObject({ status: 200, body: { sent: 1 } });
    await vi.waitFor(() => expect(session.output()).toContain(`received ${digest(SECRET)}`));
    expect(session.output()).not.toContain(SECRET);
    const appLogs = await api('GET', '/api/logs');
    expect(appLogs.raw).not.toContain(SECRET);

    const logState = session.messages.findLast((message) => message.op === 'logging-state');
    const historyId = logState?.op === 'logging-state' ? logState.sessionId : undefined;
    expect(historyId).toBeTruthy();
    session.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);

    await vi.waitFor(async () => {
      const typed = await api<{ sessions: unknown[] }>('GET', `/api/session-history?query=${TYPED}`);
      expect(typed.body.sessions).toHaveLength(1);
    });
    const leaked = await api<{ sessions: unknown[] }>('GET', `/api/session-history?query=${SECRET}`);
    expect(leaked.body.sessions).toEqual([]);
    const raw = await built.app.inject({
      method: 'GET',
      url: `/api/session-history/${historyId}/raw`,
      headers: auth(),
    });
    const recorded = raw.body
      .trim()
      .split('\n')
      .map((line) => Buffer.from((JSON.parse(line) as { data: string }).data, 'base64').toString('utf8'))
      .join('');
    expect(recorded).toContain(TYPED);
    expect(recorded).toContain(`received ${digest(SECRET)}`);
    expect(recorded).not.toContain(SECRET);

    await vi.waitFor(() => expect(readFileSync(logFile, 'utf8')).toContain(`received ${digest(SECRET)}`));
    const logText = readFileSync(logFile, 'utf8');
    expect(logText).toContain(TYPED);
    expect(logText).not.toContain(SECRET);
  });

  it('mirrors the secret to every session it is sent to', async () => {
    const secretId = await createSecret();
    const first = await openPromptSession();
    const second = await openPromptSession();

    const sent = await api<{ sent: number }>('POST', `/api/password-vault/secrets/${secretId}/send`, {
      terminalIds: [first.terminalId, second.terminalId, 'terminal-gone'],
      enter: false,
    });
    expect(sent).toMatchObject({ status: 200, body: { sent: 2 } });
    for (const session of [first, second]) session.socket.send(Buffer.from('\r'));
    for (const session of [first, second]) {
      await vi.waitFor(() => expect(session.output()).toContain(`received ${digest(SECRET)}`));
    }
  });

  it('asks for the master password under the per-use policy and reports what went wrong', async () => {
    const secretId = await createSecret('credential');
    const session = await openPromptSession();
    const send = (body: Record<string, unknown>, id = secretId) =>
      api<{ code?: string; sent?: number }>('POST', `/api/password-vault/secrets/${id}/send`, {
        terminalIds: [session.terminalId],
        enter: true,
        ...body,
      });

    expect(await send({})).toMatchObject({ status: 423, body: { code: 'vault-locked' } });
    expect(await send({ masterPassword: 'incorrect-pass' })).toMatchObject({
      status: 401,
      body: { code: 'invalid-master-password' },
    });
    expect(await send({ masterPassword: MASTER })).toMatchObject({ status: 200, body: { sent: 1 } });
    await vi.waitFor(() => expect(session.output()).toContain(`received ${digest(SECRET)}`));

    expect(await send({}, 'secret-gone')).toMatchObject({
      status: 404,
      body: { code: 'vault-secret-missing' },
    });
    expect(
      await api('POST', `/api/password-vault/secrets/${secretId}/send`, {
        terminalIds: ['terminal-gone'],
        enter: true,
        masterPassword: MASTER,
      }),
    ).toMatchObject({ status: 409, body: { code: 'terminal-unavailable' } });

    session.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    await vi.waitFor(async () =>
      expect(await send({ masterPassword: MASTER })).toMatchObject({
        status: 409,
        body: { code: 'terminal-unavailable' },
      }),
    );
  });
});

describe('vault secret keystrokes', () => {
  it('types the value and an optional Enter', async () => {
    expect(secretKeystrokes('pa ss', false).toString()).toBe('pa ss');
    expect(secretKeystrokes('pa ss', true).toString()).toBe('pa ss\r');

    const database = new MuxusDatabase(':memory:');
    const vault = new PasswordVault(database, {
      kdf: { cost: 1024, blockSize: 8, parallelism: 1 },
      keyStore: new MemoryVaultKeyStore(),
    });
    try {
      await vault.initialize();
      await vault.create(MASTER, 'never');
      const secret = await vault.createSecret({ name: 'Enable', value: SECRET }, MASTER);
      const inputs = new TerminalInputs();
      const written: string[] = [];
      inputs.register('live', (data) => {
        written.push(data.toString());
        return true;
      });
      const closed = inputs.register('closed', () => false);
      closed();

      const writers = ['live', 'closed'].flatMap((id) => inputs.writer(id) ?? []);
      await expect(typeVaultSecret(vault, secret.id, writers, { enter: true })).resolves.toBe(1);
      expect(written).toEqual([`${SECRET}\r`]);
      await expect(typeVaultSecret(vault, 'gone', writers, { enter: true })).resolves.toBeUndefined();
    } finally {
      vault.dispose();
      database.close();
    }
  });
});
