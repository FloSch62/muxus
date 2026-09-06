// The animated tour on the docs landing page.
//
//   pnpm exec bun hack/record.mjs              # light -> docs/assets/screenshots/tour.mp4
//   THEME=dark pnpm exec bun hack/record.mjs   # dark  -> tour-dark.mp4
//   KEEP=1 pnpm exec bun hack/record.mjs       # leave the PNG frames in /tmp to re-encode
//
// Each run also writes <name>-poster.png, the still the <video> shows first.
//
// Same sandbox as hack/capture.mjs: every host, file and tunnel on screen comes
// from hack/demo-env.mjs, so nothing real is recorded. Frames come off Chrome's
// screencast at device resolution and are stitched with ffmpeg, which keeps the
// terminal text sharp — a video re-encode of a 1x window does not.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startDemoEnv } from './demo-env.mjs';

const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';
const SUFFIX = THEME === 'dark' ? '-dark' : '';
const OUT = 'docs/assets/screenshots';
const NAME = `tour${SUFFIX}`;
const VIEW = { width: 1420, height: 880 };
const SCALE = 2;
// The frame width ffmpeg encodes at. Chrome hands us up to 2x device pixels and
// the downscale is what makes the glyphs read cleanly at half that size.
const OUT_WIDTH = 1420;
const FPS = 16;
const TAIL = 1.6; // seconds to hold the last frame before the loop restarts
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const FRAMES = path.join(os.tmpdir(), `muxus-tour-${THEME}`);

