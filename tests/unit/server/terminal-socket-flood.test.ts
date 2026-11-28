import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';

/** The local shell's PTY, played by the test. */
const shell = vi.hoisted(() => {
  const state: {
    output?: (data: string) => void;
    exit?: (event: { exitCode: number }) => void;
  } = {};
  return {
    state,
    pty: {
      // A process that is still running, as the shell is until the test says otherwise.
      pid: process.pid,
      onData: (listener: (data: string) => void) => {
        state.output = listener;
        return { dispose: () => undefined };
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        state.exit = listener;
        return { dispose: () => undefined };
      },
      pause: vi.fn(),
      resume: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    },
  };
});

vi.mock('../../../server/src/local/pty-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/src/local/pty-manager.js')>()),
  spawnLocalPty: () => ({ pty: shell.pty, shell: '/bin/sh' }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const MiB = 1024 * 1024;

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

  /** Terminal output frames, as text. */
  output(): string[] {
    return this.send.mock.calls
      .filter(([frame]) => Buffer.isBuffer(frame))
      .map(([frame]) => (frame as Buffer).toString('utf8'));
  }
}

/** Session history whose writer keeps what it is given until `drain`, in an 8 MiB queue like the worker's. */
function slowHistory() {
  let queued = 0;
  const store = {
    beginSession: () => 'session-1',
    onSessionFailure: () => () => undefined,
    setSessionState: vi.fn(),
    setSessionTitle: vi.fn(),
    finishSession: vi.fn(),
    append: (_sessionId: string, events: Array<{ raw: Buffer }>) => {
      const bytes = events.reduce((total, event) => total + event.raw.byteLength, 0);
      if (queued + bytes > 8 * MiB) return false;
      queued += bytes;
      return true;
    },
    get behind() {
      return queued > 4 * MiB;
    },
    stalled: false,
    stalledFor(): boolean {
      return this.stalled;
    },
  };
  return { store, drain: () => (queued = 0) };
}

function recordEverything(database: MuxusDatabase): void {
  database.saveSessionLoggingPolicy('*', {
    enabled: true,
    captureInput: false,
    logToFile: false,
    maxPartBytes: 64 * MiB,
    maxParts: 10,
  });
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
    vault: { secrets: () => [] },
    terminalInputs: new TerminalInputs(),
    ...ctx,
  } as never);
  return route;
}

async function localShell(database: MuxusDatabase, history = slowHistory().store): Promise<TestSocket> {
  const socket = new TestSocket();
  terminalRoute({ database, history })(socket);
  socket.control({ op: 'connect', profile: { kind: 'local' }, cols: 80, rows: 24 });
  await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));
  return socket;
}

/** 64 KiB a millisecond, until the server pauses the source or 16 MiB went out. */
async function flood(emit: (chunk: string) => void, paused: () => boolean) {
  const chunk = 'x'.repeat(64 * 1024);
  for (let sent = 0; sent < 256 && !paused(); sent++) {
    emit(chunk);
    await vi.advanceTimersByTimeAsync(1);
  }
}

