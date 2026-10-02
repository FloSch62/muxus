// Real AppImage updates against localhost: no GitHub release, credentials, or
// installed Muxus profile is used. Run after pnpm build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Arch, build, Platform } from 'electron-builder';
import { _electron as electron } from 'playwright-core';

assert.equal(process.platform, 'linux', 'This integration test requires Linux and tests the AppImage updater.');
assert(process.env.DISPLAY, 'Run with a display or xvfb-run --auto-servernum pnpm test:updater to test automatic relaunch.');
const projectDir = path.resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'muxus-updater-'));
const installed = path.join(scratch, 'Muxus.AppImage');
let userData = path.join(scratch, 'config', 'Muxus');
// A private home keeps the user's ~/.ssh and shell history out of the test.
const home = path.join(scratch, 'home');
const { version: currentVersion } = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
const [major, minor, patch] = currentVersion.split('.').map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;
let manifest;
let candidate;
let app;
let payloadRequests = 0;

const feed = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/latest-linux.yml' && manifest) {
    response.writeHead(200, { 'Content-Type': 'application/yaml', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(manifest)); // JSON is valid YAML.
  } else if (pathname === '/update.AppImage' && candidate) {
    // Deliberately support only full downloads, also exercising the updater's
    // fallback when a provider does not support differential downloads.
    payloadRequests++;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': manifest.files[0].size });
    createReadStream(candidate).pipe(response);
  } else {
    response.writeHead(404);
    response.end();
  }
});

async function hash(file) {
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('base64');
}

async function packageVersion(version) {
  const output = path.join(scratch, `build-${version}`);
  await build({
    projectDir,
    targets: Platform.LINUX.createTarget('AppImage', Arch.x64),
    publish: 'never',
    config: {
      extends: path.join(projectDir, 'electron-builder.yml'),
      directories: { output },
      extraMetadata: { version },
      publish: [{ provider: 'generic', url: `http://127.0.0.1:${feed.address().port}`, useMultipleRangeRequest: false }],
    },
  });
  const files = (await readdir(output)).filter((file) => file.endsWith('.AppImage'));
  assert.equal(files.length, 1);
  return path.join(output, files[0]);
}

async function launch() {
  app = await electron.launch({
    executablePath: installed,
    // Use the default profile inside XDG_CONFIG_HOME so the updater's automatic
    // relaunch (which has no command-line profile override) retains this state.
    args: ['--no-sandbox'],
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: '1',
      TMPDIR: scratch,
      XDG_CONFIG_HOME: path.join(scratch, 'config'),
      XDG_CACHE_HOME: path.join(scratch, 'cache'),
      HOME: home,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.muxusDesktop);
  userData = await app.evaluate(({ app: nativeApp }) => nativeApp.getPath('userData'));
  assert(userData.startsWith(`${scratch}/`), 'The application profile must remain isolated');
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.isPackaged), true);
  return page;
}