const env = await startDemoEnv();
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
await fs.mkdir(OUT, { recursive: true });
await fs.rm(FRAMES, { recursive: true, force: true });
await fs.mkdir(FRAMES, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same look as the screenshots, so the tour and the stills are one set. */
const PREFS = {
  themeMode: THEME,
  monoFontSize: 14,
  fontFamily: 'JetBrains Mono',
  lineHeight: 1.1,
  lightTerminalScheme: 'github-light',
  darkTerminalScheme: 'vscode-dark',
  sidebarWidth: 250,
  commandButtons: [],
  keywordHighlights: [],
  // The tour closes a pane with a live session in it; the confirmation is a
  // real prompt, but a red "end this session?" dialog is not what the loop is
  // about, and nobody is there to answer it.
  confirmCloseConnected: false,
  sidebarFolderStyles: {
    'folder:production': { color: '#ef4444', icon: 'cloud' },
    'folder:production/web': { color: '#3b82f6', icon: 'server' },
    'folder:production/data': { color: '#f97316', icon: 'storage' },
    'folder:lab': { color: '#22c55e', icon: 'lab' },
    'folder:lab/fabric': { color: '#a855f7', icon: 'lan' },
  },
};

// ---------------------------------------------------------------------------
// Overlay: a pointer and a caption, because a screencast records neither the
// mouse nor the keys that drove it.
// ---------------------------------------------------------------------------

function overlay() {
  const install = () => {
    if (window.__tour) return;
    const style = document.createElement('style');
    style.textContent = `
      #tour-cursor, #tour-ring, #tour-caption { position: fixed; z-index: 2147483647; pointer-events: none; }
      #tour-cursor {
        top: 0; left: 0; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
        background: rgba(59, 102, 245, 0.35); border: 2px solid rgba(255, 255, 255, 0.92);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(0, 0, 0, 0.22);
        opacity: 0; transition: opacity 160ms ease;
      }
      #tour-ring {
        top: 0; left: 0; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
        border: 2px solid rgba(59, 102, 245, 0.85); opacity: 0;
      }
      #tour-ring.pulse { animation: tour-pulse 520ms ease-out; }
      @keyframes tour-pulse {
        from { opacity: 0.9; transform: var(--at) scale(1); }
        to   { opacity: 0;   transform: var(--at) scale(2.8); }
      }
      #tour-caption {
        left: 50%; bottom: 26px; transform: translate(-50%, 10px);
        display: flex; align-items: center; gap: 10px;
        padding: 9px 18px; border-radius: 999px;
        font: 500 15px/1.3 Inter, -apple-system, "Segoe UI", system-ui, sans-serif;
        letter-spacing: -0.01em; color: #f4f6fb;
        background: rgba(17, 19, 26, 0.86); border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.34);
        opacity: 0; transition: opacity 260ms ease, transform 260ms ease;
      }
      #tour-caption.on { opacity: 1; transform: translate(-50%, 0); }
      #tour-caption .keys { display: flex; gap: 4px; }
      #tour-caption kbd {
        font: 600 12px/1 ui-monospace, "JetBrains Mono", monospace; color: #dfe4f2;
        padding: 4px 7px; border-radius: 6px; background: rgba(255, 255, 255, 0.13);
        border: 1px solid rgba(255, 255, 255, 0.16); box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.25);
      }
    `;
    document.head.append(style);

    const cursor = document.createElement('div');
    cursor.id = 'tour-cursor';
    const ring = document.createElement('div');
    ring.id = 'tour-ring';
    const caption = document.createElement('div');
    caption.id = 'tour-caption';
    document.body.append(cursor, ring, caption);

    let at = 'translate(-100px, -100px)';
    addEventListener(
      'mousemove',
      (event) => {
        at = `translate(${event.clientX}px, ${event.clientY}px)`;
        cursor.style.transform = at;
        cursor.style.opacity = '1';
      },
      true,
    );
    addEventListener(
      'mousedown',
      () => {
        ring.style.setProperty('--at', at);
        ring.classList.remove('pulse');
        void ring.offsetWidth;
        ring.classList.add('pulse');
      },
      true,
    );

    window.__tour = {
      caption(text, keys = []) {
        caption.innerHTML = '';
        caption.append(document.createTextNode(text));
        if (keys.length) {
          const box = document.createElement('span');
          box.className = 'keys';
          for (const key of keys) {
            const kbd = document.createElement('kbd');
            kbd.textContent = key;
            box.append(kbd);
          }
          caption.append(box);
        }
        caption.classList.add('on');
      },
      clear() {
        caption.classList.remove('on');
      },
      hideCursor() {
        cursor.style.opacity = '0';
      },
    };
  };
  if (document.body) install();
  else addEventListener('DOMContentLoaded', install);
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

const context = await browser.newContext({
  viewport: VIEW,
  deviceScaleFactor: SCALE,
  colorScheme: THEME,
  reducedMotion: 'no-preference',
});
const page = await context.newPage();
// Start from an empty window every time: a previous run flushes its layout on
// the way out, and the restore would put its tabs back.
await page.route('**/api/workspaces/latest', (route) => route.fulfill({ json: { workspace: null } }));
await page.route('**/api/workspaces/startup', (route) =>
  route.request().method() === 'GET' ? route.fulfill({ json: { workspace: null } }) : route.continue(),
);
await page.addInitScript(
  (value) => localStorage.setItem('muxus-prefs', value),
  JSON.stringify({ state: PREFS, version: 9 }),
);
await page.addInitScript(overlay);
await purgeWorkspaces();
await page.goto(`${env.url}/?token=${env.token}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[aria-label="Add host"]');
await wait(1500);

async function purgeWorkspaces() {
  const res = await fetch(`${env.url}/api/workspaces`, {
    headers: { authorization: `Bearer ${env.token}` },
  });
  const { workspaces } = await res.json();
  for (const workspace of workspaces) {
    await fetch(`${env.url}/api/workspaces/${workspace.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${env.token}` },
    });
  }
}

let pointer = { x: VIEW.width - 120, y: VIEW.height - 60 };

/** Move the pointer the way a hand does — eased, not teleported. */
async function glide(x, y, ms = 520) {
  const from = pointer;
  const steps = Math.max(6, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await wait(ms / steps);
  }
  pointer = { x, y };
}

/** Glide onto an element, pause on it, then click it. */
async function point(locator, { ms = 520, dwell = 320, clicks = 1 } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to point at');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await glide(x, y, ms);
  await wait(dwell);
  // Two down/up pairs are two single clicks — the second needs to carry the
  // click count for the page to see a dblclick at all.
  if (clicks === 2) await page.mouse.dblclick(x, y);
  else {
    await page.mouse.down();
    await page.mouse.up();
  }
}

const caption = (text, keys = []) => page.evaluate(([t, k]) => window.__tour.caption(t, k), [text, keys]);
const clearCaption = () => page.evaluate(() => window.__tour.clear());
const hideCursor = () => page.evaluate(() => window.__tour.hideCursor());

/**
 * Click into a pane and hand it the keyboard, then park the pointer — a dot
 * sitting over the text while a command types itself only pulls the eye.
 */
async function focusPane(index, options) {
  await point(page.locator('.xterm-screen').nth(index), { dwell: 120, ...options });
  await hideCursor();
  await wait(200);
}

/** Type into the focused terminal at a human speed and let the host answer. */
async function type(command, settle = 900) {
  await page.keyboard.type(command, { delay: 55 });
  await wait(260);
  await page.keyboard.press('Enter');
  await wait(settle);
}

/** Wait until the pane that just opened has drawn a shell prompt. */
async function awaitPrompt(count = 1) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.xterm-rows').length >= n,
    count,
    { timeout: 25_000 },
  );
  await page.waitForFunction(
    (n) => {
      const rows = [...document.querySelectorAll('.xterm-rows')];
      return rows.length >= n && /[$#]\s*$/.test(rows[n - 1].innerText.trimEnd());
    },
    count,
    { timeout: 20_000 },
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const cdp = await context.newCDPSession(page);
const frames = [];
const writes = [];
let index = 0;
let poster;

cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  const file = path.join(FRAMES, `f${String(index++).padStart(5, '0')}.png`);
  frames.push({ file, at: metadata?.timestamp ?? Date.now() / 1000 });
  writes.push(fs.writeFile(file, Buffer.from(data, 'base64')));
});

await cdp.send('Page.startScreencast', {
  format: 'png',
  maxWidth: OUT_WIDTH * 1.5,
  maxHeight: Math.round(((OUT_WIDTH * 1.5) / VIEW.width) * VIEW.height),
  everyNthFrame: 1,
});

try {
  await tour();
} catch (err) {
  // A beat that misses its target leaves nothing to look at otherwise, and the
  // window is gone by the time the stack trace lands.
  const debug = path.join(os.tmpdir(), `muxus-tour-failed${SUFFIX}.png`);
  await page.screenshot({ path: debug }).catch(() => undefined);
  await shutdown();
  throw new Error(`${err.message.split('\n')[0]} — window at ${debug}`);
}

async function shutdown() {
  await cdp.send('Page.stopScreencast').catch(() => undefined);
  await Promise.all(writes);
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await env.stop();
}

async function tour() {
  // --- 1. The host list is your ssh config ------------------------------------
  await wait(500);
  await caption('Your hosts come straight from ~/.ssh/config');
  await glide(190, 400, 650);
  await wait(450);
  await point(page.locator('[role="treeitem"][aria-label="web-01"]').first(), { ms: 560 });
  await awaitPrompt(1);
  await wait(400);
  await focusPane(0, { ms: 520 });
  await clearCaption();
  await wait(250);
  await type('status', 1300);
  await wait(400);

  // --- 2. Split panes, on the same connection ---------------------------------
  await caption('Split the pane — it reuses the connection', ['Ctrl', '⇧', '→']);
  await page.keyboard.press('Control+Shift+ArrowRight');
  await awaitPrompt(2);
  await wait(650);
  await clearCaption();
  await wait(250);

  // --- 3. A terminal that draws ----------------------------------------------
  await caption('kitty graphics — images render inline, over SSH');
  await focusPane(1, { ms: 480 });
  await type('plot', 2600);
  await wait(750);
  await clearCaption();
  // Long enough for the caption to have finished fading: two live panes and a
  // chart, nothing over them, is the frame worth stilling.
  await wait(450);
  poster = frames.at(-1)?.file;

  // --- 4. One key for everything ---------------------------------------------
  await caption('One key finds hosts, tabs, files and commands', ['Ctrl', 'K']);
  await page.keyboard.press('Control+k');
  await wait(600);
  await page.keyboard.type('db-', { delay: 120 });
  await wait(1300);
  await page.keyboard.press('Escape');
  await wait(420);
  await clearCaption();
  await wait(250);

  // --- 5. Files and an editor, in the session ---------------------------------
  // Back to one pane first: the file browser takes half of the pane it opens in,
  // and a terminal squeezed to twenty columns reflows into noise.
  await point(page.locator('[aria-label="Close pane"]').last(), { ms: 620 });
  await wait(700);
  await caption('SFTP and a remote editor on the same session');
  await point(page.locator('[aria-label="Toggle file browser"]'), { ms: 620 });
  await wait(1900);
  await point(page.getByText('docker-compose.yml').first(), { ms: 560, clicks: 2 });
  await wait(3000);
  await hideCursor();
  await wait(1400);
  await clearCaption();
  await wait(600);
}

await shutdown();

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

if (frames.length < 30) throw new Error(`only ${frames.length} frames captured`);

const list = frames
  .map((frame, i) => {
    const next = frames[i + 1];
    const seconds = next ? Math.min(Math.max(next.at - frame.at, 1 / 60), 2) : TAIL;
    return `file '${frame.file}'\nduration ${seconds.toFixed(4)}`;
  })
  .join('\n');
const listFile = path.join(FRAMES, 'frames.txt');
await fs.writeFile(listFile, `${list}\nfile '${frames.at(-1).file}'\n`);

const seconds = frames.at(-1).at - frames[0].at + TAIL;
console.log(`${THEME}: ${frames.length} frames, ${seconds.toFixed(1)}s`);

const filter = `fps=${FPS},scale=${OUT_WIDTH}:-2:flags=lanczos`;

// h264 in mp4: no inter-frame ghosting (lossy animated WebP diffs leave faint
// rectangles behind on UI footage) and a third of the bytes.
await ffmpeg([
  '-f', 'concat', '-safe', '0', '-i', listFile,
  '-vf', `${filter},format=yuv420p`,
  '-c:v', 'libx264', '-crf', '21', '-preset', 'slow', '-tune', 'stillimage',
  '-movflags', '+faststart', '-an',
  `${OUT}/${NAME}.mp4`,
]);

// One frame of the tour as a still: what the <video> shows before it has
// loaded, and what stands in for it when the reader asked for less motion.
await ffmpeg([
  '-i', poster ?? frames.at(-1).file,
  '-vf', `scale=${OUT_WIDTH}:-2:flags=lanczos`, '-frames:v', '1',
  `${OUT}/${NAME}-poster.png`,
]);

for (const ext of ['mp4', 'webp', 'png']) {
  const file = path.join(OUT, `${NAME}${ext === 'png' ? '-poster' : ''}.${ext}`);
  const stat = await fs.stat(file).catch(() => undefined);
  if (stat) console.log(`  ${path.basename(file)} — ${(stat.size / 1024 / 1024).toFixed(2)} MiB`);
}

if (!process.env.KEEP) await fs.rm(FRAMES, { recursive: true, force: true });
else console.log(`  frames kept in ${FRAMES}`);

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}