describe('local shell output', () => {
  it('sends what the shell prints within a millisecond as one frame', async () => {
    const database = new MuxusDatabase(':memory:');
    const socket = await localShell(database);
    try {
      shell.state.output!('one\r\n');
      shell.state.output!('two\r\n');
      shell.state.output!('three\r\n');
      expect(socket.output()).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(socket.output()).toEqual(['one\r\ntwo\r\nthree\r\n']);
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });

  it('pauses the shell while the window is behind and resumes it once the socket drains', async () => {
    const database = new MuxusDatabase(':memory:');
    const socket = await localShell(database);
    try {
      socket.bufferedAmount = 5 * MiB;
      shell.state.output!('x'.repeat(1024));
      await vi.advanceTimersByTimeAsync(1);
      expect(shell.pty.pause).toHaveBeenCalledTimes(1);

      socket.bufferedAmount = 3 * MiB;
      await vi.advanceTimersByTimeAsync(200);
      expect(shell.pty.resume).not.toHaveBeenCalled();

      socket.bufferedAmount = MiB;
      await vi.advanceTimersByTimeAsync(50);
      expect(shell.pty.resume).toHaveBeenCalledTimes(1);
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });

  it('keeps a shell paused after it switches to another user', async () => {
    const database = new MuxusDatabase(':memory:');
    const socket = await localShell(database);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    try {
      socket.bufferedAmount = 5 * MiB;
      shell.state.output!('x'.repeat(1024));
      await vi.advanceTimersByTimeAsync(1);
      expect(shell.pty.pause).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(shell.pty.resume).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });

  it('lets a paused shell drain before killing it when the tab closes', async () => {
    const database = new MuxusDatabase(':memory:');
    const socket = await localShell(database);
    try {
      socket.bufferedAmount = 5 * MiB;
      shell.state.output!('x'.repeat(1024));
      await vi.advanceTimersByTimeAsync(1);
      expect(shell.pty.pause).toHaveBeenCalledTimes(1);

      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      expect(shell.pty.resume).toHaveBeenCalledTimes(1);
      expect(shell.pty.kill).toHaveBeenCalledTimes(1);
      expect(shell.pty.resume.mock.invocationCallOrder[0]).toBeLessThan(shell.pty.kill.mock.invocationCallOrder[0]!);
    } finally {
      database.close();
    }
  });

  it('sends the last output before the exit', async () => {
    const database = new MuxusDatabase(':memory:');
    const socket = await localShell(database);
    try {
      shell.state.output!('logout\r\n');
      shell.state.exit!({ exitCode: 0 });

      const sent = socket.send.mock.calls.map(([frame]) =>
        Buffer.isBuffer(frame) ? frame.toString('utf8') : (JSON.parse(String(frame)) as { op: string }).op,
      );
      expect(sent.slice(-2)).toEqual(['logout\r\n', 'exit']);
    } finally {
      database.close();
    }
  });
});

describe('session history under a flood', () => {
  it('pauses a local shell until history has written its output, instead of suspending it', async () => {
    const database = new MuxusDatabase(':memory:');
    recordEverything(database);
    const history = slowHistory();
    const socket = await localShell(database, history.store);
    try {
      await flood((chunk) => shell.state.output!(chunk), () => shell.pty.pause.mock.calls.length > 0);
      expect(shell.pty.pause).toHaveBeenCalled();
      expect(history.store.finishSession).not.toHaveBeenCalled();

      history.drain();
      await vi.advanceTimersByTimeAsync(50);
      expect(shell.pty.resume).toHaveBeenCalled();
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });

  it('suspends history and lets the shell go on when the writer stops answering', async () => {
    const database = new MuxusDatabase(':memory:');
    recordEverything(database);
    const history = slowHistory();
    const socket = await localShell(database, history.store);
    try {
      await flood((chunk) => shell.state.output!(chunk), () => shell.pty.pause.mock.calls.length > 0);
      expect(shell.pty.pause).toHaveBeenCalled();

      history.store.stalled = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(history.store.finishSession).toHaveBeenCalledWith('session-1', 'failed', expect.any(String));
      expect(shell.pty.resume).toHaveBeenCalled();
      expect(socket.frames()).toContainEqual(
        expect.objectContaining({
          op: 'logging-state',
          warning: 'Session logging suspended: the history writer stopped responding.',
        }),
      );
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });

  it('keeps recording while a slow write holds no terminal back', async () => {
    const database = new MuxusDatabase(':memory:');
    recordEverything(database);
    const history = slowHistory();
    history.store.stalled = true;
    const socket = await localShell(database, history.store);
    try {
      shell.state.output!('$ ');
      await vi.advanceTimersByTimeAsync(300);

      expect(history.store.finishSession).not.toHaveBeenCalled();
      expect(shell.pty.pause).not.toHaveBeenCalled();
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });

  it('pauses an SSH channel until history has written its output', async () => {
    const database = new MuxusDatabase(':memory:');
    recordEverything(database);
    const history = slowHistory();
    const stream = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    });
    const socket = new TestSocket();
    terminalRoute({
      connections: {
        usesSystemOpenSsh: () => false,
        connectShell: vi.fn().mockResolvedValue({
          lease: {
            connection: {
              id: 'connection-1',
              host: 'router.example',
              user: 'admin',
              configForwards: [],
              onHealth: () => () => undefined,
              onClose: () => () => undefined,
            },
            release: vi.fn(),
          },
          stream,
          transport: 'new',
          summary: {},
        }),
        resolveProfile: (profile: unknown) => profile,
        metadataAliasFor: () => undefined,
        listedMetadataAliasFor: () => undefined,
        leaseCount: () => 0,
      },
      forwards: { stopSessionForConnection: vi.fn() },
      database,
      history: history.store,
    })(socket);
    try {
      socket.control({ op: 'connect', profile: { kind: 'ssh', target: 'router' }, cols: 80, rows: 24 });
      await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));

      await flood((chunk) => stream.emit('data', Buffer.from(chunk)), () => stream.pause.mock.calls.length > 0);
      expect(stream.pause).toHaveBeenCalled();
      expect(history.store.finishSession).not.toHaveBeenCalled();

      history.drain();
      await vi.advanceTimersByTimeAsync(50);
      expect(stream.resume).toHaveBeenCalled();
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      database.close();
    }
  });
});
