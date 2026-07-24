import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerSftpLeaseSocket } from '../../../server/src/ws/sftp-lease-socket.js';

describe('detached SFTP window leases', () => {
  it('holds the transport until the window socket closes', () => {
    let handler:
      | ((socket: EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; OPEN: number; readyState: number }, request: unknown) => void)
      | undefined;
    const app = {
      get: vi.fn((_path: string, _options: unknown, routeHandler: typeof handler) => {
        handler = routeHandler;
      }),
    };
    const release = vi.fn();
    const unsubscribe = vi.fn();
    const connectionCloseListeners: Array<() => void> = [];
    const ctx = {
      connections: {
        acquire: vi.fn(() => ({
          connection: {
            onClose: (listener: () => void) => {
              connectionCloseListeners.push(listener);
              return unsubscribe;
            },
          },
          release,
        })),
      },
    };
    registerSftpLeaseSocket(app as never, ctx as never);

    const socket = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      close: vi.fn(),
      OPEN: 1,
      readyState: 1,
    });
    handler!(socket, { params: { connId: 'connection-1' } });

    expect(ctx.connections.acquire).toHaveBeenCalledWith('connection-1', 'sftp');
    expect(socket.send).toHaveBeenCalledWith('ready');
    expect(release).not.toHaveBeenCalled();

    socket.emit('close');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();

    connectionCloseListeners[0]!();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a stale connection id', () => {
    let handler: ((socket: { close: ReturnType<typeof vi.fn> }, request: unknown) => void) | undefined;
    const app = {
      get: vi.fn((_path: string, _options: unknown, routeHandler: typeof handler) => {
        handler = routeHandler;
      }),
    };
    const ctx = { connections: { acquire: vi.fn(() => undefined) } };
    registerSftpLeaseSocket(app as never, ctx as never);
    const socket = { close: vi.fn() };

    handler!(socket, { params: { connId: 'stale' } });

    expect(socket.close).toHaveBeenCalledWith(1008, 'connection not found');
  });
});
