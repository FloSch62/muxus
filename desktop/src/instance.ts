import { createHash } from 'node:crypto';
import { chmodSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** One server/state owner per user-data directory; subsequent launches hand off links. */
export async function claimInstance(userData: string, link: string | undefined, activate: (link?: string) => void): Promise<Server | undefined> {
  const id = createHash('sha256').update(userData).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\muxus-${id}` : path.join(tmpdir(), `muxus-${process.getuid?.() ?? 'user'}-${id}.sock`);
  const forward = () => new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(address);
    socket.setTimeout(2000, () => socket.destroy(new Error('The running Muxus instance did not respond.')));
    socket.on('connect', () => socket.end(`${JSON.stringify({ link })}\n`));
    socket.on('data', () => { socket.destroy(); resolve(true); });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
  if (await forward()) return undefined;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString();
      if (input.length > 16_384) { socket.destroy(); return; }
      if (!input.endsWith('\n')) return;
      try {
        const message = JSON.parse(input) as { link?: unknown };
        activate(typeof message.link === 'string' ? message.link : undefined);
        socket.end('ok');
      } catch { socket.destroy(); }
    });
  });
  const listen = () => new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(address, () => { server.removeListener('error', onError); resolve(); });
  });
  try { await listen(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    if (await forward()) return undefined;
    // A crashed Unix process leaves its socket behind. Never remove a live socket.
    if (process.platform === 'win32') throw error;
    unlinkSync(address);
    await listen();
  }
  if (process.platform !== 'win32') chmodSync(address, 0o600);
  return server;
}
