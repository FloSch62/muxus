#!/usr/bin/env node
/**
 * Copy the containerlab topology viewer (@containerlab/clab-viewer) into
 * client/public/vendor/clab-viewer, where Muxus serves it to the lab view.
 *
 * The viewer is not published to npm yet, so it is vendored from a build of
 * the containerlab-app repository. Build it there first (`pnpm viewer`), then:
 *
 *   node client/scripts/sync-clab-viewer.mjs [path/to/clab-viewer/dist]
 *
 * The default source is a containerlab-app checkout next to this repository's
 * parent directory (../clab/containerlab-app). The whole dist/ directory is
 * copied: viewer.html resolves its assets relative to itself.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const output = join(repoRoot, 'client', 'public', 'vendor', 'clab-viewer');
const packageDir = resolve(
  process.argv[2] ? resolve(process.argv[2], '..') : join(repoRoot, '..', 'clab', 'containerlab-app', 'packages', 'clab-viewer'),
);
const dist = process.argv[2] ? resolve(process.argv[2]) : join(packageDir, 'dist');

if (!existsSync(join(dist, 'viewer.html'))) {
  console.error(`No viewer build at ${dist}. Run \`pnpm viewer\` in containerlab-app first.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
let commit = 'unknown';
try {
  commit = execFileSync('git', ['-C', packageDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // Not a git checkout; the version still identifies the build.
}

rmSync(output, { recursive: true, force: true });
// Muxus frames viewer.html directly: the <clab-topology> element, the bundler
// entry, type declarations and the build's size report are not needed.
const UNUSED = new Set(['component.mjs', 'component.css', 'index.js', 'startup-budget.json']);
cpSync(dist, output, {
  recursive: true,
  filter: (source) => !source.endsWith('.d.ts') && !UNUSED.has(relative(dist, source)),
});
const license = join(packageDir, 'LICENSE');
if (existsSync(license)) cpSync(license, join(output, 'LICENSE'));
writeFileSync(
  join(output, 'README.md'),
  [
    '# Containerlab topology viewer (vendored)',
    '',
    'Copied by `client/scripts/sync-clab-viewer.mjs`; do not edit by hand.',
    '',
    `- Package: \`${manifest.name}\` ${manifest.version}`,
    '- Source: https://github.com/srl-labs/containerlab-app/tree/main/packages/clab-viewer',
    `- Commit: \`${commit}\``,
    '',
    'Muxus frames `viewer.html` and drives it with the `clab-viewer:*` message',
    'protocol. The viewer is MIT-licensed; see LICENSE.',
    '',
  ].join('\n'),
);
console.log(`Copied ${manifest.name} ${manifest.version} (${commit.slice(0, 12)}) to ${output}`);
