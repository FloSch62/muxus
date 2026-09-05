import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export function verifyMacOSArtifacts(dmg, archive) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'muxus-signatures-'));
  const mount = path.join(scratch, 'dmg');
  mkdirSync(mount);
  let mounted = false;
  try {
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'inherit' });
    mounted = true;
    const wrapper = path.join(mount, 'Muxus.app');
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=4', wrapper], { stdio: 'inherit' });

    // The first launch replaces the wrapper with this app. Verify the exact
    // embedded payload as well as the independently published update archive.
    const resources = path.join(wrapper, 'Contents', 'Resources');
    const payloads = readdirSync(resources).filter((name) => name.endsWith('.tar.zst'));
    assert.equal(payloads.length, 1, 'Expected one macOS installer payload');
    const payload = readFileSync(path.join(resources, payloads[0]));
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest(payload), digest(readFileSync(archive)), 'DMG payload differs from update archive');

    const tar = path.join(scratch, 'app.tar');
    writeFileSync(tar, zstdDecompressSync(payload));
    const expanded = path.join(scratch, 'expanded');
    mkdirSync(expanded);
    execFileSync('tar', ['-xf', tar, '-C', expanded], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=4', path.join(expanded, 'Muxus.app')], { stdio: 'inherit' });
    console.log('Verified macOS installer and update app signatures');
  } finally {
    // Do not recursively remove a mount if detach fails.
    if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
    rmSync(scratch, { recursive: true, force: true });
  }
}
