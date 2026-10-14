import { EventEmitter } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AntiIdle } from '@muxus/shared';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';

afterEach(() => vi.useRealTimers());

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

  control(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }

  frames(): Array<{ op: string; [key: string]: unknown }> {
    return this.send.mock.calls
      .filter(([frame]) => typeof frame === 'string')
      .map(([frame]) => JSON.parse(String(frame)) as { op: string });
  }
}

const space: AntiIdle = { intervalSeconds: 10, text: ' ', enter: false };

/** Session history that keeps every event the recorder hands it. */
function historyStore() {
  const append = vi.fn(
    (_sessionId: string, _events: Array<{ direction: string; raw: Buffer }>) => true,
  );
  return {
    store: {
      beginSession: () => 'session-1',
      onSessionFailure: () => () => undefined,
      setSessionState: vi.fn(),
      setSessionTitle: vi.fn(),
      finishSession: vi.fn(),
      append,
    },
    input: () =>
      Buffer.concat(
        append.mock.calls.flatMap(([, events]) =>
          events.filter((event) => event.direction === 'input').map((event) => event.raw),
        ),
      ).toString('utf8'),
  };
}

function terminalRoute(ctx: Record<string, unknown>): (socket: TestSocket) => void {
  let route!: (socket: TestSocket) => void;
  const app = {
    get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
      route = handler;
    },
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  registerTerminalSocket(app as never, {
    history: historyStore().store,
    vault: { secrets: () => [] },
    terminalInputs: new TerminalInputs(),
    ...ctx,
  } as never);
  return route;
}

/** An SSH shell for the alias `router` on a mocked channel, with the time each write reached it. */
async function sshSession(database: MuxusDatabase, history = historyStore().store) {
  let loseConnection!: (reason?: string) => void;
  const start = Date.now();
  const written: Array<{ at: number; data: string }> = [];
  const stream = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    write: vi.fn((data: Buffer, callback?: () => void) => {
      written.push({ at: Date.now() - start, data: data.toString('utf8') });
      callback?.();
      return true;
    }),
    setWindow: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  const route = terminalRoute({
    connections: {
      connectShell: vi.fn().mockResolvedValue({
        lease: {
          connection: {
            id: 'connection-1',
            host: 'router.example',
            user: 'admin',
            sftpAvailable: false,
            configForwards: [],
            onHealth: () => () => undefined,
            onClose: (listener: (reason?: string) => void) => {
              loseConnection = listener;
              return () => undefined;
            },
          },
          release: vi.fn(),
        },
        stream,
        transport: 'new',
        summary: {},
      }),
      resolveProfile: (profile: unknown) => profile,
      metadataAliasFor: (profile: { target: string }) => profile.target,
      leaseCount: () => 0,
    },
    forwards: { startConfig: vi.fn(), stop: vi.fn(), stopSessionForConnection: vi.fn() },
    database,
    history,
  });
  const socket = new TestSocket();
  route(socket);
  socket.control({ op: 'connect', profile: { kind: 'ssh', target: 'router' }, cols: 80, rows: 24 });
  await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));
  return {
    socket,
    stream,
    written: () => written.map(({ at, data }) => ({ at: at - written[0]!.at, data })),
    writes: () => written.map(({ data }) => data),
    loseConnection: (reason?: string) => loseConnection(reason),
  };
}

