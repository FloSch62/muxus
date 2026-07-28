#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const targetOS = process.env.GOOS || ({ win32: 'windows', darwin: 'darwin' }[process.platform] ?? 'linux');
const targetArch = process.env.GOARCH || ({ x64: 'x64', arm64: 'arm64' }[process.arch] ?? process.arch);
const binaryName = targetOS === 'windows' ? 'muxus.exe' : 'muxus';
const binary = path.join(root, 'build', binaryName);
const limit = 30_000_000;

const info = await fs.stat(binary);
if (info.size > limit) {
  throw new Error(`production binary is ${info.size} bytes; the release limit is ${limit}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} stopped by ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with ${code}`));
      } else {
        resolve();
      }
    });
  });
}

const stem = `muxus-v${pkg.version}-${targetOS === 'darwin' ? 'macos' : targetOS}-${targetArch}`;
if (targetOS === 'windows') {
  const archive = path.join(root, 'build', `${stem}.zip`);
  await fs.rm(archive, { force: true });
  await run('tar', ['-a', '-c', '-f', archive, '-C', path.join(root, 'build'), binaryName]);
  console.log(archive);
} else if (targetOS === 'darwin') {
  const app = path.join(root, 'build', 'Muxus.app');
  const contents = path.join(app, 'Contents');
  const executableDir = path.join(contents, 'MacOS');
  const resourcesDir = path.join(contents, 'Resources');
  await fs.rm(app, { recursive: true, force: true });
  await fs.mkdir(executableDir, { recursive: true });
  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.copyFile(binary, path.join(executableDir, 'muxus'));
  await fs.copyFile(path.join(root, 'client', 'public', 'muxus.svg'), path.join(resourcesDir, 'muxus.svg'));
  const template = await fs.readFile(path.join(root, 'packaging', 'darwin', 'Info.plist'), 'utf8');
  await fs.writeFile(path.join(contents, 'Info.plist'), template.replaceAll('@VERSION@', pkg.version));
  await run('codesign', ['--force', '--deep', '--sign', '-', app]);
  const archive = path.join(root, 'build', `${stem}.zip`);
  await fs.rm(archive, { force: true });
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  console.log(archive);
} else {
  const archive = path.join(root, 'build', `${stem}.tar.gz`);
  await fs.rm(archive, { force: true });
  await run('tar', ['-czf', archive, '-C', path.join(root, 'build'), binaryName]);
  console.log(archive);

  const debArchitecture = {
    x64: 'amd64',
    amd64: 'amd64',
    arm64: 'arm64',
    arm: 'armhf',
  }[targetArch];
  if (!debArchitecture) {
    throw new Error(`unsupported Debian architecture: ${targetArch}`);
  }

  const debVersion = `${pkg.version}-2`;
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'muxus-deb-'));
  const deb = path.join(root, 'build', `muxus_${debVersion}_${debArchitecture}.deb`);
  try {
    await fs.chmod(staging, 0o755);
    const controlDir = path.join(staging, 'DEBIAN');
    const binDir = path.join(staging, 'usr', 'bin');
    const applicationsDir = path.join(staging, 'usr', 'share', 'applications');
    const iconDir = path.join(staging, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps');
    const pngIconDir = path.join(staging, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps');
    const docsDir = path.join(staging, 'usr', 'share', 'doc', 'muxus');
    await Promise.all([
      fs.mkdir(controlDir, { recursive: true }),
      fs.mkdir(binDir, { recursive: true }),
      fs.mkdir(applicationsDir, { recursive: true }),
      fs.mkdir(iconDir, { recursive: true }),
      fs.mkdir(pngIconDir, { recursive: true }),
      fs.mkdir(docsDir, { recursive: true }),
    ]);
    for (const directory of [
      controlDir,
      binDir,
      applicationsDir,
      iconDir,
      pngIconDir,
      docsDir,
      path.join(staging, 'usr'),
      path.join(staging, 'usr', 'share'),
      path.join(staging, 'usr', 'share', 'applications'),
      path.join(staging, 'usr', 'share', 'icons'),
      path.join(staging, 'usr', 'share', 'icons', 'hicolor'),
      path.join(staging, 'usr', 'share', 'icons', 'hicolor', 'scalable'),
      path.join(staging, 'usr', 'share', 'icons', 'hicolor', '256x256'),
      path.join(staging, 'usr', 'share', 'doc'),
    ]) {
      await fs.chmod(directory, 0o755);
    }

    const control = [
      'Package: muxus',
      `Version: ${debVersion}`,
      'Section: net',
      'Priority: optional',
      `Architecture: ${debArchitecture}`,
      'Maintainer: Muxus contributors <FloSch62@users.noreply.github.com>',
      'Homepage: https://github.com/FloSch62/muxus',
      'Depends: libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0',
      'Description: SSH, Telnet and serial desktop client',
      ' Muxus provides split terminal panes, saved workspaces, SFTP,',
      ' remote editing, saved tunnels and inline terminal images.',
      '',
    ].join('\n');
    await fs.writeFile(path.join(controlDir, 'control'), control);
    await fs.chmod(path.join(controlDir, 'control'), 0o644);
    for (const script of ['postinst', 'postrm']) {
      await fs.copyFile(
        path.join(root, 'packaging', 'linux', script),
        path.join(controlDir, script),
      );
      await fs.chmod(path.join(controlDir, script), 0o755);
    }
    await fs.copyFile(binary, path.join(binDir, 'muxus'));
    await fs.chmod(path.join(binDir, 'muxus'), 0o755);
    await fs.copyFile(
      path.join(root, 'packaging', 'linux', 'muxus.desktop'),
      path.join(applicationsDir, 'muxus.desktop'),
    );
    await fs.copyFile(
      path.join(root, 'client', 'public', 'muxus.svg'),
      path.join(iconDir, 'muxus.svg'),
    );
    await fs.copyFile(path.join(root, 'app', 'internal', 'shell', 'appicon.png'), path.join(pngIconDir, 'muxus.png'));
    await fs.copyFile(path.join(root, 'LICENSE'), path.join(docsDir, 'copyright'));
    await Promise.all([
      fs.chmod(path.join(applicationsDir, 'muxus.desktop'), 0o644),
      fs.chmod(path.join(iconDir, 'muxus.svg'), 0o644),
      fs.chmod(path.join(pngIconDir, 'muxus.png'), 0o644),
      fs.chmod(path.join(docsDir, 'copyright'), 0o644),
    ]);
    await fs.rm(deb, { force: true });
    await run('dpkg-deb', ['--root-owner-group', '--build', staging, deb]);
    console.log(deb);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