async function stopRelaunchedApp() {
  // The updater starts a detached process. Only stop executables extracted
  // beneath this test's private directory, never another running Muxus.
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const executable = await readlink(`/proc/${pid}/exe`).catch(() => '');
    if (executable.startsWith(`${scratch}/`)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

try {
  feed.listen(0, '127.0.0.1');
  await once(feed, 'listening');
  await mkdir(userData, { recursive: true });
  await mkdir(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
  const baseline = await packageVersion(currentVersion);
  candidate = await packageVersion(nextVersion);
  await copyFile(baseline, installed);
  await chmod(installed, 0o755);
  const candidateHash = await hash(candidate);
  const size = (await stat(candidate)).size;
  const makeManifest = (version, sha512) => ({ version, files: [{ url: 'update.AppImage', sha512, size }], path: 'update.AppImage', sha512 });
  manifest = makeManifest(currentVersion, candidateHash);

  let page = await launch();
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.getVersion()), currentVersion);
  await page.evaluate(() => {
    window.updaterTestStates = [];
    window.muxusDesktop.onUpdateState((state) => window.updaterTestStates.push(state));
  });
  assert.equal((await page.evaluate(() => window.muxusDesktop.checkForUpdates())).status, 'up-to-date');
  assert.equal(payloadRequests, 0, 'No payload should download for the installed version');
  console.log('PASS: packaged app checks localhost and reports the installed version as up to date');

  manifest = makeManifest(nextVersion, Buffer.alloc(64).toString('base64'));
  assert.equal((await page.evaluate(() => window.muxusDesktop.checkForUpdates())).status, 'available');
  await page.getByRole('button', { name: 'Download update' }).first().waitFor();
  assert.equal(payloadRequests, 0, 'Discovering an update must not download it');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  assert.equal(payloadRequests, 0, 'Dismissing the notification must not download it');
  console.log('PASS: a newer version only notifies; dismissing it leaves downloads and installation untouched');
  assert.equal((await page.evaluate(() => window.muxusDesktop.downloadUpdate())).status, 'error');
  assert.match(await readFile(path.join(userData, 'logs/main.log'), 'utf8'), /sha512 checksum mismatch/);
  assert.equal(await hash(installed), await hash(baseline), 'Invalid download must not replace the installed app');
  console.log('PASS: real electron-updater rejects a corrupted checksum and preserves the installed app');

  manifest = makeManifest(nextVersion, candidateHash);
  const downloadsBeforeCheck = payloadRequests;
  assert.equal((await page.evaluate(() => window.muxusDesktop.checkForUpdates())).status, 'available');
  assert.equal(payloadRequests, downloadsBeforeCheck, 'A new check must not retry the download automatically');
  const ready = await page.evaluate(() => window.muxusDesktop.downloadUpdate());
  assert.equal(ready.status, 'ready');
  assert.equal(ready.version, nextVersion);
  assert.equal(ready.percent, 100);
  const states = await page.evaluate(() => window.updaterTestStates);
  for (const status of ['checking', 'up-to-date', 'available', 'downloading', 'error', 'ready']) {
    assert(states.some((state) => state.status === status), `Renderer must receive ${status}`);
  }
  await page.getByRole('button', { name: 'Restart to update' }).first().waitFor();
  await page.getByRole('button', { name: 'Restart to update' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.muxusDesktop.getUpdateState())).status, 'ready');
  assert.equal(await hash(installed), await hash(baseline), 'Cancelling restart must preserve the installed version');
  console.log('PASS: manual retry downloads the update; cancelling restart does not install it');

  await page.evaluate(() => window.muxusDesktop.stateStorage.setItem('updater-integration', 'preserved'));
  await app.close();
  app = undefined;
  assert.equal(await hash(installed), await hash(baseline), 'Normal quit must not install a downloaded update');
  const downloadsBeforeRelaunch = payloadRequests;
  page = await launch();
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.getVersion()), currentVersion);
  assert.equal((await page.evaluate(() => window.muxusDesktop.checkForUpdates())).status, 'available');
  assert.equal(payloadRequests, downloadsBeforeRelaunch, 'Relaunch must not download an update');
  console.log('PASS: normal quit and relaunch keep the old version, even with an update already downloaded');

  // A dismissed availability notice stays dismissed after relaunch. The user
  // can still choose to download from Settings → About.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'About', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Download update' }).click();
  await settings.getByRole('button', { name: 'Restart to update' }).waitFor();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  assert.equal(payloadRequests, downloadsBeforeRelaunch, 'Explicit download should reuse the verified cached payload');
  const logLength = (await readFile(path.join(userData, 'logs/main.log'), 'utf8')).length;
  await page.getByRole('button', { name: 'Restart to update' }).first().click();
  // Track the original OS process: the updater exits it directly, which does
  // not reliably emit Playwright's ElectronApplication close event.
  const closed = once(app.process(), 'exit', { signal: AbortSignal.timeout(60_000) });
  await page.getByRole('dialog').getByRole('button', { name: 'Restart to update' }).click();
  await closed;
  app = undefined;
  let restartedLog = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    restartedLog = (await readFile(path.join(userData, 'logs/main.log'), 'utf8')).slice(logLength);
    if (restartedLog.includes(`Muxus ${nextVersion} starting`) && restartedLog.includes('server listening at')) break;
    await delay(100);
  }
  assert.equal(await hash(installed), candidateHash, 'Explicit installation must replace the AppImage');
  assert.match(restartedLog, new RegExp(`Muxus ${nextVersion.replaceAll('.', '\\.')} starting`));
  assert.match(restartedLog, /server listening at/);
  console.log('PASS: confirmed Restart to update installs the new version and automatically relaunches it');
  await stopRelaunchedApp();
  page = await launch();
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.getVersion()), nextVersion);
  assert.equal(await page.evaluate(() => window.muxusDesktop.stateStorage.getItem('updater-integration')), 'preserved');
  assert.equal((await page.evaluate(() => window.muxusDesktop.checkForUpdates())).status, 'up-to-date');
  assert.equal(payloadRequests, downloadsBeforeRelaunch, 'The updated app must not download its own version again');
  console.log(`PASS: installed ${currentVersion} → ${nextVersion}, reopened the new executable, and preserved desktop state`);
  await app.close();
  app = undefined;
  console.log('Updater integration passed. No release was published.');
} catch (error) {
  const log = await readFile(path.join(userData, 'logs/main.log'), 'utf8').catch(() => 'No main-process log');
  console.error(log);
  throw error;
} finally {
  // Force cleanup without taking any extra update action on a failed test.
  const child = app?.process();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await stopRelaunchedApp();
  feed.closeAllConnections();
  await new Promise((resolve) => feed.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
