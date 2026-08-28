// WebGL terminal renderer benchmark on a real display.
//
//   node hack/webgl-perf.mjs                 # DOM vs WebGL, physical monitor
//   PERF_HEADLESS=1 node hack/webgl-perf.mjs # headless comparison (SwiftShader)
//   PERF_DISPLAY=:1 node hack/webgl-perf.mjs # pick another X display
//
// The default DISPLAY is :0 — the lightdm session with the monitor cabled to
// the RTX 3060. Headless Chromium renders WebGL with SwiftShader on the CPU,
// so numbers from headless runs say nothing about the GPU renderer; this
// harness opens a real window so the addon runs on the monitor's GPU.
//
// xterm is served straight from client/node_modules, so the benchmark runs the
// same package versions the app ships with. Terminal options mirror the muxus
// defaults (14pt, 10k scrollback, allowTransparency) at a fixed 220x48 grid.
//
// Method: xterm's write callback fires when a chunk is parsed, not painted, so
// callback chaining only measures parser throughput. Instead each phase offers
// data at a fixed rate for a fixed window (top-up write every 4ms, sized by
// elapsed time so timer jitter cannot under-run the offered rate) and measures
// what the terminal actually sustains:
//
//   log-flood    colored service-log lines at 8 / 24 / 40 MB/s for 6 s
//   progress     in-place bar redraws at 10k / 50k / 200k updates/s for 6 s
//   plain-cat    uncolored lines at 8 / 24 / 40 MB/s for 6 s
//
// Reported per rate: frame stats during the feed (60 Hz display: smooth =
// 60 fps, tight p99), parse rate (acknowledged bytes), drain ms (backlog left
// when the feed stops — how long output keeps arriving after the flood), and
// Chromium process-tree CPU seconds.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const XTERM_ROOT = path.resolve('client/node_modules/@xterm');
const CHROME =
  process.env.CHROME ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
const DISPLAY = process.env.PERF_DISPLAY ?? ':0';
const HEADED = !process.env.PERF_HEADLESS;
const OUT_DIR = path.join(os.tmpdir(), 'muxus-webgl-perf');

// DPMS-blanked monitors still answer X requests, but Chromium stops getting
// vblanks and throttles rAF to ~1 Hz, which poisons every frame metric. Wake
// the display and hold off DPMS + screensaver for the run; the greeter's
// original 600s timeouts are restored in the finally block below.
function xset(...args) {
  const { status } = spawnSync('xset', ['-display', DISPLAY, ...args], { stdio: 'ignore' });
  if (status !== 0) console.warn(`xset ${args.join(' ')} -> rc=${status}`);
}
if (HEADED) {
  xset('s', 'reset');
  xset('dpms', 'force', 'on');
  xset('dpms', '0', '0', '0');
  xset('s', 'off');
}

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};

