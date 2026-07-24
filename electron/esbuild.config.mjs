import { build } from 'esbuild';

// Bundle the main process plus the whole server into one ESM file so the
// packaged app needs no node_modules for JS deps (pnpm symlinks never reach
// the asar). node-pty and serialport stay external: they include native
// modules, are packaged as real node_modules dependencies, and are rebuilt
// for Electron's ABI.
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // bufferutil/utf-8-validate are optional ws natives we don't install;
  // cpu-features/sshcrypto are ssh2's optional native accelerators.
  external: ['electron', 'node-pty', 'serialport', 'bufferutil', 'utf-8-validate', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    // CJS deps converted into the ESM bundle still call require() and read
    // __dirname/__filename at runtime (ssh2 does both). Import bindings use
    // names no bundled module can collide with — esbuild injects the banner
    // verbatim and cannot rename around it. Our own ESM modules must not
    // declare bare __dirname/__filename at top level for the same reason.
    js: [
      "import { createRequire as __muxusCreateRequire } from 'node:module';",
      "import { fileURLToPath as __muxusFileURLToPath } from 'node:url';",
      "import { dirname as __muxusPathDirname } from 'node:path';",
      'const require = __muxusCreateRequire(import.meta.url);',
      'const __filename = __muxusFileURLToPath(import.meta.url);',
      'const __dirname = __muxusPathDirname(__filename);',
    ].join('\n'),
  },
});

// Session payloads, compression, FTS, and quota maintenance run in a real
// worker. Keep it beside main.js so the bundled server's import.meta.url
// resolves the same way as the standalone server build.
await build({
  entryPoints: ['../server/src/session-logging/history-worker.js'],
  bundle: true,
  outfile: 'dist/history-worker.js',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
});

// The preload runs in the sandboxed renderer, which only supports CJS.
await build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  outfile: 'dist/preload.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
});
