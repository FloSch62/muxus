import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import { SshConnectionManager } from '../../../server/src/ssh/connection-manager.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';

class TestSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly send = vi.fn();
  readonly ping = vi.fn();

  close(code?: number, reason?: string): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close', code ?? 1005, Buffer.from(reason ?? ''));
  }

  frames(): Array<{ op: string; terminalId?: string }> {
    return this.send.mock.calls
      .filter(([frame]) => typeof frame === 'string')
      .map(([frame]) => JSON.parse(String(frame)) as { op: string });
  }
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'muxus-host-keys-'));
const sshConfig = path.join(scratch, 'config');
writeFileSync(
  sshConfig,
  [
    'Host console con',
    '  HostName console.example',
    '',
    'Host *.lab',
    '  User admin',
    '',
    'Host web',
    '  HostName web.example',
    '',
    'Host db',
    '  HostName db.example',
    '',
    'Host web db cache',
    '  User admin',
    '',
  ].join('\n'),
);
/** Finds aliases in that ssh_config as the server does. */
const aliases = new SshConnectionManager({} as never, {
  loadConfig: () => loadConfigDocument(sshConfig),
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let database: MuxusDatabase | undefined;
afterEach(() => {
  database?.close();
  database = undefined;
});

/** A terminal session as the socket opens it, with the backend's input target for it. */
async function openSession(
  db: MuxusDatabase,
  profile: Record<string, unknown>,
  connections: Record<string, unknown> = {},
) {
  let route!: (socket: TestSocket) => void;
  const app = {
    get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
      route = handler;
    },
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const terminalInputs = new TerminalInputs();
  registerTerminalSocket(
    app as never,
    {
      connections: {
        resolveProfile: (resolved: unknown) => resolved,
        metadataAliasFor: (resolved: SshProfile) => aliases.metadataAliasFor(resolved),
        listedMetadataAliasFor: (resolved: SshProfile) => aliases.listedMetadataAliasFor(resolved),
        leaseCount: () => 0,
        ...connections,
      },
      forwards: { startConfig: vi.fn(), stop: vi.fn(), stopSessionForConnection: vi.fn() },
      database: db,
      history: { append: vi.fn() },
      terminalInputs,
    } as never,
  );

  const socket = new TestSocket();
  route(socket);
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ op: 'connect', profile, cols: 80, rows: 24 })),
    false,
  );
  await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));
  const terminalId = socket.frames().find((frame) => frame.op === 'session')?.terminalId ?? '';
  return {
    enterKey: () => terminalInputs.target(terminalId)?.enterKey,
    close: () => socket.close(1000, TERMINAL_SESSION_CLOSE_REASON),
  };
}

/** An SSH session over a mocked transport, with the options its shell opened with. */
async function sshSession(db: MuxusDatabase, profile: Record<string, unknown>) {
  const connectShell = vi.fn().mockResolvedValue({
    lease: {
      connection: {
        id: 'connection-1',
        host: 'console.example',
        user: 'admin',
        sftpAvailable: false,
        configForwards: [],
        onHealth: () => () => undefined,
        onClose: () => () => undefined,
      },
      release: vi.fn(),
    },
    stream: Object.assign(new EventEmitter(), {
      close: vi.fn(),
      write: vi.fn(),
      setWindow: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    }),
    transport: 'new',
    summary: {},
  });
  const session = await openSession(db, { kind: 'ssh', ...profile }, { connectShell });
  return { ...session, shellOptions: connectShell.mock.calls[0]![5] as { backspaceKey?: string } };
}

/** The options an SSH session to this profile opens its shell with. */
async function shellOptions(db: MuxusDatabase, profile: Record<string, unknown>) {
  const session = await sshSession(db, profile);
  session.close();
  return session.shellOptions;
}