const page = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/xterm/xterm/css/xterm.css">
<style>
  html, body { margin: 0; height: 100%; background: #1e1e1e; }
  #term { width: 100vw; height: 100vh; }
</style>
<script type="module">
import { Terminal } from '/xterm/xterm/lib/xterm.mjs';
import { WebglAddon } from '/xterm/addon-webgl/lib/addon-webgl.mjs';

const renderer = new URLSearchParams(location.search).get('renderer');

const term = new Terminal({
  cols: 220, rows: 48,
  fontSize: 14,
  fontFamily: 'JetBrains Mono, DejaVu Sans Mono, monospace',
  lineHeight: 1.0,
  scrollback: 10_000,
  cursorBlink: true,
  cursorStyle: 'block',
  allowProposedApi: true,
  allowTransparency: true,
  scrollOnEraseInDisplay: true,
  theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
});
term.open(document.getElementById('term'));

let glRenderer = null;
let glError = null;
if (renderer === 'webgl') {
  try { term.loadAddon(new WebglAddon()); } catch (e) { glError = String(e); }
}
{ // What GPU is actually behind contexts on this display?
  try {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2') || c.getContext('webgl');
    const ext = g.getExtension('WEBGL_debug_renderer_info');
    glRenderer = ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
  } catch (e) { glRenderer = 'probe failed: ' + String(e); }
}

// rAF frame meter + long-task counter run for the whole page life.
const frames = [];
(function loop(t) { frames.push(t); requestAnimationFrame(loop); })(0);
let longTasks = 0;
new PerformanceObserver((l) => { longTasks += l.getEntries().length; })
  .observe({ entryTypes: ['longtask'] });

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const pad = (n, w) => String(n).padStart(w, '0');
const clock = () => performance.timeOrigin + performance.now();

function logPool(totalBytes, chunkBytes) {
  const r = rng(42);
  const chunks = [];
  let bytes = 0;
  while (bytes < totalBytes) {
    let buf = '';
    while (buf.length < chunkBytes) {
      const lvl = r();
      const tag = lvl < 0.72 ? '\\x1b[32mINFO \\x1b[0m' : lvl < 0.9 ? '\\x1b[33mWARN \\x1b[0m' : '\\x1b[31mERROR\\x1b[0m';
      buf += tag + ' 2026-08-27T08:' + pad((r() * 59) | 0, 2) + ':' + pad((r() * 59) | 0, 2) +
        '.' + pad((r() * 999) | 0, 3) + 'Z svc=checkout req=req_' +
        ((r() * 0xffffff) | 0).toString(16) + ' status=' + (200 + ((r() * 3) | 0)) +
        ' latency=' + pad((r() * 400) | 0, 3) + 'ms bytes=' + ((r() * 48000) | 0) +
        ' path=/api/v1/cart/items/' + ((r() * 9999) | 0) + ' shard=' + ((r() * 15) | 0) + '\\r\\n';
    }
    chunks.push(buf);
    bytes += buf.length;
  }
  return chunks;
}

function plainPool(totalBytes, chunkBytes) {
  const chunks = [];
  let bytes = 0;
  let i = 0;
  while (bytes < totalBytes) {
    let buf = '';
    while (buf.length < chunkBytes) {
      buf += pad(i, 9) + '  lorem ipsum dolor sit amet consectetur adipiscing' +
        ' elit sed do eiusmod tempor incididunt ut labore et dolore ' + pad(i % 9973, 4) + '\\r\\n';
      i++;
    }
    chunks.push(buf);
    bytes += buf.length;
  }
  return chunks;
}

function progressPool(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const f = ((i * 30) / count) | 0;
    const pct = ((i * 100) / count) | 0;
    out.push(
      '\\r\\x1b[2K\\x1b[36m[\\x1b[0m' + '#'.repeat(f) + '\\u00b7'.repeat(30 - f) +
      '\\x1b[36m]\\x1b[0m ' + pad(pct, 3) + '% ' + pad((120 + (i % 60)) | 0, 3) +
      'MB/s eta 00:' + pad(59 - ((i * 59 / count) | 0), 2)
    );
  }
  return out;
}

// Offer data at a fixed rate and never wait for the terminal: top up every
// 4ms with bytes proportional to elapsed time (jitter-corrected), so a parser
// or renderer that cannot keep up builds a backlog instead of pacing the feed.
// A write callback closing means the chunk is parsed; pending counts chunks
// the parser has not caught up with. drainMs = backlog still flushing after
// the feed stopped. parseRate counts only chunks acknowledged DURING the
// feed window — chunks parsed while draining are not feed throughput.
function sustain(makeChunk, durationMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const deadline = t0 + durationMs;
    let last = t0;
    let written = 0;
    // Counts bytes whose parse callback ran before the nominal deadline —
    // callbacks delayed past it by a blocking parser task are drain, not
    // feed throughput, even when the task ends before our timer fires.
    let ackedInWindow = 0;
    let pending = 0;
    let stopped = false;
    let feedEnded = 0;
    const offer = (dt) => {
      const chunk = makeChunk(dt);
      if (!chunk) return;
      pending++;
      term.write(chunk, () => {
        pending--;
        if (performance.now() <= deadline) ackedInWindow += chunk.length;
      });
      written += chunk.length;
    };
    const feedOnce = () => {
      if (stopped) return;
      const now = performance.now();
      if (now - t0 >= durationMs) {
        // Offer the final [last, deadline] slice too: when the parser blocks
        // the main thread past the deadline, skipping it short-changes
        // exactly the overloaded cells and flatters their fps/drain numbers.
        offer((deadline - last) / 1000);
        stopped = true;
        feedEnded = performance.now();
        drain();
        return;
      }
      offer((now - last) / 1000);
      last = now;
      setTimeout(feedOnce, 4);
    };
    const drain = () => {
      if (pending === 0) {
        resolve({ written, ackedInWindow, wallMs: feedEnded - t0, drainMs: performance.now() - feedEnded });
        return;
      }
      setTimeout(drain, 10);
    };
    feedOnce();
  });
}

