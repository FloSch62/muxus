// Prepares VcXsrv, the X server Windows builds ship for X11 forwarding:
// download a pinned upstream installer, verify it, unpack it with 7-Zip and
// keep only what `vcxsrv.exe -multiwindow` needs (about 31 of 102 MB; the
// rest is legacy bitmap fonts, demo clients and tools).
//
//   node scripts/vcxsrv.mjs                → electron/vendor/vcxsrv
//   node scripts/vcxsrv.mjs --source DIR   → DIR/vcxsrv-<version>-source.tar.gz
//                                            (GPL corresponding source for releases)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const VCXSRV_VERSION = '21.1.16.1';

const RELEASE = `https://github.com/marchaesen/vcxsrv/releases/download/${VCXSRV_VERSION}`;
const INSTALLER = {
  url: `${RELEASE}/vcxsrv-64.${VCXSRV_VERSION}.installer.exe`,
  sha256: 'df7fed8f49665d0592528ab6be9d07111ea73c6848283d128b77690e05b8f90b',
};
const LICENSE = {
  url: `https://raw.githubusercontent.com/marchaesen/vcxsrv/${VCXSRV_VERSION}/COPYING`,
  sha256: '0b383d5a63da644f628d99c33976ea6487ed89aaa59f0b3257992deac1171e6b',
};
export const VCXSRV_SOURCE_URL = `https://github.com/marchaesen/vcxsrv/archive/refs/tags/${VCXSRV_VERSION}.tar.gz`;

/**
 * What the server loads at startup: its DLL imports, xkbcomp for the keymap,
 * the keyboard data, and the misc fonts that hold the required "fixed" and
 * "cursor" fonts. GLX uses the native WGL driver (-wgl), so Mesa's software
 * renderer stays out.
 */
export const VCXSRV_FILES = [
  'vcxsrv.exe',
  'xkbcomp.exe',
  'freetype.dll',
  'libX11.dll',
  'libXau.dll',
  'libxcb.dll',
  'libcrypto-3-x64.dll',
  'zlib1.dll',
  'vcruntime140.dll',
  'xkbdata',
  'fonts/misc',
  'fonts/fonts.conf',
  'font-dirs',
  'locale',
  'XErrorDB',
  'xkeysymdb',
  'protocol.txt',
  'system.XWinrc',
];

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VCXSRV_DIR = path.join(electronDir, 'vendor', 'vcxsrv');
const CACHE_DIR = path.join(electronDir, 'vendor', '.cache');

/** Build electron/vendor/vcxsrv unless it already holds this version. */
export async function prepareVcxsrv() {
  const stamp = path.join(VCXSRV_DIR, '.version');
  if (readText(stamp) === VCXSRV_VERSION) return VCXSRV_DIR;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const installer = await download(INSTALLER, path.join(CACHE_DIR, `vcxsrv-${VCXSRV_VERSION}.installer.exe`));
  const license = await download(LICENSE, path.join(CACHE_DIR, `vcxsrv-${VCXSRV_VERSION}.COPYING`));
  const sevenZip = findSevenZip();
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'muxus-vcxsrv-'));
  try {
    const result = spawnSync(sevenZip, ['x', '-y', `-o${unpacked}`, installer], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (result.status !== 0) {
      throw new Error(`7-Zip could not unpack the VcXsrv installer: ${result.stderr?.toString().trim() || `exit ${result.status}`}`);
    }
    fs.rmSync(VCXSRV_DIR, { recursive: true, force: true });
    for (const entry of VCXSRV_FILES) {
      const from = path.join(unpacked, entry);
      if (!fs.existsSync(from)) throw new Error(`VcXsrv ${VCXSRV_VERSION} has no ${entry}; update VCXSRV_FILES`);
      fs.cpSync(from, path.join(VCXSRV_DIR, entry), { recursive: true });
    }
    fs.copyFileSync(license, path.join(VCXSRV_DIR, 'COPYING'));
    fs.writeFileSync(path.join(VCXSRV_DIR, 'NOTICE.txt'), notice());
    fs.writeFileSync(stamp, VCXSRV_VERSION);
  } finally {
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
  return VCXSRV_DIR;
}

function notice() {
  return `VcXsrv ${VCXSRV_VERSION} — the X server Muxus uses for X11 forwarding on Windows.

VcXsrv is free software, distributed under the GNU General Public License
version 3 (see COPYING). Muxus runs it as a separate program and ships an
unmodified subset of the upstream build:

  ${INSTALLER.url}

The complete corresponding source code is available from:

  ${VCXSRV_SOURCE_URL}

and is attached to every Muxus release on GitHub.

Bundled components keep their own licenses: the X.Org server, libraries,
keyboard data and fonts (MIT/X11-style licenses), FreeType (FreeType License),
OpenSSL libcrypto (Apache License 2.0), zlib (zlib License) and the Microsoft
Visual C++ runtime (redistributable under the Visual Studio license terms).
`;
}

async function download({ url, sha256 }, file) {
  if (fs.existsSync(file) && hashFile(file) === sha256) return file;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} (HTTP ${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== sha256) throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
  fs.writeFileSync(file, data);
  return file;
}

/** VcXsrv ships as an NSIS installer, which only full 7-Zip builds unpack. */
function findSevenZip() {
  const candidates = [
    process.env.MUXUS_7ZIP,
    '7z',
    '7zz',
    process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['i'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('7-Zip is required to unpack VcXsrv: put 7z or 7zz on PATH, or set MUXUS_7ZIP.');
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Save the upstream source archive for this version into `directory`. */
export async function downloadVcxsrvSource(directory) {
  const response = await fetch(VCXSRV_SOURCE_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${VCXSRV_SOURCE_URL} (HTTP ${response.status})`);
  }
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `vcxsrv-${VCXSRV_VERSION}-source.tar.gz`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceFlag = process.argv.indexOf('--source');
  if (sourceFlag >= 0) {
    const directory = process.argv[sourceFlag + 1];
    if (!directory) throw new Error('--source needs a target directory');
    console.log(`VcXsrv ${VCXSRV_VERSION} source saved to ${await downloadVcxsrvSource(directory)}`);
  } else {
    console.log(`VcXsrv ${VCXSRV_VERSION} ready in ${await prepareVcxsrv()}`);
  }
}
