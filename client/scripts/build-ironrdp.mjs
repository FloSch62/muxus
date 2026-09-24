#!/usr/bin/env node
/**
 * Rebuild the vendored IronRDP web client in client/src/vendor/ironrdp.
 *
 * The published @devolutions/iron-remote-desktop-rdp package lags IronRDP by
 * months and misses decoder fixes that xrdp and Windows servers depend on
 * (bitmap stride, RDP6 orientation, bulk decompression), so Muxus builds the
 * WebAssembly module from a pinned commit instead. The output is committed;
 * run this only to move the pin or change the patches below.
 *
 * Needs git, a Rust toolchain (rustup installs the version IronRDP pins), and
 * wasm-pack 0.15 (`cargo install wasm-pack --version 0.15.0 --locked`).
 *
 *   node client/scripts/build-ironrdp.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IRONRDP_REPOSITORY = 'https://github.com/Devolutions/IronRDP.git';
const IRONRDP_COMMIT = '9b151c4c2e47c6014e1e8e55909d4180aa8bdb99';
const PATCHES = ['autologon.patch'];
/** The flags IronRDP's own `cargo xtask web build` uses for release builds. */
const RUSTFLAGS = [
  '-Ctarget-feature=+simd128,+bulk-memory',
  '--cfg getrandom_backend="wasm_js"',
  '-Copt-level=s',
  '-Ccodegen-units=1',
  '-Cllvm-args=-enable-dfa-jump-thread',
].join(' ');

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
// Not the repository's .cache/: the docs build (zensical --clean) wipes it.
const checkout = join(repoRoot, 'node_modules', '.cache', 'ironrdp');
const output = join(repoRoot, 'client', 'src', 'vendor', 'ironrdp');

function run(command, args, cwd, env = process.env) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
}

if (!existsSync(join(checkout, '.git'))) {
  mkdirSync(dirname(checkout), { recursive: true });
  run('git', ['clone', '--filter=blob:none', IRONRDP_REPOSITORY, checkout], repoRoot);
}
run('git', ['fetch', '--quiet', 'origin', IRONRDP_COMMIT], checkout);
run('git', ['checkout', '--quiet', '--force', IRONRDP_COMMIT], checkout);
run('git', ['clean', '--quiet', '-fdx', 'crates/ironrdp-web'], checkout);
for (const patch of PATCHES) {
  run('git', ['apply', join(scriptDir, 'ironrdp', patch)], checkout);
}

run('rustup', ['target', 'add', 'wasm32-unknown-unknown'], checkout);
run('wasm-pack', ['build', '--target', 'web', '--release'], join(checkout, 'crates', 'ironrdp-web'), {
  ...process.env,
  RUSTFLAGS,
});

const pkg = join(checkout, 'crates', 'ironrdp-web', 'pkg');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of ['ironrdp_web.js', 'ironrdp_web.d.ts', 'ironrdp_web_bg.wasm']) {
  copyFileSync(join(pkg, file), join(output, file));
}
for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) {
  copyFileSync(join(checkout, file), join(output, file));
}
const toolchain = readFileSync(join(checkout, 'rust-toolchain.toml'), 'utf8').match(/channel\s*=\s*"([^"]+)"/)?.[1];
writeFileSync(
  join(output, 'README.md'),
  `# IronRDP web client (vendored)

Built by \`client/scripts/build-ironrdp.mjs\`; do not edit by hand.

- Source: ${IRONRDP_REPOSITORY}
- Commit: \`${IRONRDP_COMMIT}\`
- Crate: \`crates/ironrdp-web\`, \`wasm-pack build --target web --release\`
- Rust toolchain: ${toolchain ?? 'as pinned by the commit'}
- Patches: ${PATCHES.map((patch) => `\`client/scripts/ironrdp/${patch}\``).join(', ')}

IronRDP is dual-licensed under MIT or Apache-2.0; both texts are included.
`,
);
console.log(`\nWrote ${output}`);
