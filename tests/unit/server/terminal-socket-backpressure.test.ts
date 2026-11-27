import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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

  frames(): Array<{ op: string }> {
    return this.send.mock.calls
      .filter(([frame]) => typeof frame === 'string')
      .map(([frame]) => JSON.parse(String(frame)) as { op: string });
  }
}

async function connect(ctx: Record<string, unknown>): Promise<TestSocket> {
  let route!: (socket: TestSocket) => void;
  const app = {
    get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
      route = handler;
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  registerTerminalSocket(app as never, {
    database: {
      sessionLoggingPolicy: () => ({ enabled: false, logToFile: false, captureInput: false }),
      hostAntiIdle: () => undefined,
      recordOpenSshConnection: vi.fn(),
    },
    terminalInputs: new TerminalInputs(),
    ...ctx,
  } as never);
  const socket = new TestSocket();
  route(socket);
  socket.control({ op: 'connect', profile: { kind: 'ssh', target: 'router' }, cols: 80, rows: 24 });
  await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));
  return socket;
}

describe('terminal backpressure', () => {
  it('polls an SSH channel for a drained socket only while it is paused', async () => {
    const stream = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    });
    const socket = await connect({
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
    });
    const idleTimers = vi.getTimerCount();

    socket.bufferedAmount = 5 * MiB;
    stream.emit('data', Buffer.from('output'));
    expect(stream.pause).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(idleTimers + 1);

    socket.bufferedAmount = 3 * MiB;
    await vi.advanceTimersByTimeAsync(200);
    expect(stream.resume).not.toHaveBeenCalled();

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(stream.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(idleTimers);
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('polls a byte transport only while it is paused, and stops when it closes', async () => {
    const listeners: Array<(data: Buffer) => void> = [];
    const emitData = (data: Buffer) => listeners.forEach((listener) => listener(data));
    const session = {
      id: 'system-ssh-1',
      sftpAvailable: false,
      write: vi.fn(),
      drain: vi.fn(async () => undefined),
      resize: vi.fn(),
      sendBreak: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      close: vi.fn(),
      onData: vi.fn((listener: (data: Buffer) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
      onClose: vi.fn(() => () => undefined),
      onError: vi.fn(() => () => undefined),
    };
    const socket = await connect({
      connections: {
        usesSystemOpenSsh: () => true,
        sftpAllowedFor: () => false,
        listedMetadataAliasFor: () => undefined,
        resolveProfile: (profile: unknown) => profile,
      },
      systemOpenSsh: { start: () => session },
    });
    const idleTimers = vi.getTimerCount();

    socket.bufferedAmount = 5 * MiB;
    emitData(Buffer.from('output'));
    expect(session.pause).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(idleTimers + 1);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(session.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(idleTimers);

    socket.bufferedAmount = 5 * MiB;
    emitData(Buffer.from('more output'));
    expect(session.pause).toHaveBeenCalledTimes(2);
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    expect(session.close).toHaveBeenCalled();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.resume).toHaveBeenCalledTimes(1);
  });
});
