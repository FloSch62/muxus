import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { startServer } from '../../../server/src/server.js';

const TOKEN = 'server-close-test-token';

describe('closing the server', () => {
  it('does not wait for a request whose body stopped arriving', async () => {
    const server = await startServer({
      port: 0,
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    });
    const socket = net.connect(server.port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    // The headers promise a body that never comes, as with a stalled upload.
    socket.write(
      [
        'PUT /api/workspaces HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${TOKEN}`,
        'Content-Type: application/json',
        'Content-Length: 1000',
        '',
        '{"name":',
      ].join('\r\n'),
    );
    await delay(100);

    const outcome = await Promise.race([
      server.close().then(() => 'closed'),
      delay(3_500, 'still open'),
    ]);

    expect(outcome).toBe('closed');
    socket.destroy();
  });
});
