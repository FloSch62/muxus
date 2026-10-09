import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';
import { SessionRecorder } from '../../../server/src/session-logging/session-recorder.js';
import { StagedFiles } from '../../../server/src/file-transfer/staged-files.js';
import { CANCEL_SEQUENCE } from '../../../server/src/file-transfer/transfer-io.js';
import { encodeHexHeader } from '../../../server/src/file-transfer/zmodem.js';

afterEach(() => vi.restoreAllMocks());

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
}

/** An SSH terminal whose channel is a plain emitter the test feeds. */
async function sshTerminal() {
  let route!: (socket: TestSocket) => void;
  const stream = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    write: vi.fn(),
    setWindow: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  const connectShell = vi.fn().mockResolvedValue({
    lease: {
      connection: {
        id: 'connection-1',
        host: 'router.example',
        user: 'alice',
        sftpAvailable: true,
        configForwards: [],
        onHealth: () => () => undefined,
        onClose: () => () => undefined,
      },
      release: vi.fn(),
    },
    stream,
    transport: 'new',
    summary: {},
  });
  const app = {
    get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
      route = handler;
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const ctx = {
    connections: { connectShell, resolveProfile: (profile: unknown) => profile, leaseCount: () => 0 },
    forwards: { startConfig: vi.fn(), stop: vi.fn(), stopSessionForConnection: vi.fn() },
    database: {
      sessionLoggingPolicy: () => ({ enabled: false, logToFile: false, captureInput: true }),
    },
    transferFiles: new StagedFiles(),
    terminalInputs: new TerminalInputs(),
  };
  registerTerminalSocket(app as never, ctx as never);
  const socket = new TestSocket();
  route(socket);
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ op: 'connect', profile: { kind: 'ssh', target: 'router.example' }, cols: 80, rows: 24 })),
    false,
  );
  const controls = () =>
    socket.send.mock.calls
      .filter(([frame]) => typeof frame === 'string')
      .map(([frame]) => JSON.parse(String(frame)) as { op: string; transfer?: { phase: string } });
  const binary = () =>
    Buffer.concat(socket.send.mock.calls.filter(([frame]) => Buffer.isBuffer(frame)).map(([frame]) => frame as Buffer));
  await vi.waitFor(() => expect(controls().some((frame) => frame.op === 'ready')).toBe(true));
  return { socket, stream, controls, binary, ctx };
}

describe('file transfers on the terminal socket', () => {
  it('keeps transfer bytes out of the terminal and the session log, and holds input', async () => {
    const recorded: string[] = [];
    vi.spyOn(SessionRecorder.prototype, 'output').mockImplementation((data) => {
      recorded.push(Buffer.from(data).toString('latin1'));
    });
    const inputs: string[] = [];
    vi.spyOn(SessionRecorder.prototype, 'input').mockImplementation((data) => {
      inputs.push(data.toString('latin1'));
    });
    const test = await sshTerminal();

    test.stream.emit('data', Buffer.from('$ sz secret.bin\r\n'));
    test.stream.emit('data', Buffer.concat([encodeHexHeader(0, Buffer.alloc(4)), Buffer.from('SECRET-PAYLOAD')]));
    await vi.waitFor(() =>
      expect(test.controls().some((frame) => frame.op === 'file-transfer' && frame.transfer?.phase === 'waiting')).toBe(true),
    );
    // Our ZRINIT goes straight to the channel.
    await vi.waitFor(() =>
      expect(test.stream.write).toHaveBeenCalledWith(encodeHexHeader(1, Buffer.from([0, 0, 0, 0x23]))),
    );
    test.stream.emit('data', Buffer.from('MORE-SECRET-DATA'));
    test.stream.write.mockClear();
    test.socket.emit('message', Buffer.from('typed while busy'), true);
    expect(test.stream.write).not.toHaveBeenCalled();
    // So do a vault secret and a paced paste the backend would type.
    const session = test.controls().find((frame) => frame.op === 'session') as { terminalId?: string } | undefined;
    expect(test.ctx.terminalInputs.writer(session!.terminalId!)?.(Buffer.from('vault-secret'))).toBe(false);
    test.socket.emit(
      'message',
      Buffer.from(JSON.stringify({ op: 'paste', text: 'pasted\r', bracketed: false, lineDelayMs: 0, charDelayMs: 0 })),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(test.stream.write).not.toHaveBeenCalled();

    test.socket.emit('message', Buffer.from(JSON.stringify({ op: 'file-transfer-cancel' })), false);
    await vi.waitFor(() => expect(test.stream.write).toHaveBeenCalledWith(CANCEL_SEQUENCE));
    await vi.waitFor(
      () => expect(test.controls().some((frame) => frame.op === 'file-transfer' && frame.transfer?.phase === 'cancelled')).toBe(true),
      { timeout: 3000 },
    );

    expect(test.binary().toString('latin1')).toBe('$ sz secret.bin\r\n');
    expect(recorded.join('')).toBe('$ sz secret.bin\r\n');
    expect(inputs).toEqual([]);

    // Once it is over, keystrokes and output flow again.
    test.socket.emit('message', Buffer.from('ls\r'), true);
    expect(test.stream.write).toHaveBeenCalledWith(Buffer.from('ls\r'));
    test.stream.emit('data', Buffer.from('file\r\n'));
    expect(test.binary().toString('latin1').endsWith('file\r\n')).toBe(true);
    test.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    await test.ctx.transferFiles.close();
  });
});
