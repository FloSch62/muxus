import { EventEmitter } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';

const requestChannelBreak = vi.hoisted(() => vi.fn());
vi.mock('../../../server/src/ssh/channel-break.js', () => ({ requestChannelBreak }));

afterEach(() => requestChannelBreak.mockReset());

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

  frames(): Array<{ op: string; ok?: boolean; message?: string }> {
    return this.send.mock.calls
      .filter(([frame]) => typeof frame === 'string')
      .map(([frame]) => JSON.parse(String(frame)) as { op: string });
  }
}

function terminalRoute(ctx: unknown): (socket: TestSocket) => void {
  let route!: (socket: TestSocket) => void;
  const app = {
    get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
      route = handler;
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  registerTerminalSocket(app as never, ctx as never);
  return route;
}

const loggingOff = {
  sessionLoggingPolicy: () => ({ enabled: false, logToFile: false, captureInput: false }),
  recordSavedHostConnection: vi.fn(),
};

describe('Send BREAK over the terminal socket', () => {
  it('reports an SSH server that refuses the break request', async () => {
    const stream = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      write: vi.fn(),
      setWindow: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    });
    const route = terminalRoute({
      connections: {
        connectShell: vi.fn().mockResolvedValue({
          lease: {
            connection: {
              id: 'connection-1',
              host: 'console-server',
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
        leaseCount: () => 0,
      },
      forwards: { stopSessionForConnection: vi.fn() },
      database: loggingOff,
      terminalInputs: new TerminalInputs(),
    });
    const socket = new TestSocket();
    route(socket);
    socket.control({ op: 'connect', profile: { kind: 'ssh', target: 'console-server' }, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));

    requestChannelBreak.mockResolvedValueOnce('accepted').mockResolvedValueOnce('refused');
    socket.control({ op: 'send-break' });
    await vi.waitFor(() => expect(socket.frames().filter((frame) => frame.op === 'break-result')).toHaveLength(1));
    socket.control({ op: 'send-break' });
    await vi.waitFor(() => expect(socket.frames().filter((frame) => frame.op === 'break-result')).toHaveLength(2));

    expect(requestChannelBreak).toHaveBeenCalledWith(stream, 250);
    expect(socket.frames().filter((frame) => frame.op === 'break-result')).toEqual([
      { op: 'break-result', ok: true },
      { op: 'break-result', ok: false, message: 'The SSH server refused the BREAK request' },
    ]);
    // A BREAK is never terminal input.
    expect(stream.write).not.toHaveBeenCalled();
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('puts IAC BRK on a Telnet connection', async () => {
    const fromClient: Buffer[] = [];
    const server = net.createServer((connection) => {
      connection.on('data', (data) => fromClient.push(data));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const route = terminalRoute({ database: loggingOff, terminalInputs: new TerminalInputs() });
    const socket = new TestSocket();
    try {
      route(socket);
      socket.control({ op: 'connect', profile: { kind: 'telnet', host: '127.0.0.1', port }, cols: 80, rows: 24 });
      await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));

      socket.control({ op: 'send-break' });
      await vi.waitFor(() => expect(Buffer.concat(fromClient)).toEqual(Buffer.from([0xff, 0xf3])));
      await vi.waitFor(() =>
        expect(socket.frames()).toContainEqual({ op: 'break-result', ok: true }),
      );
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
