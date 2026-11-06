import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import type net from 'node:net';
import { Client, Server } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScriptRuns, scriptCommand } from '../../../server/src/scripts/script-runs.js';

const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

let server: Server;
let client: Client;
const commands: string[] = [];
/** Answer every exec like a Windows host whose shell is cmd.exe. */
let windowsHost = false;

/** An sshd whose exec runs the command with the local sh, stdin and all. */
beforeAll(async () => {
  server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => ctx.accept());
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          if (windowsHost) {
            stream.stderr.write("'sh' n'est pas reconnu en tant que commande interne\r\n");
            stream.exit(1);
            stream.end();
            return;
          }
          // Like sshd: each exec session in a session (and process group) of its own.
          const child = spawn('/bin/sh', ['-c', info.command], { stdio: 'pipe', detached: true });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          // 'close', not 'exit': like sshd, send everything the child wrote
          // before the exit status and the end of the channel.
          child.on('close', (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
          stream.on('close', () => child.kill());
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.on('ready', () => resolve());
    client.on('error', reject);
    client.connect({ host: '127.0.0.1', port, username: 'tester', password: 'x' });
  });
});

afterAll(async () => {
  client.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runs() {
  const release = vi.fn();
  const unsubscribe = vi.fn();
  const connection = { client, onClose: vi.fn(() => unsubscribe) };
  const manager = new ScriptRuns({ acquire: (id) => (id === 'c1' ? ({ connection, release } as never) : undefined) });
  return { manager, release, unsubscribe };
}

async function finished(manager: ScriptRuns, id: string) {
  for (let i = 0; i < 200; i++) {
    const status = manager.status(id);
    if (status.state !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the run did not finish');
}

describe('script runs over SSH exec', () => {
  it('runs a script with sh and reports output and exit code', async () => {
    const { manager, release } = runs();
    const { id } = await manager.start('c1', 'echo "hello $((1 + 2))"\necho oops >&2\nexit 3');
    const status = await finished(manager, id);
    expect(status).toMatchObject({ state: 'failed', exitCode: 3 });
    expect(status.output).toContain('hello 3');
    expect(status.output).toContain('oops');
    expect(release).toHaveBeenCalledTimes(1);
    // The script itself never appears in the command line.
    expect(commands.at(-1)).toBe(scriptCommand());
  });

  it('honours a #! line and gives the script an empty stdin', async () => {
    const { manager } = runs();
    const { id } = await manager.start('c1', '#!/bin/sh -e\nread line || echo "stdin is empty"\nfalse\necho "not reached"\n');
    const status = await finished(manager, id);
    expect(status.output).toContain('stdin is empty');
    expect(status.output).not.toContain('not reached');
    expect(status.state).toBe('failed');
  });

  it('succeeds on exit 0 and returns only new output when polled with an offset', async () => {
    const { manager } = runs();
    const { id } = await manager.start('c1', 'printf one\nprintf two');
    const status = await finished(manager, id);
    expect(status).toMatchObject({ state: 'completed', exitCode: 0, output: 'onetwo' });
    expect(manager.status(id, 3).output).toBe('two');
    expect(manager.status(id, status.offset).output).toBe('');
  });

  it('stops a run that outlives its timeout, and one that is cancelled', async () => {
    const { manager } = runs();
    const slow = await manager.start('c1', 'sleep 30', 1);
    expect(await finished(manager, slow.id)).toMatchObject({ state: 'timed-out' });
    const other = await manager.start('c1', 'sleep 30');
    manager.cancel(other.id);
    expect(manager.status(other.id).state).toBe('cancelled');
  }, 10_000);

  it('stops the script itself on cancel and timeout, and removes its file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-script-stop-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = `${dir}/`;
    try {
      const { manager, release, unsubscribe } = runs();
      // A script that would leave a trace if it ran on after the stop.
      const marker = path.join(dir, 'still-running');
      const cancelled = await manager.start('c1', `sleep 1.5; touch ${marker}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      manager.cancel(cancelled.id);
      const timedOut = await manager.start('c1', `sleep 2.5; touch ${marker}`, 1);
      await finished(manager, timedOut.id);
      await new Promise((resolve) => setTimeout(resolve, 2500));

      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
      expect(release).toHaveBeenCalledTimes(2);
      expect(unsubscribe).toHaveBeenCalledTimes(2);
    } finally {
      // Assigning undefined would leave the string "undefined" behind.
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('says so when the host has no POSIX shell to start the script', async () => {
    const { manager } = runs();
    // As cmd.exe would: the wrapper never runs, so no marker arrives.
    windowsHost = true;
    try {
      const { id } = await manager.start('c1', 'uname -a');
      expect(await finished(manager, id)).toMatchObject({
        state: 'failed',
        error: expect.stringMatching(/no POSIX shell/),
      });
    } finally {
      windowsHost = false;
    }
  });

  it('still runs when TMPDIR points nowhere', async () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = '/nonexistent/muxus-test';
    try {
      const { manager } = runs();
      const { id } = await manager.start('c1', 'echo fine');
      expect(await finished(manager, id)).toMatchObject({ state: 'completed', output: 'fine\n' });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  it('keeps its own job marker out of the output', async () => {
    const { manager } = runs();
    const { id } = await manager.start('c1', 'echo out\necho err >&2');
    const status = await finished(manager, id);
    expect(status.output).toContain('out');
    expect(status.output).toContain('err');
    expect(status.output).not.toContain('muxus-job');
  });

  it('refuses a connection that is gone', async () => {
    const { manager } = runs();
    await expect(manager.start('nope', 'true')).rejects.toThrow(/gone/);
  });
});
