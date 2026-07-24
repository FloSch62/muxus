import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';

interface ConnParams {
  connId: string;
}

/**
 * A detached SFTP window owns a transport lease through this socket. Browser
 * WebSocket lifetime gives us reliable cleanup even when the window crashes
 * or closes without running an unload handler.
 */
export function registerSftpLeaseSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/sftp/:connId/lease', { websocket: true }, (socket, request) => {
    const { connId } = request.params as ConnParams;
    const lease = ctx.connections.acquire(connId, 'sftp');
    if (!lease) {
      socket.close(1008, 'connection not found');
      return;
    }

    let released = false;
    let unsubscribeClose: () => void = () => undefined;
    const release = () => {
      if (released) return;
      released = true;
      unsubscribeClose();
      lease.release();
    };
    unsubscribeClose = lease.connection.onClose(() => {
      if (socket.readyState === socket.OPEN) socket.close(1011, 'connection closed');
      release();
    });
    if (released) unsubscribeClose();
    socket.once('close', release);
    socket.send('ready');
  });
}
