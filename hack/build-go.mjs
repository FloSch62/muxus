#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const targetOS = process.env.GOOS || ({ win32: 'windows', darwin: 'darwin' }[process.platform] ?? 'linux');
const output = path.join(root, 'build', targetOS === 'windows' ? 'muxus.exe' : 'muxus');
const tags = ['production', ...(targetOS === 'linux' ? ['gtk3'] : [])].join(',');
const ldflags = [
  '-s',
  '-w',
  ...(targetOS === 'windows' ? ['-H=windowsgui'] : []),
  `-X github.com/FloSch62/muxus/app/internal/version.Version=${pkg.version}`,
].join(' ');

await fs.mkdir(path.dirname(output), { recursive: true });

const child = spawn(
  'go',
  [
    'build',
    '-tags',
    tags,
    '-trimpath',
    '-buildvcs=false',
    '-ldflags',
    ldflags,
    '-o',
    output,
    './cmd/muxus',
  ],
  { cwd: path.join(root, 'app'), env: process.env, stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
