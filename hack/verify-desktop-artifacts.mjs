import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { verifyMacOSArtifacts } from './verify-macos-artifacts.mjs';

const dir = path.resolve('desktop/artifacts');
const files = readdirSync(dir);
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux';
assert.ok(process.platform !== 'darwin' || process.arch === 'arm64', 'macOS releases require Apple Silicon');
const installer = files.find((name) => name.startsWith(`${platform}-${process.arch}-`) && name.endsWith(process.platform === 'darwin' ? '.dmg' : process.platform === 'win32' ? '-Setup.zip' : '-Setup.tar.gz'));
assert.ok(installer, `Missing ${platform}/${process.arch} installer in ${dir}`);
assert.ok(statSync(path.join(dir, installer)).size > 0, 'Empty installer');
const manifest = files.find((name) => name === `stable-${platform}-${process.arch}-update.json`);
assert.ok(manifest, 'Missing release metadata');
const update = JSON.parse(readFileSync(path.join(dir, manifest), 'utf8'));
const { version } = JSON.parse(readFileSync('desktop/package.json', 'utf8'));
assert.equal(update.version, version, 'Installer metadata version differs from Muxus');
assert.equal(update.platform, platform);
assert.equal(update.arch, process.arch);
assert.equal(update.channel, 'stable');
assert.equal(update.identifier, 'io.github.flosch62.muxus');
assert.ok(typeof update.artifact?.file === 'string' && path.basename(update.artifact.file) === update.artifact.file, 'Invalid update bundle filename');
assert.ok(statSync(path.join(dir, update.artifact.file)).size > 0, 'Missing or empty update bundle');
assert.ok(!files.some((name) => /macos-(x64|universal)/.test(name)), 'Unsupported macOS architecture');
console.log(`Verified ${platform}/${process.arch} installer and version ${version}`);

if (platform === 'macos') {
  verifyMacOSArtifacts(path.join(dir, installer), path.join(dir, update.artifact.file));
}

if (platform === 'linux') {
  const deb = path.join(dir, `muxus-${version}-linux-${process.arch}.deb`);
  assert.ok(statSync(deb).size < 80 * 1024 * 1024, 'Debian package exceeds the 80 MiB size budget');
  const contents = execFileSync('dpkg-deb', ['--contents', deb], { encoding: 'utf8' });
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    assert.ok(contents.includes(`./usr/share/icons/hicolor/${size}x${size}/apps/muxus.png`), `Missing ${size}px desktop icon`);
  }
  assert.ok(contents.includes('./opt/muxus/Resources/app/bun/history-worker.js'), 'Missing Bun history worker');
  assert.ok(contents.includes('./opt/muxus/Resources/node_modules/serialport/'), 'Missing native serial package');
  assert.ok(contents.includes('./opt/muxus/Resources/node_modules/@napi-rs/keyring/'), 'Missing native keyring package');
  assert.ok(contents.includes('./opt/muxus/Resources/app/package-manager'), 'Missing Debian update policy marker');
  assert.ok(contents.includes('./opt/muxus/bin/Resources/appIcon.png'), 'Missing native window icon');
  assert.ok(contents.includes('./usr/share/applications/io.github.flosch62.muxus.desktop'), 'Missing desktop entry');
  assert.ok(!/\/(?:libcef\.so|chrome-sandbox|chrome_elf\.dll|icudtl\.dat)(?:\s|$)/m.test(contents), 'Unexpected bundled Chromium runtime');
  console.log(`Debian package: ${(statSync(deb).size / 1024 / 1024).toFixed(1)} MiB (budget: 80 MiB)`);
}
