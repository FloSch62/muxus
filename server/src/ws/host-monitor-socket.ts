import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HOST_MONITOR_WS_PATH, type HostMonitorServerMessage } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { HostMonitorSession } from '../stats/host-monitor.js';

const clientMessageSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('watch'),
    intervalMs: z.number().finite().positive(),
    gpu: z.boolean().optional(),
    force: z.array(z.string().min(1).max(200)).max(2000).optional(),
  }),
  z.object({ op: z.literal('retry'), id: z.string().min(1).max(1000) }),
]);

/**
 * The host monitor's stream: one socket per open monitor, statistics of
 * every connected host pushed over it. Nothing is read before the window
 * says how often, and everything stops when the socket closes, so a monitor
 * that is closed or hidden costs the hosts nothing.
 */
export function registerHostMonitorSocket(
  app: FastifyInstance,
  ctx: Pick<AppContext, 'connections' | 'systemOpenSsh' | 'hostStats'>,
): void {
  app.get(HOST_MONITOR_WS_PATH, { websocket: true }, (socket) => {
    const session = new HostMonitorSession(
      ctx.hostStats,
      {
        connections: () => ctx.connections.list(),
        systemSessions: () => ctx.systemOpenSsh.list(),
      },
      (message: HostMonitorServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    );
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const message = clientMessageSchema.safeParse(parsed);
      if (!message.success) return;
      if (message.data.op === 'watch') session.watch(message.data);
      else session.retry(message.data.id);
    });
    socket.once('close', () => session.close());
    socket.once('error', () => session.close());
  });
}