function idleFrames(n) {
  return new Promise((resolve) => {
    let k = 0;
    (function f() { if (++k >= n) { resolve(); return; } requestAnimationFrame(f); })();
  });
}

function frameStats(t0, t1) {
  // Count every inter-frame gap overlapping the window — including stalls
  // that begin before t0 or end after t1. Filtering to frames inside the
  // window silently drops exactly those boundary-spanning stalls, which are
  // the overloaded cells' worst latencies.
  const deltas = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (a < t1 && b > t0) deltas.push(b - a);
  }
  deltas.sort((a, b) => a - b);
  const q = (p) => (deltas.length ? deltas[Math.min(deltas.length - 1, (p * deltas.length) | 0)] : null);
  return {
    fps: deltas.length / ((t1 - t0) / 1000),
    p50: q(0.5), p95: q(0.95), p99: q(0.99),
    max: deltas.length ? deltas[deltas.length - 1] : null,
    jank34: deltas.filter((d) => d > 34).length,
  };
}

async function runRate(phase, pool, offered, durationMs) {
  const isProgress = phase === 'progress';
  // Byte phases: offered in bytes/s, chunks stitched from 32KB pool entries.
  // Progress: offered in redraws/s, updates accumulated fractionally.
  let poolIdx = 0;
  let owed = 0;
  let barIdx = 0;
  const barLen = pool.length ? pool[0].length : 1;
  const makeChunk = isProgress
    ? (dt) => {
        owed += offered * dt;
        const n = Math.floor(owed);
        owed -= n;
        if (n <= 0) return null;
        const parts = new Array(n);
        for (let k = 0; k < n; k++) parts[k] = pool[barIdx++ % pool.length];
        return parts.join('');
      }
    : (dt) => {
        const target = Math.round(offered * dt);
        if (target <= 0) return null;
        let chunk = '';
        while (chunk.length < target) chunk += pool[poolIdx++ % pool.length];
        return chunk.slice(0, target);
      };

  await idleFrames(3);
  const t0 = performance.now();
  const e0 = clock();
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : null;
  const lt0 = longTasks;
  const { ackedInWindow, wallMs, drainMs } = await sustain(makeChunk, durationMs);
  const tFeed = t0 + wallMs;
  // Let a few idle frames land AFTER the feed end before slicing the window:
  // a stall spanning the boundary only becomes countable once its trailing
  // frame exists in the log, and the drain can finish before the next vblank.
  await idleFrames(3);
  const stats = frameStats(t0, tFeed); // during the feed — renderer under load
  return {
    phase,
    offered,
    startEpoch: e0,
    feedEndEpoch: clock() - (performance.now() - tFeed),
    parseRate: isProgress ? ackedInWindow / barLen / (wallMs / 1000) : ackedInWindow / 1.048576e6 / (wallMs / 1000),
    drainMs,
    longTasks: longTasks - lt0,
    heapDelta: heap0 != null && performance.memory
      ? (performance.memory.usedJSHeapSize - heap0) / 1048576
      : null,
    ...stats,
  };
}

const REPS = Number(new URLSearchParams(location.search).get('reps') || 1);
const phases = [];
await runRate('warmup', logPool(4 << 20, 32768), 12 << 20, 1500);
term.reset();

const logPool32 = logPool(32 << 20, 32768);
const plainPool32 = plainPool(32 << 20, 32768);
const bars = progressPool(1200);
for (let rep = 0; rep < REPS; rep++) {
  term.reset();
  for (const mbps of [8, 24, 40]) {
    phases.push({ rep, ...await runRate('log-flood', logPool32, mbps << 20, 6000) });
  }
  term.reset();
  for (const ups of [10_000, 50_000, 200_000]) {
    phases.push({ rep, ...await runRate('progress', bars, ups, 6000) });
  }
  term.reset();
  for (const mbps of [8, 24, 40]) {
    phases.push({ rep, ...await runRate('plain-cat', plainPool32, mbps << 20, 6000) });
  }
}

