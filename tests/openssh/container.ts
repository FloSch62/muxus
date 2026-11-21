import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

const IMAGE = 'muxus-openssh-test';

export interface OpenSshServer {
  /** The container's name, for `docker exec` and `docker pause`. */
  container: string;
  /** Port on 127.0.0.1 that reaches the container's sshd. */
  port: number;
  /** The keys and certificates the container made; see its entrypoint. */
  fixtures: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    openssh: OpenSshServer;
  }
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Resolves once sshd has sent its identification string. */
function sshdAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('data', (data) => done(data.toString().startsWith('SSH-')));
    socket.once('error', () => done(false));
    socket.once('close', () => resolve(false));
  });
}

export default async function setup(project: TestProject): Promise<() => void> {
  try {
    docker('version', '--format', '{{.Server.Version}}');
  } catch {
    throw new Error('The OpenSSH tests need a running Docker daemon.');
  }
  const context = path.join(path.dirname(fileURLToPath(import.meta.url)), 'container');
  docker('build', '-q', '-t', IMAGE, context);

  const container = `muxus-openssh-test-${process.pid}`;
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'muxus-openssh-'));
  const stop = () => {
    try {
      docker('rm', '-f', container);
    } catch {
      // Already gone.
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    docker('run', '-d', '--rm', '--name', container, '-p', '127.0.0.1::22', IMAGE);
    const port = Number(docker('port', container, '22').split('\n')[0]!.split(':').pop());
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ready = (() => {
        try {
          docker('exec', container, 'test', '-f', '/fixtures/ready');
          return true;
        } catch {
          return false;
        }
      })();
      if (ready && (await sshdAnswers(port))) break;
      if (Date.now() > deadline) throw new Error('The OpenSSH container did not come up.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    docker('cp', `${container}:/fixtures`, scratch);
    const fixtures = path.join(scratch, 'fixtures');
    // ssh-add refuses private keys others could read.
    for (const name of readdirSync(fixtures)) chmodSync(path.join(fixtures, name), 0o600);
    project.provide('openssh', { container, port, fixtures });
  } catch (err) {
    stop();
    throw err;
  }
  return stop;
}
