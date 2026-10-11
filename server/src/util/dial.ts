import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Client } from 'ssh2';

/**
 * Opening a TCP connection to a service, directly or through an SSH
 * gateway's direct-tcpip channel (`ssh -L` style), with errors phrased the
 * same way for both. Shared by remote desktops and management sessions.
 */

export const TCP_CONNECT_TIMEOUT_MS = 15_000;

/** Give an SSH channel-open failure the errno a direct socket would have reported. */
export function channelOpenError(err: Error): Error {
  const reason = (err as { reason?: number }).reason;
  const code =
    /refused/i.test(err.message) ? 'ECONNREFUSED'
    : /timed? ?out/i.test(err.message) ? 'ETIMEDOUT'
    : /resolve|not known|no such host/i.test(err.message) ? 'ENOTFOUND'
    : reason === 1 ? 'EACCES'
    : undefined;
  return Object.assign(new Error(`The SSH gateway could not open the connection: ${err.message}`), {
    code,
  });
}

/** A connect failure as one sentence (WebSocket close reasons cap at 123 bytes). */
export function connectFailureMessage(err: unknown): string {
  switch ((err as NodeJS.ErrnoException | undefined)?.code) {
    case 'ECONNREFUSED':
      return 'The remote computer refused the connection. Check the port and that the server runs.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The host name could not be resolved.';
    case 'ETIMEDOUT':
      return 'The connection timed out.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'The remote computer is unreachable.';
    case 'EACCES':
      return 'The SSH gateway is not allowed to open this connection.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

export function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`Timed out connecting to ${host}:${port}`), { code: 'ETIMEDOUT' }));
    }, TCP_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      // Pointer and key events are tiny; do not let Nagle hold them back.
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      resolve(socket);
    });
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once('error', onError);
  });
}

/** A direct-tcpip channel to host:port, resolved and dialed on the gateway's side. */
export function connectThroughGateway(client: Client, host: string, port: number): Promise<Duplex> {
  const target = `${host}:${port}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(Object.assign(new Error(`Timed out connecting to ${target} through the SSH gateway`), { code: 'ETIMEDOUT' }));
    }, TCP_CONNECT_TIMEOUT_MS);
    client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
      clearTimeout(timer);
      // A channel that opens after the caller gave up must not linger.
      if (settled) {
        channel?.destroy();
        return;
      }
      settled = true;
      if (err) reject(channelOpenError(err));
      else resolve(channel);
    });
  });
}
