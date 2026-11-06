import { spawn } from 'node:child_process';
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
          const child = spawn('/bin/sh', ['-c', info.command], { stdio: 'pipe' });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on('exit', (code) => {
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
  const connection = { client, onClose: () => () => undefined };
  const manager = new ScriptRuns({ acquire: (id) => (id === 'c1' ? ({ connection, release } as never) : undefined) });
  return { manager, release };
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

  it('refuses a connection that is gone', async () => {
    const { manager } = runs();
    await expect(manager.start('nope', 'true')).rejects.toThrow(/gone/);
  });
});
