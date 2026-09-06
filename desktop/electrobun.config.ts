import type { ElectrobunConfig } from 'electrobun';
import metadata from './package.json';

if (process.platform === 'darwin' && process.arch !== 'arm64') {
  throw new Error('The Electrobun desktop build requires an Apple Silicon Mac.');
}
const renderer = { bundleCEF: false, defaultRenderer: 'native' as const };
export default {
  app: { name: 'Muxus', identifier: 'io.github.flosch62.muxus', version: metadata.version },
  build: {
    mainProcess: 'bun',
    bun: {
      entrypoint: 'dist/main.js',
      external: ['serialport', '@napi-rs/keyring', 'bufferutil', 'utf-8-validate', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
      define: { 'process.env.NODE_ENV': '"production"' },
    },
    copy: { '../client/dist': 'client', 'dist/preload.js': 'preload.js' },
    mac: { ...renderer, icons: 'assets/icon.iconset', codesign: true, notarize: false },
    linux: { ...renderer, icon: 'assets/icon.png' },
    win: { ...renderer, icon: 'assets/icon.iconset/icon_256x256.png' },
  },
  scripts: { postBuild: 'scripts/finalize.ts' },
  runtime: { exitOnLastWindowClosed: false },
  release: { baseUrl: 'https://github.com/FloSch62/muxus/releases/latest/download', generatePatch: true },
} satisfies ElectrobunConfig;
