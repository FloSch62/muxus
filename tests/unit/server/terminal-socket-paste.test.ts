import { EventEmitter } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PASTE_ERROR_PATTERN, DEFAULT_PASTE_PROMPT_PATTERN } from '@muxus/shared';
import { TERMINAL_SESSION_CLOSE_REASON } from '@muxus/shared/ws-protocol';
import { TerminalInputs } from '../../../server/src/ws/terminal-inputs.js';
import { registerTerminalSocket } from '../../../server/src/ws/terminal-socket.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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

  frames(): Array<{ op: string; [key: string]: unknown }> {
    return this.send.mock.calls
      .filter(([frame]) => typeof frame === 'string')
      .map(([frame]) => JSON.parse(String(frame)) as { op: string });
  }
}

/**
 * An SSH terminal session over mocks, with the time each byte reached the
 * channel. `answer` plays the device: what it prints 20 ms after a line.
 */
async function sshSession(answer?: (line: string) => string) {
  let route!: (socket: TestSocket) => void;
  let loseConnection!: (reason?: string) => void;
  const start = Date.now();
  const written: Array<{ at: number; data: string }> = [];
  const stream = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    write: vi.fn((data: Buffer, callback?: () => void) => {
      const text = data.toString('utf8');
      written.push({ at: Date.now() - start, data: text });
      callback?.();
      if (answer && text.endsWith('\r')) {
        const reply = Buffer.from(answer(text.slice(0, -1)), 'utf8');
        setTimeout(() => stream.emit('data', reply), 20);
      }
      return true;
    }),
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
        sftpAvailable: false,
        configForwards: [],
        onHealth: () => () => undefined,
        onClose: (listener: (reason?: string) => void) => {
          loseConnection = listener;
          return () => undefined;
        },
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
    connections: {
      connectShell,
      resolveProfile: (profile: unknown) => profile,
      leaseCount: () => 0,
    },
    forwards: { startConfig: vi.fn(), stop: vi.fn(), stopSessionForConnection: vi.fn() },
    database: {
      sessionLoggingPolicy: () => ({ enabled: false, logToFile: false, captureInput: false }),
    },
    terminalInputs: new TerminalInputs(),
  };
  registerTerminalSocket(app as never, ctx as never);

  const socket = new TestSocket();
  route(socket);
  socket.control({
    op: 'connect',
    profile: { kind: 'ssh', target: 'router.example' },
    cols: 80,
    rows: 24,
  });
  await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));
  return {
    route,
    socket,
    stream,
    written: () => written.map(({ at, data }) => ({ at: at - written[0]!.at, data })),
    loseConnection: (reason?: string) => loseConnection(reason),
  };
}

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `set interface ${index}`).join('\n');