window.__PERF = {
  done: true,
  renderer,
  glRenderer,
  glError,
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  hidden: document.hidden,
  phases,
};
</script>
</head>
<body><div id="term"></div></body>
</html>`;

// --- static server -----------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
    return;
  }
  if (!url.pathname.startsWith('/xterm/')) {
    res.writeHead(404); res.end(); return;
  }
  const rel = path.normalize(decodeURIComponent(url.pathname.slice('/xterm/'.length)));
  const file = path.join(XTERM_ROOT, rel);
  if (!file.startsWith(XTERM_ROOT + path.sep)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- CPU sampler (Chromium process tree, /proc ticks) ------------------------
const CLK_TCK = 100;
function treeTicks(rootPid) {
  const procs = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
    const close = stat.lastIndexOf(')');
    const rest = stat.slice(close + 2).split(' ');
    procs.push({
      pid: +stat.slice(0, stat.indexOf(' ')),
      ppid: +rest[1],
      ticks: +rest[11] + +rest[12],
    });
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const isDescendant = (pid) => {
    for (let cur = byPid.get(pid); cur; cur = byPid.get(cur.ppid)) {
      if (cur.pid === rootPid) return true;
    }
    return false;
  };
  let total = 0;
  for (const p of procs) if (isDescendant(p.pid)) total += p.ticks;
  return total;
}

// --- run ----------------------------------------------------------------------
const renderers = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['dom', 'webgl'];
// Condition simulation knobs: PERF_CPU_THROTTLE=4 slows the page main thread
// via CDP (weak-CPU stand-in — GPU process raster is unaffected, which is
// exactly the asymmetry the WebGL renderer could exploit); PERF_DPR=2 renders
// at 2x device scale (hi-dpi stand-in — DOM text raster gets 4x the pixels).
const CPU_THROTTLE = Math.max(1, Number(process.env.PERF_CPU_THROTTLE || 1));
const DPR = Math.max(1, Number(process.env.PERF_DPR || 1));
// Repetitions per phase cell; medians are reported so one GC storm cannot
// masquerade as a renderer property.
const REPS = Math.max(1, Number(process.env.REPS || 1));
fs.mkdirSync(OUT_DIR, { recursive: true });

// playwright-core 1.62 dropped browser.process(). The browser is a direct
// child of this node script, so identify it by parent pid + executable.
function findBrowserPid() {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const ppid = +stat.slice(close + 2).split(' ')[1];
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (ppid === process.pid && cmd.startsWith(CHROME)) return +entry;
    } catch { /* process exited between reads */ }
  }
  return null;
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !HEADED,
  env: { ...process.env, DISPLAY },
  args: [
    '--no-sandbox',
    '--enable-precise-memory-info',
    '--disable-dev-shm-usage',
    '--window-position=0,0',
    '--window-size=1920,1080',
    // A backgrounded or occluded window must not throttle rAF — that would
    // poison the frame numbers on a greeter session nobody looks at.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

let rootPid = null;
const samples = []; // { t: epoch ms, ticks }
const sampler = setInterval(() => {
  rootPid ??= findBrowserPid();
  if (rootPid) samples.push({ t: Date.now(), ticks: treeTicks(rootPid) });
}, 200);

const cpuSecondsBetween = (t0, t1) => {
  if (samples.length < 2) return null;
  const ticksAt = (t) => {
    let a = samples[0], b = samples[samples.length - 1];
    for (const s of samples) {
      if (s.t <= t) a = s;
      if (s.t >= t) { b = s; break; }
    }
    if (a === b) return a.ticks;
    return a.ticks + ((b.ticks - a.ticks) * (t - a.t)) / (b.t - a.t);
  };
  return (ticksAt(t1) - ticksAt(t0)) / CLK_TCK;
};

const results = [];
try {
  for (const renderer of renderers) {
    // Fixed viewport for every run: viewport:null defers to the OS window's
    // inner size, which is neither guaranteed 1920x1080 nor equal across
    // machines — that would make DPR runs differ in page area, not just DPR.
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: DPR,
    });
    const pg = await context.newPage();
    if (CPU_THROTTLE > 1) {
      const cdp = await context.newCDPSession(pg);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    }
    await pg.goto(`${origin}/?renderer=${renderer}&reps=${REPS}`);
    await pg.waitForFunction('window.__PERF && window.__PERF.done', null, { timeout: 900_000 });
    const result = await pg.evaluate('window.__PERF');
    await pg.screenshot({ path: path.join(OUT_DIR, `${renderer}.png`) });
    for (const phase of result.phases) {
      phase.cpuSeconds = cpuSecondsBetween(phase.startEpoch, phase.feedEndEpoch);
    }
    results.push(result);
    await context.close();
  }
} finally {
  clearInterval(sampler);
  await browser.close();
  server.close();
  if (HEADED) {
    xset('dpms', '600', '600', '600');
    xset('s', '600', '600');
  }
}

// --- report --------------------------------------------------------------------
// Cells aggregate the REPS repetitions: median for typical behavior, min fps
// and max p99 for worst case. Rows that dipped below 50 fps in any rep are
// listed with that rep's heap delta — a collapse coinciding with a large
// negative delta (post-GC) or preceded by growth points at GC, not renderer
// architecture.
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (v) => (v == null ? '—' : v.toFixed(1));
const row = (cells) =>
  cells.map((c, i) => String(c).padStart([8, 8, 6, 6, 6, 7, 8, 8, 8][i])).join(' ');

console.log(`\nmuxus webgl terminal renderer benchmark`);
console.log(`display ${DISPLAY}  ${HEADED ? 'headed (physical)' : 'headless (software GL expected)'}  reps=${REPS}  cpu_throttle=${CPU_THROTTLE}x  dpr=${DPR}x\n`);
for (const r of results) {
  console.log(`renderer=${r.renderer}  gpu="${r.glRenderer ?? '— (dom)'}"${r.glError ? '  addon error: ' + r.glError : ''}`);
  console.log(`viewport ${r.viewport.w}x${r.viewport.h}@${r.viewport.dpr}x  document.hidden=${r.hidden}\n`);
  console.log(row(['offered', 'parse', 'm_fps', 'lo_fps', 'm_p99', 'hi_p99', 'm_jank', 'm_long', 'm_cpu', 'm_drain']));
  const collapses = [];
  const cells = new Map();
  for (const p of r.phases) {
    if (p.phase === 'warmup') continue;
    const key = `${p.phase}@${p.offered}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
    if (p.fps < 50) collapses.push(p);
  }
  for (const ps of cells.values()) {
    const [phase, offered] = [ps[0].phase, ps[0].offered];
    const offeredLabel =
      phase === 'progress'
        ? (offered / 1000) + 'ku/s'
        : (offered / (1 << 20)) + 'MB/s';
    const parseLabel =
      phase === 'progress'
        ? fmt(median(ps.map((p) => p.parseRate)) / 1000) + 'ku/s'
        : fmt(median(ps.map((p) => p.parseRate))) + 'MB/s';
    console.log(
      phase.padEnd(11) + ' ' +
      row([
        offeredLabel,
        parseLabel,
        fmt(median(ps.map((p) => p.fps))),
        fmt(Math.min(...ps.map((p) => p.fps))),
        fmt(median(ps.map((p) => p.p99))),
        fmt(Math.max(...ps.map((p) => p.p99))),
        median(ps.map((p) => p.jank34)),
        median(ps.map((p) => p.longTasks)),
        fmt(median(ps.filter((p) => p.cpuSeconds != null).map((p) => p.cpuSeconds))),
        fmt(median(ps.map((p) => p.drainMs))),
      ]),
    );
  }
  if (collapses.length) {
    console.log('  collapsed reps (fps < 50):');
    for (const p of collapses) {
      console.log(
        `    ${p.phase} ${(p.offered / (p.phase === 'progress' ? 1000 : 1 << 20)).toFixed(0)}${p.phase === 'progress' ? 'ku/s' : 'MB/s'}` +
        ` rep${p.rep}: fps=${fmt(p.fps)} p99=${fmt(p.p99)}ms longtsk=${p.longTasks} heapΔ=${fmt(p.heapDelta)}MB`,
      );
    }
  }
  console.log('');
}
const reportPath = path.join(OUT_DIR, 'results.json');
fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
console.log(`results: ${reportPath}`);
