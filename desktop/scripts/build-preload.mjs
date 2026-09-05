import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const devkit = path.resolve('.hutch/devkit');
const sdk = JSON.parse(readFileSync(path.join(devkit, 'package.json'), 'utf8'));
const target = sdk.exports['./view'];
await build({
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  alias: { 'electrobun/view': path.resolve(devkit, typeof target === 'string' ? target : target.import ?? target.default) },
});
