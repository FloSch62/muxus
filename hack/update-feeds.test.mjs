import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { mergeWindowsFeeds, toYaml } from './update-feeds.mjs';

const fromElectron = createRequire(path.resolve(import.meta.dirname, '../electron/package.json'));
const yaml = createRequire(fromElectron.resolve('electron-updater/package.json'))('js-yaml');

const feed = (arch, overrides = {}) => ({
  version: '0.8.0',
  files: [{ url: `muxus-0.8.0-win-${arch}.exe`, sha512: `${arch}+/sha==`, size: arch === 'x64' ? 101 : 202 }],
  path: `muxus-0.8.0-win-${arch}.exe`,
  sha512: `${arch}+/sha==`,
  releaseDate: arch === 'x64' ? '2026-10-02T10:00:00.000Z' : '2026-10-02T10:05:00.000Z',
  ...overrides,
});

await test('lists both Windows installers so electron-updater can choose by architecture', () => {
  const merged = mergeWindowsFeeds({ x64: feed('x64'), arm64: feed('arm64') }, '0.8.0');
  assert.deepEqual(merged.files.map((file) => file.url), ['muxus-0.8.0-win-x64.exe', 'muxus-0.8.0-win-arm64.exe']);
  assert.equal(merged.path, 'muxus-0.8.0-win-x64.exe', 'x64 stays the default for clients that read only path');
  assert.equal(merged.releaseDate, '2026-10-02T10:05:00.000Z');
});

await test('writes YAML that electron-updater parses back to the merged feed', () => {
  const merged = mergeWindowsFeeds({ x64: feed('x64'), arm64: feed('arm64') }, '0.8.0');
  assert.deepEqual(yaml.load(toYaml(merged)), merged);
});

await test('refuses feeds from another release or with the wrong installer', () => {
  assert.throws(() => mergeWindowsFeeds({ x64: feed('x64'), arm64: feed('arm64', { version: '0.7.0' }) }, '0.8.0'), /not 0\.8\.0/);
  assert.throws(() => mergeWindowsFeeds({ x64: feed('arm64'), arm64: feed('arm64') }, '0.8.0'), /x64 feed lists/);
  assert.throws(() => mergeWindowsFeeds({ x64: feed('x64'), arm64: undefined }, '0.8.0'), /arm64 feed has no version/);
  const twoFiles = feed('x64');
  twoFiles.files.push(twoFiles.files[0]);
  assert.throws(() => mergeWindowsFeeds({ x64: twoFiles, arm64: feed('arm64') }, '0.8.0'), /exactly one installer/);
});
