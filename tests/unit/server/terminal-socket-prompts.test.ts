import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import type { ConnectIo } from '../../../server/src/ssh/connection-manager.js';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';

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

  frames(): Array<{ op: string }> {
    return this.send.mock.calls
      .filter(([frame]) => typeof frame === 'string')
      .map(([frame]) => JSON.parse(String(frame)) as { op: string });
  }
}

/** A terminal socket whose SSH login asks the window what `login` asks. */
function openSocket(login: (io: ConnectIo) => Promise<void>) {
  const stream = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    write: vi.fn(),
    setWindow: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  let route!: (socket: TestSocket) => void;
  const app = {
    get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
      route = handler;
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  registerTerminalSocket(
    app as never,
    {
      connections: {
        usesSystemOpenSsh: () => false,
        connectShell: async (_profile: unknown, io: ConnectIo) => {
          await login(io);
          return {
            lease: {
              connection: {
                id: 'connection-1',
                host: 'bastion',
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
          };
        },
        resolveProfile: (profile: unknown) => profile,
        leaseCount: () => 0,
      },
      forwards: { stopSessionForConnection: vi.fn() },
      database: {
        sessionLoggingPolicy: () => ({ enabled: false, logToFile: false, captureInput: false }),
        recordSavedHostConnection: vi.fn(),
      },
      terminalInputs: new TerminalInputs(),
    } as never,
  );
  const socket = new TestSocket();
  route(socket);
  socket.control({ op: 'connect', profile: { kind: 'ssh', target: 'bastion' }, cols: 80, rows: 24 });
  return { socket, stream };
}

const sent = (socket: TestSocket, op: string) => socket.frames().some((frame) => frame.op === op);

describe('sign-in prompts over the terminal socket', () => {
  it('keeps a password prompt open while the window is resized', async () => {
    const answers: string[][] = [];
    const { socket, stream } = openSocket(async (io) => {
      const reply = await io.prompt({ host: 'bastion', prompts: [{ prompt: 'Password', echo: false }] });
      answers.push(reply.answers);
    });
    await vi.waitFor(() => expect(sent(socket, 'auth-prompt')).toBe(true));

    socket.control({ op: 'resize', cols: 100, rows: 30 });
    socket.control({ op: 'resize', cols: 132, rows: 43 });
    socket.control({ op: 'auth-response', answers: ['secret'] });
    await vi.waitFor(() => expect(sent(socket, 'ready')).toBe(true));

    expect(answers).toEqual([['secret']]);
    expect(sent(socket, 'exit')).toBe(false);
    // The shell opens at the size the window reached while the dialog was up.
    expect(stream.setWindow.mock.calls).toEqual([[43, 132, 0, 0]]);
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('does not take a resize for the answer to a host-key question', async () => {
    const decisions: boolean[] = [];
    const { socket } = openSocket(async (io) => {
      decisions.push(
        await io.hostKey({
          host: 'bastion',
          port: 22,
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:test',
          state: 'new',
        }),
      );
    });
    await vi.waitFor(() => expect(sent(socket, 'host-key')).toBe(true));

    socket.control({ op: 'resize', cols: 100, rows: 30 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(decisions).toEqual([]);

    socket.control({ op: 'host-key-response', accept: true });
    await vi.waitFor(() => expect(sent(socket, 'ready')).toBe(true));
    expect(decisions).toEqual([true]);
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });
});
