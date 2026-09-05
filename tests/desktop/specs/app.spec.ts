import { test, expect } from '@playwright/test';
import { launchDesktop } from '../helpers/app.js';

test('boots the native webview and operates its desktop bridge', async () => {
  const app = await launchDesktop();
  try {
    const info = await app.page.evaluate(() => window.muxusDesktop!.getAppInfo());
    expect(info?.name).toBe('Muxus');
    expect(await app.page.evaluate(() => document.body.innerText)).not.toContain('Muxus could not start');
    expect(await app.page.evaluate(() => window.muxusDesktop!.listLocalFontFamilies())).toContain('DejaVu Sans');
    await app.page.evaluate(() => window.muxusDesktop!.writeClipboard('muxus clipboard check'));
    expect(await app.page.evaluate(() => window.muxusDesktop!.readClipboard())).toBe('muxus clipboard check');
    await app.page.click('button[aria-label="Settings"]');
    await expect.poll(() => app.page.visible('[role="dialog"]')).toBe(true);
    await app.page.press('Escape');
    await app.page.press('Control+Shift+b');
    await expect.poll(() => app.page.visible('button[aria-label="Settings"]')).toBe(false);
    expect(await app.page.visible('button[aria-label="Close window"]')).toBe(true);
    await app.page.press('Control+Shift+b');
    await expect.poll(() => app.page.visible('button[aria-label="Settings"]')).toBe(true);
    const width = await app.page.evaluate(() => innerWidth);
    await app.page.evaluate(() => window.muxusDesktop!.setZoomFactor(1.25));
    await expect.poll(() => app.page.evaluate(() => innerWidth)).toBeLessThan(width);
    await app.page.evaluate(() => window.muxusDesktop!.setZoomFactor(1));
    await app.page.screenshot(test.info().outputPath('native.png'));
  } finally { await app.close(); }
});

test('runs local terminals, preserves shell shortcuts and opens split panes', async () => {
  const app = await launchDesktop();
  try {
    await app.page.evaluate((cwd) => window.muxusDesktop!.openWindow({ kind: 'session', title: 'Native shell', profile: { kind: 'local', shell: '/bin/sh', args: ['-i'], cwd } }), app.stateDir);
    const shell = await app.waitForWindow('Native shell');
    await expect.poll(() => shell.visible('.xterm-helper-textarea')).toBe(true);
    await shell.click('.xterm-helper-textarea');
    await shell.type('.xterm-helper-textarea', "printf 'native-%s\\n' 'terminal-ok'");
    await shell.press('Enter');
    await expect.poll(async () => {
      await shell.press('Control+Shift+a');
      await shell.press('Control+Shift+c');
      return shell.evaluate(() => window.muxusDesktop!.readClipboard());
    }).toContain('native-terminal-ok');
    await shell.press('Control+w');
    expect(await shell.isClosed()).toBe(false);
    await shell.press('Escape');
    await shell.press('Alt+Shift+=');
    await expect.poll(() => shell.count('[data-pane-id]')).toBeGreaterThanOrEqual(2);
    await shell.screenshot(test.info().outputPath('terminal.png'));
  } finally { await app.close(); }
});

test('shares desktop state, routes later CLI launches and restores state after restart', async () => {
  const app = await launchDesktop({ args: ['--workspace', 'Initial CLI fixture'] });
  try {
    expect(await app.page.evaluate(() => window.muxusDesktop!.commandLineLaunch)).toEqual({ kind: 'workspace', name: 'Initial CLI fixture' });
    await app.page.evaluate(() => {
      window.muxusDesktop!.stateStorage.setItem('native-test-state', 'retained');
      window.muxusDesktop!.openWindow({ kind: 'workspace', title: 'Second window' });
    });
    const other = await app.waitForWindow('Second window');
    expect(await other.evaluate(() => window.muxusDesktop!.stateStorage.getItem('native-test-state'))).toBe('retained');
    await other.evaluate(() => window.muxusDesktop!.stateStorage.setItem('native-test-state', 'updated'));
    await expect.poll(() => app.page.evaluate(() => window.muxusDesktop!.stateStorage.getItem('native-test-state'))).toBe('updated');
    await app.page.reload();
    await app.page.waitForFunction(() => !!window.muxusDesktop);
    expect(await app.page.evaluate(() => window.muxusDesktop!.stateStorage.getItem('native-test-state'))).toBe('updated');
    expect(await app.page.evaluate(() => window.muxusDesktop!.commandLineLaunch)).toBeNull();
    await app.page.evaluate(() => {
      (window as unknown as { nativeLaunch?: string }).nativeLaunch = '';
      window.muxusDesktop!.onCommandLineLaunch((launch) => { (window as unknown as { nativeLaunch?: string }).nativeLaunch = launch.name; });
    });
    app.launchAgain(['--workspace', 'CLI fixture']);
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { nativeLaunch?: string }).nativeLaunch)).toBe('CLI fixture');
    expect(await app.handles()).toHaveLength(2);
    await app.stop();
    const restarted = await launchDesktop({ stateDir: app.stateDir });
    try {
      expect(await restarted.page.evaluate(() => window.muxusDesktop!.stateStorage.getItem('native-test-state'))).toBe('updated');
    } finally { await restarted.close(); }
  } finally { await app.close(); }
});
