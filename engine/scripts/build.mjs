// Builds the engine for this computer, or for each Rust target named in
// MUXUS_ENGINE_TARGETS (comma separated): the macOS release builds both CPUs.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// The CLI's own script, run by this Node. Its `napi` shim is a .cmd file on
// Windows, which only starts through a shell.
const require = createRequire(import.meta.url);
const manifest = require.resolve('@napi-rs/cli/package.json');
const cli = path.join(path.dirname(manifest), require(manifest).bin.napi);

const debug = process.argv.includes('--debug');
const targets = (process.env.MUXUS_ENGINE_TARGETS ?? '')
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean);

function build(extra) {
  const args = ['build', '--platform', ...(debug ? [] : ['--release']), '--no-js', '--dts', 'index.d.ts', ...extra];
  const { status } = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}

if (targets.length === 0) build([]);
else for (const target of targets) build(['--target', target]);
