import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const directory = path.resolve('electron/release');
const names = readdirSync(directory).filter(name => name.endsWith('.dmg'));
assert.equal(names.length, 1, 'Expected one DMG artifact');
assert.match(names[0], /-mac-universal\.dmg$/, 'macOS releases must remain universal');
const scratch = mkdtempSync(path.join(tmpdir(), 'muxus-signatures-'));
const mount = path.join(scratch, 'dmg');
mkdirSync(mount);
let mounted = false;
try {
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(directory, names[0])]);
  mounted = true;
  const app = path.join(mount, 'Muxus.app');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app]);
  const requirement = 'anchor apple generic and certificate leaf[subject.OU] = "DJY795VD98" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  run('codesign', ['--verify', '-R', `=${requirement}`, app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  const executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const architectures = execFileSync('lipo', ['-archs', path.join(app, 'Contents/MacOS', executable)], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  assert.deepEqual(architectures, ['arm64', 'x86_64']);
  console.log('Verified universal architecture, Developer ID signatures and notarization in the release DMG.');
} finally {
  // Never recursively remove a mount if detach fails.
  if (mounted) run('hdiutil', ['detach', mount]);
  rmSync(scratch, { recursive: true, force: true });
}
