import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  registerTerminalSocket,
  TransferableTerminalSocket,
} from '../../../server/src/ws/terminal-socket.js';

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
  it('swaps renderer sockets without closing the terminal lifecycle', () => {
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
    expect(onMessage).toHaveBeenCalledWith(
      Buffer.from(JSON.stringify({ op: 'resize', cols: 132, rows: 43 })),
      false,
    );

    destination.emit('message', Buffer.from('hello'), true);
    expect(onMessage).toHaveBeenLastCalledWith(Buffer.from('hello'), true);
    destination.close();
    expect(onClose).toHaveBeenCalledOnce();
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
    registerTerminalSocket(app as never, ctx as never);

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
