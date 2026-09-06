import assert from 'node:assert/strict';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux', 'Debian packages must be built on Linux');
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
assert.ok(arch, `Unsupported Debian architecture: ${process.arch}`);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(desktop, 'artifacts');
const metadata = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const release = JSON.parse(readFileSync(path.join(artifacts, `stable-linux-${process.arch}-update.json`), 'utf8'));
assert.equal(release.version, metadata.version, 'Build the current stable release before packaging a .deb');
assert.equal(release.platform, 'linux');
assert.equal(release.arch, process.arch);
assert.equal(release.channel, 'stable');
assert.equal(release.identifier, 'io.github.flosch62.muxus');
assert.equal(path.basename(release.artifact.file), release.artifact.file);
const scratch = mkdtempSync(path.join(tmpdir(), 'muxus-deb-'));
try {
  // Package the actual app payload, not Electrobun's self-extracting installer.
  execFileSync('tar', ['--zstd', '-xf', path.join(artifacts, release.artifact.file), '-C', scratch], { stdio: 'inherit' });
  const stage = path.join(scratch, 'package');
  const put = (name, contents, mode = 0o644) => {
    const file = path.join(stage, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, { mode });
  };
  mkdirSync(path.join(stage, 'opt'), { recursive: true });
  renameSync(path.join(scratch, 'Muxus'), path.join(stage, 'opt/muxus'));
  for (const file of ['bin/launcher', 'bin/bun', 'bin/muxus-native', 'Resources/main.js', 'Resources/app/client/index.html']) {
    assert.ok(lstatSync(path.join(stage, 'opt/muxus', file)).isFile(), `Missing application payload: ${file}`);
  }
  put('opt/muxus/Resources/app/package-manager', 'deb\n');
  put('usr/bin/muxus', '#!/bin/sh\nexec /opt/muxus/bin/launcher "$@"\n', 0o755);
  put('usr/share/applications/io.github.flosch62.muxus.desktop', `[Desktop Entry]
Type=Application
Name=Muxus
Comment=SSH, Telnet and serial client
Exec=muxus
Icon=muxus
Terminal=false
Categories=Network;
StartupWMClass=Muxus
`);
  // hicolor's index.theme advertises sizes through 512px, not 1024px.
  // Install the common menu/taskbar sizes so GTK can actually resolve Icon=muxus.
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const folder = path.join(stage, `usr/share/icons/hicolor/${size}x${size}/apps`);
    mkdirSync(folder, { recursive: true });
    await sharp(path.join(stage, 'opt/muxus/Resources/app/icon.png')).resize(size, size).png().toFile(path.join(folder, 'muxus.png'));
  }
  mkdirSync(path.join(stage, 'usr/share/doc/muxus'), { recursive: true });
  copyFileSync(path.join(desktop, '../LICENSE'), path.join(stage, 'usr/share/doc/muxus/copyright'));
  const depends = [
    'libc6 (>= 2.35)', 'libgcc-s1', 'libstdc++6',
    'libgtk-3-0t64 | libgtk-3-0', 'libwebkit2gtk-4.1-0',
    'libayatana-appindicator3-1', 'libsecret-1-0', 'fontconfig', 'ca-certificates', 'xdg-utils',
  ];
  let bytes = 0;
  const normalize = (dir) => {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name), stat = lstatSync(file);
      if (stat.isDirectory()) normalize(file);
      else if (stat.isFile()) { bytes += stat.size; chmodSync(file, stat.mode & 0o111 ? 0o755 : 0o644); }
    }
  };
  normalize(stage);
  put('DEBIAN/control', `Package: muxus
Version: ${metadata.version}
Architecture: ${arch}
Maintainer: ${metadata.author.name} <${metadata.author.email}>
Section: utils
Priority: optional
Installed-Size: ${Math.ceil(bytes / 1024)}
Depends: ${depends.join(', ')}
Homepage: ${metadata.homepage}
Description: SSH, Telnet and serial client
 Split-pane terminals, SFTP, port forwarding and searchable session history.
 Includes Electrobun and Bun; uses the system WebKitGTK renderer.
`);
  chmodSync(path.join(stage, 'DEBIAN'), 0o755);
  chmodSync(path.join(stage, 'DEBIAN/control'), 0o644);
  // Desktop/icon caches are maintained by their owning packages' dpkg triggers.
  const output = path.join(artifacts, `muxus-${metadata.version}-linux-${process.arch}.deb`);
  const pending = path.join(scratch, 'muxus.deb');
  execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '-z6', '--threads-max=2', '--build', stage, pending], { stdio: 'inherit' });
  copyFileSync(pending, output);
  console.log(`Debian package: ${output}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
