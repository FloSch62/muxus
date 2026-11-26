// Every binary in the Linux app has to load on the oldest glibc Muxus supports.
// Native modules are compiled on the build machine and inherit its glibc: an
// image with glibc 2.42 produced a node-pty that no older distribution could
// load, and nothing failed until people started the app.
//
//   node hack/verify-linux-glibc.mjs [unpacked app directory]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** glibc of Ubuntu 24.04, the image the Linux packages are built on. */
export const GLIBC_FLOOR = '2.39';

// Requirements glibc names instead of numbering, and the release that added them.
const NAMED_TAGS = { GLIBC_ABI_DT_RELR: '2.36' };

/** The glibc release a version tag stands for; undefined when it is not known. */
export function glibcRelease(tag) {
  const number = tag.slice('GLIBC_'.length);
  return /^\d+(\.\d+)+$/.test(number) ? number : NAMED_TAGS[tag];
}

const isNewer = (release, than) => release.localeCompare(than, 'en', { numeric: true }) > 0;

/**
 * The glibc version tags one binary depends on, each with the symbols that
 * pull it in, read from `readelf --version-info --dyn-syms --wide`.
 */
export function glibcRequirements(readelfOutput) {
  const requirements = new Map();
  for (const [, tag] of readelfOutput.matchAll(/\bName: (GLIBC_[\w.]+)/g)) requirements.set(tag, []);
  for (const [, symbol, tag] of readelfOutput.matchAll(/\bUND (\S+?)@(GLIBC_[\w.]+)/g)) requirements.get(tag)?.push(symbol);
  return requirements;
}

/** The requirements a system with glibc `floor` cannot meet, as readable lines. */
export function unmetRequirements(requirements, floor = GLIBC_FLOOR) {
  const unmet = [];
  for (const [tag, symbols] of requirements) {
    const release = glibcRelease(tag);
    if (release && !isNewer(release, floor)) continue;
    const reason = release ? '' : ', a requirement this check does not know';
    unmet.push(`${tag}${reason}${symbols.length > 0 ? ` (${symbols.join(', ')})` : ''}`);
  }
  return unmet;
}

function isElf(file) {
  const magic = Buffer.alloc(4);
  const descriptor = openSync(file, 'r');
  try {
    return readSync(descriptor, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from('\x7fELF', 'latin1'));
  } finally {
    closeSync(descriptor);
  }
}

function verify(directory) {
  const failures = [];
  let checked = 0;
  let newest = { release: '0', file: '' };
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() || !isElf(file)) continue;
    checked += 1;
    const name = path.relative(directory, file);
    const requirements = glibcRequirements(execFileSync('readelf', ['--version-info', '--dyn-syms', '--wide', file], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }));
    for (const tag of requirements.keys()) {
      const release = glibcRelease(tag);
      if (release && isNewer(release, newest.release)) newest = { release, file: name };
    }
    for (const requirement of unmetRequirements(requirements)) failures.push(`  ${name}: ${requirement}`);
  }
  assert.ok(checked > 0, `No Linux binaries found in ${directory}`);
  if (failures.length > 0) {
    console.error(`These binaries need a glibc newer than ${GLIBC_FLOOR}, so Muxus would not start on older distributions:`);
    console.error(failures.join('\n'));
    console.error(`Build them on a system with glibc ${GLIBC_FLOOR} or older, or raise GLIBC_FLOOR if dropping those distributions is intended.`);
    process.exit(1);
  }
  console.log(`Checked ${checked} ${checked === 1 ? 'binary' : 'binaries'} against glibc ${GLIBC_FLOOR}; the newest one needed is ${newest.release} (${newest.file}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify(path.resolve(process.argv[2] ?? 'electron/release/linux-unpacked'));
}
