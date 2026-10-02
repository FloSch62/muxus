// Windows x64 and ARM64 installers are built in separate jobs, and each writes
// its own latest.yml. electron-updater picks the file whose name contains the
// running CPU architecture, so the published feed must list both installers.
//
//   export <x64|arm64>    after a Windows build: latest.yml -> latest-win-<arch>.json
//   merge <dir> <version> in the publish job: both JSON feeds -> one latest.yml
//
// `merge` uses only Node built-ins: the publish job installs no dependencies.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_ARCHES = ['x64', 'arm64'];

function validateFeed(feed, arch, version) {
  assert.equal(typeof feed?.version, 'string', `${arch} feed has no version`);
  if (version) assert.equal(feed.version, version, `${arch} feed is for ${feed.version}, not ${version}`);
  assert.ok(Array.isArray(feed.files) && feed.files.length === 1, `${arch} feed must list exactly one installer`);
  const [file] = feed.files;
  assert.match(file.url, new RegExp(`-win-${arch}\\.exe$`), `${arch} feed lists ${file.url}`);
  assert.equal(typeof file.sha512, 'string', `${arch} installer has no checksum`);
  assert.ok(Number.isSafeInteger(file.size) && file.size > 0, `${arch} installer has no size`);
  return file;
}

/** Combine per-architecture feeds; x64 stays the legacy top-level default. */
export function mergeWindowsFeeds(feeds, version) {
  const files = WINDOWS_ARCHES.map((arch) => validateFeed(feeds[arch], arch, version));
  const releaseDates = WINDOWS_ARCHES.map((arch) => feeds[arch].releaseDate).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return {
    version: feeds.x64.version,
    files: files.map(({ url, sha512, size }) => ({ url, sha512, size })),
    path: files[0].url,
    sha512: files[0].sha512,
    ...(releaseDates.length ? { releaseDate: releaseDates.at(-1) } : {}),
  };
}

/** YAML with JSON-quoted scalars: unambiguous for any YAML parser. */
export function toYaml(feed) {
  const scalar = (value) => (typeof value === 'number' ? String(value) : JSON.stringify(value));
  const lines = [`version: ${scalar(feed.version)}`, 'files:'];
  for (const file of feed.files) {
    lines.push(`  - url: ${scalar(file.url)}`, `    sha512: ${scalar(file.sha512)}`, `    size: ${scalar(file.size)}`);
  }
  lines.push(`path: ${scalar(feed.path)}`, `sha512: ${scalar(feed.sha512)}`);
  if (feed.releaseDate) lines.push(`releaseDate: ${scalar(feed.releaseDate)}`);
  return `${lines.join('\n')}\n`;
}

function exportFeed(arch) {
  assert.ok(WINDOWS_ARCHES.includes(arch), `Unknown Windows architecture: ${arch}`);
  const release = path.resolve('electron/release');
  // js-yaml is electron-updater's own parser, so this reads the feed exactly as clients will.
  const fromElectron = createRequire(path.resolve('electron/package.json'));
  const yaml = createRequire(fromElectron.resolve('electron-updater/package.json'))('js-yaml');
  const source = path.join(release, 'latest.yml');
  const feed = yaml.load(readFileSync(source, 'utf8'));
  validateFeed(feed, arch);
  writeFileSync(path.join(release, `latest-win-${arch}.json`), `${JSON.stringify(feed, null, 2)}\n`);
  rmSync(source);
}

function merge(directory, version) {
  assert.ok(directory && version, 'Usage: node hack/update-feeds.mjs merge <dir> <version>');
  const feeds = Object.fromEntries(WINDOWS_ARCHES.map((arch) => [
    arch, JSON.parse(readFileSync(path.join(directory, `latest-win-${arch}.json`), 'utf8')),
  ]));
  writeFileSync(path.join(directory, 'latest.yml'), toYaml(mergeWindowsFeeds(feeds, version.replace(/^v/, ''))));
  for (const arch of WINDOWS_ARCHES) rmSync(path.join(directory, `latest-win-${arch}.json`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'export') exportFeed(...args);
  else if (command === 'merge') merge(...args);
  else throw new Error('Usage: node hack/update-feeds.mjs export <x64|arm64> | merge <dir> <version>');
}
