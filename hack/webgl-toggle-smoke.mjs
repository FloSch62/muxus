// One-off smoke: does the GPU renderer toggle actually swap the live terminal?
//   node /tmp/webgl-toggle-smoke.mjs
// Headed on :0, drives the real UI: connect demo host, open Settings,
// flip "GPU renderer (WebGL)" off and on, assert the xterm layers swap.
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startDemoEnv } from './demo-env.mjs';

const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
const env = await startDemoEnv();

const layers = (page) =>
  page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen');
    if (!screen) return { missing: true };
    return {
      canvases: [...screen.querySelectorAll('canvas')].map((c) => c.className),
      domRows: screen.querySelectorAll('.xterm-rows > div').length,
    };
  });

let failures = 0;
function expect(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${detail}`);
  if (!cond) failures++;
}

try {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: false,
    env: { ...process.env, DISPLAY: ':0' },
    args: [
      '--no-sandbox',
      '--window-position=0,0',
      '--window-size=1920,1080',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const page = await (await browser.newContext({ viewport: null })).newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Pre-existing noise: CSP frame-ancestors is ignored in <meta> delivery.
    if (msg.text().includes('frame-ancestors')) return;
    consoleErrors.push(msg.text());
  });

  // Same clean start as the docs tour: no workspace restore.
  await page.route('**/api/workspaces/latest', (r) => r.fulfill({ json: { workspace: null } }));
  await page.route('**/api/workspaces/startup', (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: { workspace: null } }) : r.continue(),
  );
  await page.goto(`${env.url}/?token=${env.token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[aria-label="Add host"]');

  // Connect a demo host and wait for a live terminal.
  await page.locator('[role="treeitem"][aria-label="web-01"]').first().click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForSelector('.xterm-screen canvas, .xterm-rows > div');
  await page.waitForTimeout(1500); // lazy addon import + first prompt

  // The WebGL text canvas is classless; DOM mode has no canvases at all.
  const isWebgl = (s) => s.domRows === 0 && (s.canvases?.length ?? 0) > 0;
  const isDom = (s) => s.domRows > 0 && (s.canvases?.length ?? 0) === 0;

  const initial = await layers(page);
  expect('default pref renders on GPU', isWebgl(initial), JSON.stringify(initial));

  const toggle = async () => {
    await page.click('[aria-label="Settings"]');
    // The dialog container intercepts pointer events during the paper
    // transition, so click through the DOM instead of coordinates.
    await page.waitForSelector('.MuiDialog-paper [role="button"]:has-text("Terminal")');
    await page.waitForTimeout(600);
    await page.evaluate(() =>
      [...document.querySelectorAll('.MuiDialog-paper [role="button"]')]
        .find((b) => b.textContent.trim() === 'Terminal')
        .click(),
    );
    await page.waitForSelector('.MuiDialog-paper >> text=GPU renderer (WebGL)');
    await page.evaluate(() =>
      [...document.querySelectorAll('.MuiDialog-paper .MuiFormControlLabel-root')]
        .find((l) => l.textContent.includes('GPU renderer'))
        .querySelector('input[type="checkbox"]')
        .click(),
    );
    await page.keyboard.press('Escape');
  };

  await toggle();
  await page.waitForTimeout(600);
  const off = await layers(page);
  expect('toggle off → DOM renderer live', isDom(off), JSON.stringify(off));
  await page.screenshot({ path: '/tmp/muxus-webgl-perf/toggle-off.png' });

  // The session itself must survive the renderer swap.
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type('echo renderer-swap-ok');
  await page.keyboard.press('Enter');
  let echoed = false;
  for (let i = 0; i < 10 && !echoed; i++) {
    await page.waitForTimeout(300);
    echoed = await page.evaluate(
      () => document.querySelector('.xterm-rows')?.textContent?.includes('renderer-swap-ok') ?? false,
    );
  }
  expect('session alive after swap to DOM', echoed, '');

  await toggle();
  await page.waitForTimeout(1200); // lazy import again
  const on = await layers(page);
  expect('toggle on → WebGL renderer live', isWebgl(on), JSON.stringify(on));
  await page.screenshot({ path: '/tmp/muxus-webgl-perf/toggle-on.png' });

  expect('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  await browser.close();
} finally {
  await env.stop();
}
process.exit(failures ? 1 : 0);
