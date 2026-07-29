import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';

class TestSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly send = vi.fn();
  readonly ping = vi.fn();

  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}

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
    socket.close();
    expect(release).toHaveBeenCalledOnce();
  });
});
