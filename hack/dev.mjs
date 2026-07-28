#!/usr/bin/env node
// Development orchestrator: shared type watch + Vite client + the Go server.
// Replaces `pnpm -r --parallel dev`, which would start the retired Node
// server on the same port the Go server owns.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const children = [];
let shuttingDown = false;

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} exited with code ${code}; stopping the rest`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('shared', 'pnpm', ['--filter', '@muxus/shared', 'dev']);
run('client', 'pnpm', ['--filter', '@muxus/client', 'dev']);
const platformTags = process.platform === 'linux' ? ['-tags', 'gtk3'] : [];
run('server', 'go', ['run', ...platformTags, './cmd/muxus', 'serve', '--port', '3002'], {
  cwd: path.join(repoRoot, 'app'),
  env: { MUXUS_DEV: '1' },
});
