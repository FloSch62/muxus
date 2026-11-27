import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
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

  /** Terminal output sent before the exit frame, and whether that frame came. */
  untilExit(): { output: string; exited: boolean } {
    let output = '';
    for (const [frame] of this.send.mock.calls) {
      if (Buffer.isBuffer(frame)) output += frame.toString('utf8');
      else if ((JSON.parse(String(frame)) as { op: string }).op === 'exit') return { output, exited: true };
    }
    return { output, exited: false };
  }
}

/** Prints a line, a last one 300 ms later, and exits right after it. */
const PROGRAM = "process.stdout.write('first\\n'); setTimeout(() => { process.stdout.write('last\\n'); process.exit(0); }, 300);";

describe('a real local PTY', () => {
  it('sends the last output of a shell that exits while the window is behind', async () => {
    const database = new MuxusDatabase(':memory:');
    let route!: (socket: TestSocket) => void;
    const app = {
      get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
        route = handler;
      },
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    registerTerminalSocket(app as never, { database, terminalInputs: new TerminalInputs() } as never);
    const socket = new TestSocket();
    // Far more than the window has taken: the first line pauses the PTY.
    socket.bufferedAmount = 5 * 1024 * 1024;
    try {
      route(socket);
      socket.control({
        op: 'connect',
        profile: { kind: 'local', shell: process.execPath, args: ['-e', PROGRAM] },
        cols: 80,
        rows: 24,
      });
      await vi.waitFor(() => expect(socket.untilExit().exited).toBe(true), { timeout: 5_000 });

      expect(socket.untilExit().output).toContain('last');
    } finally {
      database.close();
    }
  });
});