describe("SSH sessions advertise the host's Backspace as the pty erase character", () => {
  it('asks for ^H for an OpenSSH alias set to send it, under any of its names', async () => {
    database = new MuxusDatabase(':memory:');
    database.updateOpenSshMetadata('console', { backspaceKey: 'ctrl-h' });

    for (const target of ['console', 'con']) {
      expect(await shellOptions(database, { target })).toMatchObject({ backspaceKey: 'ctrl-h' });
    }
  });

  it('asks for ^H for a Muxus-owned SSH host set to send it', async () => {
    database = new MuxusDatabase(':memory:');
    const saved = database.saveSavedHostProfile({
      name: 'Console',
      profile: { kind: 'ssh', target: 'console.example', useConfig: false },
    });
    database.updateSavedHostMetadata(saved.id, { backspaceKey: 'ctrl-h' });

    expect(
      await shellOptions(database, {
        target: 'console.example',
        useConfig: false,
        profileId: saved.id,
      }),
    ).toMatchObject({ backspaceKey: 'ctrl-h' });
  });

  it('leaves the pty request as it was for hosts without the setting', async () => {
    database = new MuxusDatabase(':memory:');
    database.updateOpenSshMetadata('router', { pasteLineDelayMs: 100 });

    expect((await shellOptions(database, { target: 'router' })).backspaceKey).toBeUndefined();
    expect((await shellOptions(database, { target: 'unknown' })).backspaceKey).toBeUndefined();
  });

  it('keeps DEL where the window keeps it: another user or port is not the alias', async () => {
    database = new MuxusDatabase(':memory:');
    database.updateOpenSshMetadata('console', { backspaceKey: 'ctrl-h' });

    for (const target of ['x@console', 'console:2222', 'x@con:2222', 'web.lab']) {
      expect((await shellOptions(database, { target })).backspaceKey).toBeUndefined();
    }
  });

  it('uses the host the window finds when Host blocks repeat an alias', async () => {
    database = new MuxusDatabase(':memory:');
    // The host list sorts by alias, so "cache" comes before "db" and "web" and names both.
    database.updateOpenSshMetadata('db', { backspaceKey: 'ctrl-h' });
    database.updateOpenSshMetadata('web', { backspaceKey: 'ctrl-h' });

    for (const target of ['db', 'web', 'cache']) {
      expect((await shellOptions(database, { target })).backspaceKey).toBeUndefined();
    }
    database.updateOpenSshMetadata('cache', { backspaceKey: 'ctrl-h' });
    for (const target of ['db', 'web', 'cache']) {
      expect(await shellOptions(database, { target })).toMatchObject({ backspaceKey: 'ctrl-h' });
    }
  });
});

describe("text the backend types presses the host's Enter key", () => {
  it('reads it for an OpenSSH alias the tab dialed, at the time it types', async () => {
    database = new MuxusDatabase(':memory:');
    database.updateOpenSshMetadata('console', { enterKey: 'lf' });

    const session = await sshSession(database, { target: 'con' });
    expect(session.enterKey()).toBe('lf');
    database.updateOpenSshMetadata('console', { enterKey: 'crlf' });
    expect(session.enterKey()).toBe('crlf');
    database.updateOpenSshMetadata('console', { enterKey: null });
    expect(session.enterKey()).toBe('cr');
    session.close();
    expect(session.enterKey()).toBeUndefined();

    const otherUser = await sshSession(database, { target: 'x@console' });
    database.updateOpenSshMetadata('console', { enterKey: 'lf' });
    expect(otherUser.enterKey()).toBe('cr');
    otherUser.close();
  });

  it('reads it from the host the window finds when Host blocks repeat an alias', async () => {
    database = new MuxusDatabase(':memory:');
    database.updateOpenSshMetadata('db', { enterKey: 'lf' });

    const session = await sshSession(database, { target: 'db' });
    expect(session.enterKey()).toBe('cr');
    database.updateOpenSshMetadata('cache', { enterKey: 'crlf' });
    expect(session.enterKey()).toBe('crlf');
    session.close();
  });

  it('reads it for a saved SSH host', async () => {
    database = new MuxusDatabase(':memory:');
    const saved = database.saveSavedHostProfile({
      name: 'Console',
      profile: { kind: 'ssh', target: 'console.example', useConfig: false },
    });
    database.updateSavedHostMetadata(saved.id, { enterKey: 'lf' });

    const session = await sshSession(database, {
      target: 'console.example',
      useConfig: false,
      profileId: saved.id,
    });
    expect(session.enterKey()).toBe('lf');
    session.close();
  });

  it('reads it for a saved Telnet host', async () => {
    database = new MuxusDatabase(':memory:');
    const server = net.createServer((connection) => connection.on('error', () => undefined));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const sessions: Array<{ close(): void }> = [];
    try {
      const saved = database.saveSavedHostProfile({
        name: 'Console server',
        profile: { kind: 'telnet', host: '127.0.0.1', port },
      });
      database.updateSavedHostMetadata(saved.id, { enterKey: 'crlf' });

      const host = await openSession(database, {
        kind: 'telnet',
        host: '127.0.0.1',
        port,
        profileId: saved.id,
      });
      sessions.push(host);
      const adHoc = await openSession(database, { kind: 'telnet', host: '127.0.0.1', port });
      sessions.push(adHoc);
      expect(host.enterKey()).toBe('crlf');
      expect(adHoc.enterKey()).toBe('cr');
    } finally {
      for (const session of sessions) session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
