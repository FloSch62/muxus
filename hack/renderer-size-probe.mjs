// One-off measurement: does the WebGL/DOM renderer swap change glyph size?
// Drives the LIVE muxus web server, opens a local terminal, toggles the
// renderer, and measures the character cell grid + glyph ink width per mode.
//   node hack/renderer-size-probe.mjs
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
// Servers mint a fresh token per start, so it must come from the environment.
const TOKEN = process.env.MUXUS_TOKEN;
const BASE = process.env.MUXUS_URL ?? 'http://127.0.0.1:3002';
if (!TOKEN) {
  console.error('MUXUS_TOKEN is required — the running server prints it in its browser URL.');
  process.exit(1);
}

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
  ],
});
const page = await (await browser.newContext({ viewport: null })).newPage();

// Read-only: never let the live server restore (and dial) saved workspaces.
await page.route('**/api/workspaces/latest', (r) => r.fulfill({ json: { workspace: null } }));
await page.route('**/api/workspaces/startup', (r) =>
  r.request().method() === 'GET' ? r.fulfill({ json: { workspace: null } }) : r.continue(),
);

// cols/rows arrive in the terminal session's JSON control frames.
let grid = { cols: 0, rows: 0 };
page.on('websocket', (ws) => {
  if (!ws.url().includes('/ws/terminal')) return;
  ws.on('framesent', (f) => {
    if (typeof f.payload !== 'string') return;
    try {
      const msg = JSON.parse(f.payload);
      if (msg.cols && msg.rows) grid = { cols: msg.cols, rows: msg.rows };
    } catch { /* binary input frames */ }
  });
});

await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Local terminal');
await page.click('text=Local terminal');
await page.waitForSelector('.xterm-screen');
await page.waitForTimeout(2500); // webfonts + lazy addon + first prompt

const measure = () =>
  page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen');
    const rect = screen.getBoundingClientRect();
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '14px "JetBrains Mono", "Pure Nerd Font", "Noto Sans Mono", "DejaVu Sans Mono", monospace';
    const rows = screen.querySelectorAll('.xterm-rows > div');
    const firstRow = rows[0]?.getBoundingClientRect();
    return {
      dpr: devicePixelRatio,
      screenW: rect.width,
      screenH: rect.height,
      domRows: rows.length,
      rowH: firstRow?.height ?? null,
      rowW: firstRow?.width ?? null,
      canvases: [...screen.querySelectorAll('canvas')].map((c) => ({
        cls: c.className,
        w: c.width,
        h: c.height,
        cssW: c.getBoundingClientRect().width,
      })),
      jetbrainsLoaded: document.fonts.check('14px "JetBrains Mono"'),
      symbolLoaded: document.fonts.check('14px "Pure Nerd Font"'),
      measureTextW: ctx.measureText('W').width,
      measureText10: ctx.measureText('WWWWWWWWWW').width / 10,
      computedFont: rows.length
        ? getComputedStyle(rows[0]).fontSize + ' / ' + getComputedStyle(rows[0]).fontFamily.slice(0, 60)
        : null,
    };
  });

const toggle = async () => {
  await page.click('[aria-label="Settings"]');
  await page.waitForSelector('.MuiDialog-paper');
  await page.waitForTimeout(500);
  await page.click('.MuiDialog-paper [role="button"]:has-text("Terminal")');
  await page.waitForSelector('.MuiDialog-paper >> text=GPU renderer (WebGL)');
  await page.click('.MuiDialog-paper >> text=GPU renderer (WebGL)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500); // swap + lazy import
};

const report = (label, m) => {
  const cellW = grid.cols ? m.screenW / grid.cols : null;
  const cellH = grid.rows ? m.screenH / grid.rows : null;
  console.log(`\n== ${label} ==`);
  console.log(`grid ${grid.cols}x${grid.rows}  screen ${m.screenW.toFixed(1)}x${m.screenH.toFixed(1)}  dpr ${m.dpr}`);
  console.log(`cellW ${cellW?.toFixed(2)}px  cellH ${cellH?.toFixed(2)}px  rowH(dom) ${m.rowH ?? '—'}`);
  console.log(`canvases ${JSON.stringify(m.canvases)}`);
  console.log(`JetBrains Mono loaded: ${m.jetbrainsLoaded}  symbol font: ${m.symbolLoaded}`);
  console.log(`canvas measureText W=${m.measureTextW.toFixed(2)}px 10W=${m.measureText10.toFixed(2)}px`);
  console.log(`computed ${m.computedFont ?? '—'}`);
};

console.log('mode after load:', JSON.stringify((await measure()).domRows ? 'dom' : 'webgl?'));
report('after load (default = webgl on)', await measure());

await toggle(); // → DOM
const dom = await measure();
report('after toggle OFF (dom)', dom);
await page.locator('.xterm-screen').screenshot({ path: '/tmp/muxus-webgl-perf/size-dom.png' });

await toggle(); // → WebGL
const webgl = await measure();
report('after toggle ON (webgl)', webgl);
await page.locator('.xterm-screen').screenshot({ path: '/tmp/muxus-webgl-perf/size-webgl.png' });

await browser.close();
