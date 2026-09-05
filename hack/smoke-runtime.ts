import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const desktop = path.resolve('desktop');
const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux';
const buildDir = path.join(desktop, `build/dev-${platform}-${process.arch}`);
const app = process.env.MUXUS_SMOKE_APP ?? path.join(buildDir, readdirSync(buildDir).find((name) => name.startsWith('Muxus'))!);
const resources = path.join(app, process.platform === 'darwin' ? 'Contents/Resources' : 'Resources');
const binary = path.join(app, process.platform === 'darwin' ? 'Contents/MacOS/bun' : `bin/bun${process.platform === 'win32' ? '.exe' : ''}`);
assert.ok(existsSync(binary), `Packaged Bun is missing: ${binary}`);
const require = createRequire(path.join(desktop, 'package.json'));
const nativeRequire = createRequire(path.join(resources, 'package.json'));
const { build } = require('esbuild') as typeof import('../desktop/node_modules/esbuild');
const scratch = mkdtempSync(path.join(tmpdir(), 'muxus-runtime-'));
try {
  cpSync(path.join(resources, 'app/bun/history-worker.js'), path.join(scratch, 'history-worker.js'));
  await build({
    entryPoints: ['hack/runtime-check.ts'], outfile: path.join(scratch, 'check.mjs'), bundle: true,
    platform: 'node', format: 'esm', target: 'es2022',
    external: ['bun:sqlite', 'bufferutil', 'utf-8-validate', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
    plugins: [{ name: 'packaged-native-modules', setup(builder) {
      builder.onResolve({ filter: /^(?:\.\.\/server\/node_modules\/)?(serialport|@napi-rs\/keyring)$/ }, ({ path: name }) => ({ path: nativeRequire.resolve(name.replace('../server/node_modules/', '')), external: true }));
    } }],
    banner: { js: "import { createRequire as __muxusRequire } from 'node:module'; const require = __muxusRequire(import.meta.url);" },
  });
  const result = spawnSync(binary, [path.join(scratch, 'check.mjs')], {
    stdio: 'inherit', timeout: 60_000,
    env: { ...process.env, MUXUS_SMOKE_ROOT: scratch, MUXUS_SMOKE_STATIC: path.join(resources, 'app/client'), MUXUS_SSH_CONFIG: path.join(scratch, 'ssh-config'), NODE_ENV: 'production' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Packaged runtime checks failed');
} finally { rmSync(scratch, { recursive: true, force: true }); }
