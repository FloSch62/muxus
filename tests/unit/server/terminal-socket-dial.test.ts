import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerTerminalSocket,
  TERMINAL_REATTACH_GRACE_MS,
  TransferableTerminalSocket,
} from '../../../server/src/ws/terminal-socket.js';

afterEach(() => vi.useRealTimers());

class TestSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly send = vi.fn();
  readonly ping = vi.fn();

  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}

describe('transferable terminal sockets', () => {
  it('buffers handoff output until attach and resumes it when cancelled', () => {
    const source = new TestSocket();
    const destination = new TestSocket();
    const terminal = new TransferableTerminalSocket('terminal-1', source as never);
    const onClose = vi.fn();
    const onMessage = vi.fn();
    terminal.on('close', onClose);
    terminal.on('message', onMessage);
    terminal.send(JSON.stringify({ op: 'session', terminalId: 'terminal-1' }));
    terminal.send(JSON.stringify({ op: 'ready', connId: 'connection-1' }));
    source.send.mockClear();

    source.emit('message', Buffer.from(JSON.stringify({ op: 'prepare-transfer' })), false);
    expect(source.send).toHaveBeenCalledWith(JSON.stringify({ op: 'transfer-ready' }));
    source.send.mockClear();
    terminal.send(Buffer.from('cancelled output'), { binary: true });
    expect(source.send).not.toHaveBeenCalled();

    source.emit('message', Buffer.from(JSON.stringify({ op: 'cancel-transfer' })), false);
    expect(source.send).toHaveBeenCalledWith(Buffer.from('cancelled output'), { binary: true });
    source.send.mockClear();

    source.emit('message', Buffer.from(JSON.stringify({ op: 'prepare-transfer' })), false);
    source.send.mockClear();
    terminal.send(Buffer.from('handoff output'), { binary: true });
    expect(source.send).not.toHaveBeenCalled();

    expect(terminal.attach(destination as never, 132, 43)).toBe(true);

    expect(source.readyState).toBe(3);
    expect(onClose).not.toHaveBeenCalled();
    expect(destination.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ op: 'session', terminalId: 'terminal-1' }),
    );
    expect(destination.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ op: 'ready', connId: 'connection-1' }),
    );
    expect(destination.send).toHaveBeenNthCalledWith(
      3,
      Buffer.from('handoff output'),
      { binary: true },
    );
    expect(onMessage).toHaveBeenCalledWith(
      Buffer.from(JSON.stringify({ op: 'resize', cols: 132, rows: 43 })),
      false,
    );

    destination.emit('message', Buffer.from('hello'), true);
    expect(onMessage).toHaveBeenLastCalledWith(Buffer.from('hello'), true);
    destination.close();
    expect(onClose).not.toHaveBeenCalled();
    terminal.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('retains and reattaches a session after an unexpected renderer close', () => {
    vi.useFakeTimers();
    const source = new TestSocket();
    const destination = new TestSocket();
    const terminal = new TransferableTerminalSocket('terminal-1', source as never);
    const onClose = vi.fn();
    terminal.on('close', onClose);
    terminal.send(JSON.stringify({ op: 'session', terminalId: 'terminal-1' }));
    terminal.send(JSON.stringify({ op: 'ready', connId: 'connection-1' }));
    source.send.mockClear();

    source.close();
    terminal.send(Buffer.from('output while asleep'), { binary: true });
    vi.advanceTimersByTime(TERMINAL_REATTACH_GRACE_MS - 1);

    expect(onClose).not.toHaveBeenCalled();
    expect(terminal.attach(destination as never, 120, 40)).toBe(true);
    expect(destination.send).toHaveBeenCalledWith(
      Buffer.from('output while asleep'),
      { binary: true },
    );

    vi.advanceTimersByTime(TERMINAL_REATTACH_GRACE_MS);
    expect(onClose).not.toHaveBeenCalled();
    terminal.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ends a detached session after its reattachment grace expires', () => {
    vi.useFakeTimers();
    const source = new TestSocket();
    const terminal = new TransferableTerminalSocket('terminal-1', source as never);
    const onClose = vi.fn();
    terminal.on('close', onClose);

    source.close();
    vi.advanceTimersByTime(TERMINAL_REATTACH_GRACE_MS);

    expect(onClose).toHaveBeenCalledOnce();
    expect(terminal.attach(new TestSocket() as never, 80, 24)).toBe(false);
  });
});

describe('terminal socket dial mode', () => {
  it('does not announce readiness until post-auth password saving finishes', async () => {
    let route!: (socket: TestSocket) => void;
    let finishPostAuth!: () => void;
    const postAuth = new Promise<void>((resolve) => {
      finishPostAuth = resolve;
    });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({
      connection: {
        id: 'connection-1',
        host: 'router.example',
        user: 'alice',
        onClose: () => () => undefined,
        waitForPostAuth: () => postAuth,
      },
      release,
      reused: false,
    });
    const app = {
      get: (
        _path: string,
        _options: unknown,
        handler: (socket: TestSocket) => void,
      ) => {
        route = handler;
      },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };
    const ctx = {
      connections: { connect },
      database: { recordOpenSshConnection: vi.fn() },
    };
    registerTerminalSocket(app as never, ctx as never, { reattachGraceMs: 0 });

    const socket = new TestSocket();
    route(socket);
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          op: 'dial',
          profile: { kind: 'ssh', target: 'router.example' },
        }),
      ),
      false,
    );

    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(socket.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        op: 'ready',
        connId: 'connection-1',
        host: 'router.example',
        user: 'alice',
      }),
    );

    finishPostAuth();
    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({
          op: 'ready',
          connId: 'connection-1',
          host: 'router.example',
          user: 'alice',
        }),
      ),
    );
    const sessionFrame = socket.send.mock.calls
      .map(([frame]) => JSON.parse(String(frame)) as { op: string; terminalId?: string })
      .find((frame) => frame.op === 'session');
    expect(sessionFrame?.terminalId).toBeTruthy();

    const destination = new TestSocket();
    route(destination);
    destination.emit(
      'message',
      Buffer.from(JSON.stringify({
        op: 'attach',
        terminalId: sessionFrame!.terminalId,
        cols: 100,
        rows: 30,
      })),
      false,
    );

    expect(socket.readyState).toBe(3);
    expect(release).not.toHaveBeenCalled();
    expect(destination.send).toHaveBeenCalledWith(
      JSON.stringify({
        op: 'ready',
        connId: 'connection-1',
        host: 'router.example',
        user: 'alice',
      }),
    );
    destination.close();
    expect(release).toHaveBeenCalledOnce();
  });
});