describe('anti-idle over the terminal socket', () => {
  it('types the host text into the SSH channel after each quiet interval', async () => {
    vi.useFakeTimers();
    const database = new MuxusDatabase(':memory:');
    try {
      database.updateOpenSshMetadata('router', { antiIdle: { ...space, text: 'show clock', enter: true } });
      const { socket, writes } = await sshSession(database);

      await vi.advanceTimersByTimeAsync(9_900);
      expect(writes()).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_200);
      expect(writes()).toEqual(['show clock\r', 'show clock\r']);
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    } finally {
      database.close();
    }
  });

  it('starts the wait over on typed input', async () => {
    vi.useFakeTimers();
    const database = new MuxusDatabase(':memory:');
    try {
      database.updateOpenSshMetadata('router', { antiIdle: space });
      const { socket, written } = await sshSession(database);

      await vi.advanceTimersByTimeAsync(8_000);
      socket.emit('message', Buffer.from('s'), true);
      await vi.advanceTimersByTimeAsync(8_000);
      socket.emit('message', Buffer.from('h'), true);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(written()).toEqual([
        { at: 0, data: 's' },
        { at: 8_000, data: 'h' },
        { at: 18_000, data: ' ' },
      ]);
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    } finally {
      database.close();
    }
  });

  it('never types inside a paced paste, and waits a full interval after it', async () => {
    vi.useFakeTimers();
    const database = new MuxusDatabase(':memory:');
    try {
      database.updateOpenSshMetadata('router', { antiIdle: space });
      const { socket, written } = await sshSession(database);

      await vi.advanceTimersByTimeAsync(5_000);
      // The line break waits 11 s, longer than the interval.
      socket.control({ op: 'paste', text: 'ab\ncd', bracketed: false, lineDelayMs: 10_000, charDelayMs: 1_000 });
      await vi.advanceTimersByTimeAsync(40_000);

      const writes = written();
      expect(writes.slice(0, 5)).toEqual([
        { at: 0, data: 'a' },
        { at: 1_000, data: 'b' },
        { at: 2_000, data: '\r' },
        { at: 13_000, data: 'c' },
        { at: 14_000, data: 'd' },
      ]);
      // A full interval after the paste, give or take the second between looks.
      expect(writes[5]?.data).toBe(' ');
      expect(writes[5]!.at).toBeGreaterThanOrEqual(24_000);
      expect(writes[5]!.at).toBeLessThanOrEqual(25_000);
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    } finally {
      database.close();
    }
  });

  it('holds while the login sequence waits for its prompt', async () => {
    vi.useFakeTimers();
    const database = new MuxusDatabase(':memory:');
    try {
      database.updateOpenSshMetadata('router', {
        antiIdle: space,
        loginSequence: {
          steps: [
            { id: '1', kind: 'wait', pattern: '>', timeoutSeconds: 300 },
            { id: '2', kind: 'send', text: 'enable', enter: true },
          ],
        },
      });
      const { socket, stream, written } = await sshSession(database);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(stream.write).not.toHaveBeenCalled();
      stream.emit('data', Buffer.from('router>'));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(written()).toEqual([{ at: 0, data: 'enable\r' }]);
      await vi.advanceTimersByTimeAsync(1_001);
      const [, idle] = written();
      expect(idle?.data).toBe(' ');
      expect(idle!.at).toBeGreaterThanOrEqual(10_000);
      expect(idle!.at).toBeLessThanOrEqual(11_000);
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    } finally {
      database.close();
    }
  });

  it('is recorded as typed input only while input capture is on', async () => {
    vi.useFakeTimers();
    const database = new MuxusDatabase(':memory:');
    try {
      database.updateOpenSshMetadata('router', { antiIdle: space });
      const policy = { enabled: true, maxPartBytes: 1024 * 1024, maxParts: 3, logToFile: false };

      database.saveSessionLoggingPolicy('*', { ...policy, captureInput: true });
      const capturing = historyStore();
      const first = await sshSession(database, capturing.store);
      await vi.advanceTimersByTimeAsync(10_000);
      first.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      expect(first.writes()).toEqual([' ']);
      expect(capturing.input()).toBe(' ');

      database.saveSessionLoggingPolicy('*', { ...policy, captureInput: false });
      const quiet = historyStore();
      const second = await sshSession(database, quiet.store);
      await vi.advanceTimersByTimeAsync(10_000);
      second.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      expect(second.writes()).toEqual([' ']);
      expect(quiet.input()).toBe('');
    } finally {
      database.close();
    }
  });

  it('stops when the tab closes or the connection is lost', async () => {
    vi.useFakeTimers();
    const database = new MuxusDatabase(':memory:');
    try {
      database.updateOpenSshMetadata('router', { antiIdle: space });
      const closed = await sshSession(database);
      await vi.advanceTimersByTimeAsync(10_000);
      closed.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      const lost = await sshSession(database);
      await vi.advanceTimersByTimeAsync(10_000);
      lost.loseConnection('Connection reset by peer');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(closed.writes()).toEqual([' ']);
      expect(lost.writes()).toEqual([' ']);
      expect(lost.socket.frames().some((frame) => frame.op === 'exit')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('types nothing for a host without the setting', async () => {
    vi.useFakeTimers();
    const database = new MuxusDatabase(':memory:');
    try {
      database.updateOpenSshMetadata('router', { pasteLineDelayMs: 100 });
      const { socket, stream } = await sshSession(database);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(stream.write).not.toHaveBeenCalled();
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    } finally {
      database.close();
    }
  });

  it('waits for the first input on a saved Telnet host, which logs in after it opens', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const fromClient: Buffer[] = [];
    const server = net.createServer((connection) => {
      connection.on('data', (data) => fromClient.push(data));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const database = new MuxusDatabase(':memory:');
    const socket = new TestSocket();
    try {
      const telnet = database.saveSavedHostProfile({
        name: 'Core switch',
        profile: { kind: 'telnet', host: '127.0.0.1', port },
      });
      database.updateSavedHostMetadata(telnet.id, { antiIdle: space });
      terminalRoute({ database })(socket);
      socket.control({
        op: 'connect',
        profile: { kind: 'telnet', host: '127.0.0.1', port, profileId: telnet.id },
        cols: 80,
        rows: 24,
      });
      await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));

      // Left at the login prompt: nothing is typed as a username.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(Buffer.concat(fromClient).toString('utf8')).toBe('');

      socket.emit('message', Buffer.from('admin'), true);
      await vi.waitFor(() => expect(Buffer.concat(fromClient).toString('utf8')).toBe('admin'));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(Buffer.concat(fromClient).toString('utf8')).toBe('admin '));
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never looks for a setting on a local terminal', async () => {
    const database = new MuxusDatabase(':memory:');
    const lookup = vi.spyOn(database, 'hostAntiIdle');
    const socket = new TestSocket();
    try {
      terminalRoute({ database })(socket);
      socket.control({
        op: 'connect',
        profile: { kind: 'local', shell: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] },
        cols: 80,
        rows: 24,
      });
      await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });
});
