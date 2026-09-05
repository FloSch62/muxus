import { build } from 'esbuild';

// Resolve ssh2 and ws with Node package semantics before the Bun bundler.
// Native Node-API modules ship separately, with their real package directories.
await build({
  entryPoints: ['src/main.ts'], outfile: 'dist/main.js', bundle: true,
  platform: 'node', format: 'esm', target: 'es2022',
  external: ['electrobun/main', 'bun:sqlite', 'serialport', '@napi-rs/keyring', 'bufferutil', 'utf-8-validate', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: "import { createRequire as __muxusRequire } from 'node:module'; import { fileURLToPath as __muxusURL } from 'node:url'; import { dirname as __muxusDir } from 'node:path'; const require = __muxusRequire(import.meta.url); const __filename = __muxusURL(import.meta.url); const __dirname = __muxusDir(__filename);" },
});