describe('paced pastes over the terminal socket', () => {
  it('types the paste into the SSH channel at the requested pace', async () => {
    const { socket, written } = await sshSession();

    socket.control({ op: 'paste', text: 'one\ntwo\nthree\n', bracketed: false, lineDelayMs: 300, charDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(written()).toEqual([
      { at: 0, data: 'one\r' },
      { at: 300, data: 'two\r' },
      { at: 600, data: 'three\r' },
    ]);
    const progress = socket.frames().filter((frame) => frame.op === 'paste-progress');
    expect(progress[0]).toMatchObject({ state: 'running', line: 2, lines: 3 });
    expect(progress.at(-1)).toMatchObject({ state: 'done', line: 3, lines: 3 });
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('closes the bracketed paste when the paste is cancelled', async () => {
    const { socket, written } = await sshSession();

    socket.control({ op: 'paste', text: lines(10), bracketed: true, lineDelayMs: 100, charDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(250);
    socket.control({ op: 'paste-cancel' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(written().map(({ data }) => data)).toEqual([
      '\x1b[200~set interface 0\r',
      'set interface 1\r',
      'set interface 2\r',
      '\x1b[201~',
    ]);
    expect(socket.frames().at(-1)).toMatchObject({ op: 'paste-progress', state: 'cancelled' });
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('stops when the tab closes', async () => {
    const { socket, written } = await sshSession();

    socket.control({ op: 'paste', text: lines(10), bracketed: false, lineDelayMs: 100, charDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(150);
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    await vi.advanceTimersByTimeAsync(2000);

    expect(written()).toHaveLength(2);
  });

  it('stops when the connection is lost', async () => {
    const { socket, written, loseConnection } = await sshSession();

    socket.control({ op: 'paste', text: lines(10), bracketed: false, lineDelayMs: 100, charDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(150);
    loseConnection('Connection reset by peer');
    await vi.advanceTimersByTimeAsync(2000);

    expect(written()).toHaveLength(2);
    expect(socket.frames().some((frame) => frame.op === 'exit')).toBe(true);
  });

  it('keeps pacing while the renderer is away and shows a returning one the progress', async () => {
    const { route, socket, written } = await sshSession();
    const terminalId = socket.frames().find((frame) => frame.op === 'session')?.terminalId;

    socket.control({ op: 'paste', text: lines(20), bracketed: false, lineDelayMs: 100, charDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(250);
    // The window went to sleep: its socket dropped without closing the session.
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(written()).toHaveLength(13);

    const returning = new TestSocket();
    route(returning);
    returning.control({ op: 'attach', terminalId, cols: 80, rows: 24 });
    expect(returning.frames().find((frame) => frame.op === 'paste-progress')).toMatchObject({
      state: 'running',
      lines: 20,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(written()).toHaveLength(20);
    expect(written().at(-1)?.at).toBe(1900);
    returning.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });
});

/** An IOS-style console: echoes the line, rejects one starting with "bogus", shows its prompt. */
const iosConsole = (prompt: string) => (line: string) =>
  `${line}\r\n${line.startsWith('bogus') ? "% Invalid input detected at '^' marker.\r\n\r\n" : ''}${prompt}`;

const promptPaste = {
  op: 'paste',
  text: 'interface ge-0/0/1\nbogus command\nshutdown\n',
  bracketed: false,
  lineDelayMs: 0,
  charDelayMs: 0,
  prompt: {
    promptPattern: DEFAULT_PASTE_PROMPT_PATTERN,
    timeoutMs: 5000,
    errorPattern: DEFAULT_PASTE_ERROR_PATTERN,
  },
};

describe('pastes that wait for the prompt over the terminal socket', () => {
  it('sends each line once the prompt is back and stops at the line the device rejects', async () => {
    const { socket, written } = await sshSession(iosConsole('R1(config)#'));

    socket.control(promptPaste);
    await vi.advanceTimersByTimeAsync(1000);

    expect(written()).toEqual([
      { at: 0, data: 'interface ge-0/0/1\r' },
      { at: 21, data: 'bogus command\r' },
    ]);
    expect(socket.frames().at(-1)).toMatchObject({
      op: 'paste-progress',
      state: 'stopped',
      line: 2,
      lines: 3,
      message:
        "Line 2 of 3 (“bogus command”) was answered with “% Invalid input detected at '^' marker.”",
      stopId: 1,
    });
    socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('shows a renderer that returns a stop made while it was away', async () => {
    const { route, socket, written } = await sshSession(iosConsole('R1(config)#'));
    const terminalId = socket.frames().find((frame) => frame.op === 'session')?.terminalId;

    socket.control(promptPaste);
    await vi.advanceTimersByTimeAsync(10);
    // The window went to sleep before the device rejected line two.
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(written()).toHaveLength(2);

    const returning = new TestSocket();
    route(returning);
    returning.control({ op: 'attach', terminalId, cols: 80, rows: 24 });
    expect(returning.frames().find((frame) => frame.op === 'paste-progress')).toMatchObject({
      state: 'stopped',
      line: 2,
      stopId: 1,
    });
    returning.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('lets every mirrored session wait for its own prompt and stop on its own', async () => {
    const strict = await sshSession(iosConsole('R1(config)#'));
    const lenient = await sshSession((line) => `${line}\r\nleaf2(config)# `);

    strict.socket.control(promptPaste);
    lenient.socket.control(promptPaste);
    await vi.advanceTimersByTimeAsync(1000);

    expect(strict.written()).toHaveLength(2);
    expect(strict.socket.frames().at(-1)).toMatchObject({ op: 'paste-progress', state: 'stopped' });
    expect(lenient.written().map(({ data }) => data)).toEqual([
      'interface ge-0/0/1\r',
      'bogus command\r',
      'shutdown\r',
    ]);
    expect(lenient.socket.frames().at(-1)).toMatchObject({ op: 'paste-progress', state: 'done' });
    strict.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
    lenient.socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
  });

  it('reads the answers of a Telnet console between lines', async () => {
    vi.useRealTimers();
    const received: string[] = [];
    const answer = iosConsole('\x1b[1mR1(config)#\x1b[0m ');
    const server = net.createServer((connection) => {
      let pending = '';
      // A rejection in the banner is old output, not an answer to the paste.
      connection.write(`% Invalid input detected\r\nR1(config)#`);
      connection.on('data', (data) => {
        pending += data.toString('latin1');
        for (let end = pending.indexOf('\r\n'); end >= 0; end = pending.indexOf('\r\n')) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          received.push(line);
          // Answered in two parts, as a console still applying the line would.
          connection.write(`${line}\r\n`);
          setTimeout(() => connection.write(answer(line).slice(line.length + 2)), 40);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    let route!: (socket: TestSocket) => void;
    const app = {
      get: (_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
        route = handler;
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    registerTerminalSocket(app as never, {
      database: {
        sessionLoggingPolicy: () => ({ enabled: false, logToFile: false, captureInput: false }),
      },
      terminalInputs: new TerminalInputs(),
    } as never);
    const socket = new TestSocket();
    try {
      route(socket);
      socket.control({ op: 'connect', profile: { kind: 'telnet', host: '127.0.0.1', port }, cols: 80, rows: 24 });
      await vi.waitFor(() => expect(socket.frames().some((frame) => frame.op === 'ready')).toBe(true));

      socket.control(promptPaste);
      await vi.waitFor(
        () => expect(socket.frames().at(-1)).toMatchObject({ op: 'paste-progress', state: 'stopped' }),
        { timeout: 3000 },
      );
      expect(received).toEqual(['interface ge-0/0/1', 'bogus command']);
      expect(socket.frames().at(-1)).toMatchObject({
        line: 2,
        message:
          "Line 2 of 3 (“bogus command”) was answered with “% Invalid input detected at '^' marker.”",
      });
    } finally {
      socket.close(1000, TERMINAL_SESSION_CLOSE_REASON);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
