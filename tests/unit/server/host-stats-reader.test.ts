import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SshError } from '../../../server/src/ssh/engine.js';
import { hostStatsScript } from '../../../server/src/stats/host-stats.js';
import { HostStatsReader } from '../../../server/src/stats/host-stats-reader.js';

const OUTPUT = ['@@muxus:begin', '@@muxus:hostname', 'web-01', '@@muxus:end'].join('\n');

/** A channel that answers once its script arrived, or stays silent until released. */
class StubChannel extends EventEmitter {
  readonly stderr = new PassThrough();
  written = '';
  constructor(
    private readonly reply: string,
    private readonly gate?: Promise<void>,
  ) {
    super();
  }
  end(script: string): this {
    this.written = script;
    void (this.gate ?? Promise.resolve()).then(() =>
      setImmediate(() => {
        this.emit('data', Buffer.from(this.reply));
        this.emit('close');
      }),
    );
    return this;
  }
  destroy(): this {
    return this;
  }
}

interface HostFacts {
  reply?: string | Error;
  ranCommand?: boolean;
  commandsDeclined?: boolean;
  profileId?: string;
  gate?: Promise<void>;
}

function fakeHost(id: string, facts: HostFacts = {}) {
  const channels: StubChannel[] = [];
  const exec = vi.fn(async () => {
    if (facts.reply instanceof Error) throw facts.reply;
    const channel = new StubChannel(facts.reply ?? OUTPUT, facts.gate);
    channels.push(channel);
    return channel;
  });
  const closeListeners = new Set<() => void>();
  const connection = {
    id,
    transport: { exec },
    profile: { kind: 'ssh', target: 'web-01', ...(facts.profileId ? { profileId: facts.profileId } : {}) },
    user: 'deploy',
    host: 'web-01.example.net',
    port: 22,
    ranCommand: () => facts.ranCommand ?? true,
    commandsDeclined: () => facts.commandsDeclined ?? false,
    onClose: (listener: () => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
  return { connection, exec, channels, close: () => closeListeners.forEach((listener) => listener()) };
}

function readerFor(hosts: Record<string, ReturnType<typeof fakeHost>>) {
  const release = vi.fn();
  const reader = new HostStatsReader(
    {
      acquire: (connId) => (hosts[connId] ? ({ connection: hosts[connId].connection, release } as never) : undefined),
      acquireSystem: () => undefined,
    },
    async () => ({ hostname: 'this-computer' }),
  );
  return { reader, release };
}

describe('reading host statistics for several viewers', () => {
  it('reads a host that runs commands and releases its lease', async () => {
    const host = fakeHost('c1');
    const { reader, release } = readerFor({ c1: host });
    await expect(reader.ssh('c1')).resolves.toMatchObject({ status: 'ok', sample: { hostname: 'web-01' } });
    expect(host.exec).toHaveBeenCalledWith('sh -s');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('lets a plainer request ride a richer reading that is already running', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const host = fakeHost('c1', { gate });
    const { reader } = readerFor({ c1: host });
    const monitor = reader.ssh('c1', { diskIo: true });
    const statusBar = reader.ssh('c1');
    open();
    await Promise.all([monitor, statusBar]);
    expect(host.exec).toHaveBeenCalledTimes(1);
    expect(host.channels[0]!.written).toBe(hostStatsScript({ diskIo: true }));
  });

  it('runs a richer reading of its own beside a plainer one', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const host = fakeHost('c1', { gate });
    const { reader } = readerFor({ c1: host });
    const statusBar = reader.ssh('c1');
    const monitor = reader.ssh('c1', { diskIo: true, gpu: true });
    open();
    await Promise.all([statusBar, monitor]);
    expect(host.exec).toHaveBeenCalledTimes(2);
    expect(host.channels[1]!.written).toContain('nvidia-smi');
  });

  it('does not ask a connection whose server never ran a command', async () => {
    const host = fakeHost('c1', { ranCommand: false });
    const { reader, release } = readerFor({ c1: host });
    await expect(reader.ssh('c1')).resolves.toEqual({ status: 'idle' });
    expect(host.exec).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('asks such a connection once when the user asked for the host by name', async () => {
    const host = fakeHost('c1', { ranCommand: false });
    const { reader } = readerFor({ c1: host });
    await expect(reader.ssh('c1', { force: true })).resolves.toMatchObject({ status: 'ok' });
    expect(host.exec).toHaveBeenCalledTimes(1);
  });

  it('leaves a host alone that already showed it runs no commands, even when asked by name', async () => {
    // Its shell asked and got no answer: old SR OS drops the connection on the next exec.
    const host = fakeHost('c1', { ranCommand: false, commandsDeclined: true });
    const { reader } = readerFor({ c1: host });
    await expect(reader.ssh('c1', { force: true })).resolves.toEqual({ status: 'unsupported' });
    expect(host.exec).not.toHaveBeenCalled();
  });

  it('remembers a host that answered without the markers, until the connection closes', async () => {
    const host = fakeHost('c1', { reply: 'Invalid command\r\n' });
    const { reader } = readerFor({ c1: host });
    await expect(reader.ssh('c1')).resolves.toEqual({ status: 'unsupported' });
    await expect(reader.ssh('c1')).resolves.toEqual({ status: 'unsupported' });
    expect(host.exec).toHaveBeenCalledTimes(1);
    host.close();
    await reader.ssh('c1');
    expect(host.exec).toHaveBeenCalledTimes(2);
  });

  it('does not ask a host by name again on its next connection after it refused', async () => {
    const refusal = new SshError('Unable to exec', 'EXEC_REFUSED', 1);
    const first = fakeHost('c1', { ranCommand: false, reply: refusal });
    const second = fakeHost('c2', { ranCommand: false });
    const { reader } = readerFor({ c1: first, c2: second });
    await expect(reader.ssh('c1', { force: true })).rejects.toThrow('Unable to exec');
    // The same host, dialed again: SR OS keeps every refused channel until the connection closes.
    await expect(reader.ssh('c2', { force: true })).resolves.toEqual({ status: 'unsupported' });
    expect(second.exec).not.toHaveBeenCalled();
  });

  it('asks again after the user says so', async () => {
    const refusal = new SshError('Unable to exec', 'EXEC_REFUSED', 1);
    const first = fakeHost('c1', { ranCommand: false, reply: refusal });
    const second = fakeHost('c2', { ranCommand: false });
    const { reader } = readerFor({ c1: first, c2: second });
    await expect(reader.ssh('c1', { force: true })).rejects.toThrow();
    reader.retry('c2');
    await expect(reader.ssh('c2', { force: true })).resolves.toMatchObject({ status: 'ok' });
  });

  it('keeps a failed reading of a host that runs commands retryable', async () => {
    const host = fakeHost('c1', { reply: new SshError('Channel open failure', 'CHANNEL_OPEN_FAILED', 1) });
    const { reader } = readerFor({ c1: host });
    await expect(reader.ssh('c1')).rejects.toThrow('Channel open failure');
    await expect(reader.ssh('c1')).rejects.toThrow('Channel open failure');
    expect(host.exec).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for a connection that is gone', async () => {
    const { reader } = readerFor({});
    await expect(reader.ssh('gone')).rejects.toMatchObject({ status: 404 });
  });

  it('reads this computer with the script the viewer asked for', async () => {
    const readLocal = vi.fn(async () => ({ hostname: 'laptop' }));
    const reader = new HostStatsReader({ acquire: () => undefined, acquireSystem: () => undefined }, readLocal);
    await expect(reader.local({ diskIo: true })).resolves.toEqual({ status: 'ok', sample: { hostname: 'laptop' } });
    expect(readLocal).toHaveBeenCalledWith(hostStatsScript({ diskIo: true }));
  });

  it('reads a system OpenSSH session through its shared login', async () => {
    const release = vi.fn();
    const runScript = vi.fn(async () => OUTPUT);
    const reader = new HostStatsReader({
      acquire: () => undefined,
      acquireSystem: () =>
        ({
          connection: { id: 'system-ssh-1', runsCommands: async () => true, runScript, onClose: () => () => undefined },
          release,
        }) as never,
    });
    const outcome = await reader.ssh('system-ssh-1', { diskIo: true });
    expect(outcome).toMatchObject({ status: 'ok', sample: { hostname: 'web-01' } });
    expect(outcome.status === 'ok' && outcome.latencyMs).toBeTypeOf('number');
    expect(runScript).toHaveBeenCalledWith(hostStatsScript({ diskIo: true }));
    expect(release).toHaveBeenCalledTimes(1);
  });
});
