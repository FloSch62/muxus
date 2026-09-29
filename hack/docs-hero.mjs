// Generates the animated session map behind the docs landing page hero: terminal
// panes for hosts, dashed SSH links between neighbours and packets moving along them.
// Output: overrides/partials/muxus-hero-bg.html (included by overrides/partials/muxus-hero.html).
//
// Every host is its own small element so the browser can animate transform and
// opacity on the compositor without repainting; the dot grid and the links are one
// static SVG, and the packets move with plain transforms. Keyframes hold literal
// values on purpose: var() inside keyframes forces a style recalc every frame.
// Usage: node hack/docs-hero.mjs
import { writeFileSync } from 'node:fs';

const W = 1600;
const H = 560;
const OUT = 'overrides/partials/muxus-hero-bg.html';

// Deterministic PRNG so the field is stable between runs.
let seed = 20260902;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (lo, hi) => lo + rand() * (hi - lo);
const fmt = (n) => Number(n.toFixed(1));
const pct = (v, total) => ((v / total) * 100).toFixed(2);

// Hue runs from the logo cyan on the left to the app's primary blue on the right.
// Lightness and saturation are theme variables in extra.css, so one field serves both schemes.
const HUE_FROM = 185;
const HUE_TO = 228;
const hue = (cx, cy) => {
  const t = Math.min(1, Math.max(0, (cx / W) * 0.85 + (cy / H) * 0.15));
  return Math.round(HUE_FROM + (HUE_TO - HUE_FROM) * t);
};

// Demo hostnames, the same style the screenshot sandbox uses. None of them resolve.
const HOSTS = [
  'web-01', 'db-prod', 'edge-gw', 'bastion', 'build-03', 'nas', 'pi-lab', 'sw-core-1',
  'k8s-node-2', 'router', 'ci-runner', 'cache-02', 'dev-vm', 'lab-fw', 'mail-01', 'backup',
];

// Pane geometry (px on screen; the elements keep their size while positions scale with the hero).
const PANE = {
  l: { w: 112, h: 72, bar: 16, r: 6, dot: 2.2, dots: [10, 18, 26], lines: [[10, 26, 44], [10, 34, 66]], text: [10, 52], cursor: [10, 57] },
  s: { w: 56, h: 36, bar: 11, r: 4, dot: 1.6, dots: [7, 13, 19], lines: [[7, 17, 22], [7, 23, 34], [7, 29, 14]] },
};

// Copy sits in the middle of the band, from the brand pill down to the facts row; keep every
// pane and the links out of it. A superellipse hugs that block more closely than an ellipse
// would, which leaves the corners free for panes.
const inText = (x, y, pad = 0) => Math.abs((x - W / 2) / (490 + pad)) ** 3 + Math.abs((y - 237) / (205 + pad)) ** 3 < 1;

// The tour still overlaps the lower edge of the hero, so nothing needs to live down there.
const VISIBLE_BOTTOM = 470;

// Layers front to back. The labelled panes take fixed slots around the copy (two top corners,
// the two sides and a row along the bottom edge); the smaller layers are jittered grids that
// `keep` thins so the field looks placed, not tiled.
const layers = [
  { name: 'near', kind: 'l', slots: [[330, 62], [1270, 62], [250, 240], [1350, 240], [280, 445], [560, 445], [800, 448], [1040, 445], [1320, 445]], keep: 0.9, minGap: 0 },
  { name: 'mid', kind: 's', px: 112, py: 86, keep: 0.7, minGap: 96 },
  { name: 'far', kind: 'dot', px: 68, py: 58, keep: 0.34, minGap: 54 },
];

const items = [];
const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
for (const L of layers) {
  if (L.slots) {
    for (const [sx, sy] of L.slots) {
      if (rand() > L.keep) continue;
      items.push({ ...L, cx: sx + between(-28, 28), cy: sy + between(-8, 8) });
    }
    continue;
  }
  const cols = Math.ceil(W / L.px) + 2;
  const rows = Math.ceil(H / L.py) + 2;
  for (let j = -1; j < rows; j++) {
    for (let i = -1; i < cols; i++) {
      if (rand() > L.keep) continue;
      const cx = i * L.px + (j % 2 ? L.px / 2 : 0) + between(-L.px * 0.22, L.px * 0.22);
      const cy = j * L.py + between(-L.py * 0.22, L.py * 0.22);
      // The scene overflows narrow viewports sideways, so keep the labelled panes well inside;
      // vertically, a pane must not hang over the top edge or under the tour still below.
      const edgeX = 20;
      const edgeY = L.kind === 's' ? 24 : 12;
      if (cx < edgeX || cx > W - edgeX || cy < edgeY || cy > VISIBLE_BOTTOM) continue;
      if (inText(cx, cy, L.kind === 'dot' ? -140 : -12)) continue;
      // Keep the layers apart so a small pane never sits half under a big one.
      if (L.minGap && items.some((o) => o.kind !== 'dot' && dist(o, { cx, cy }) < L.minGap)) continue;
      items.push({ ...L, cx, cy });
    }
  }
}

// Links between neighbouring panes, at most two per pane so the field forms small chains.
const panes = items.filter((c) => c.kind !== 'dot');
const degree = new Map(panes.map((p) => [p, 0]));
const links = [];
const crossesText = (a, b) => [0.25, 0.5, 0.75].some((t) => inText(a.cx + (b.cx - a.cx) * t, a.cy + (b.cy - a.cy) * t, 20));
for (const maxDegree of [1, 2]) {
  for (const c of panes) {
    if (links.length >= 18 || degree.get(c) >= maxDegree) continue;
    let best = null;
    let bestD = Infinity;
    for (const o of panes) {
      if (o === c || degree.get(o) >= maxDegree) continue;
      if (links.some(([a, b]) => (a === c && b === o) || (a === o && b === c))) continue;
      const d = dist(c, o);
      if (d > 110 && d < 330 && d < bestD && !crossesText(c, o)) {
        best = o;
        bestD = d;
      }
    }
    if (best) {
      links.push([c, best]);
      degree.set(c, degree.get(c) + 1);
      degree.set(best, degree.get(best) + 1);
    }
  }
}

const paneDef = (id, g) => {
  let s = `    <g id="${id}">\n`;
  s += `      <rect class="mx-pane__body" x="0.5" y="0.5" width="${g.w - 1}" height="${g.h - 1}" rx="${g.r}"/>\n`;
  s += `      <line class="mx-pane__bar" x1="0.5" y1="${g.bar + 0.5}" x2="${g.w - 0.5}" y2="${g.bar + 0.5}"/>\n`;
  g.dots.forEach((cx, i) => {
    s += `      <circle class="mx-pane__dot mx-pane__dot--${i + 1}" cx="${cx}" cy="${(g.bar + 1) / 2}" r="${g.dot}"/>\n`;
  });
  for (const [x, y, w] of g.lines) {
    s += `      <rect class="mx-pane__line" x="${x}" y="${y}" width="${w}" height="3" rx="1.5"/>\n`;
  }
  s += `    </g>\n`;
  return s;
};

let out = '';
// Pane geometry, referenced by every instance below.
out += `<svg class="muxus-hero__defs" width="0" height="0" aria-hidden="true" focusable="false">\n  <defs>\n`;
out += paneDef('mx-pane-l', PANE.l);
out += paneDef('mx-pane-s', PANE.s);
out += `  </defs>\n</svg>\n`;

// The scene keeps a fixed 1600x560 aspect ratio and is scaled to cover the hero (see extra.css),
// so percentage positions here and the static SVG's viewBox line up.
out += `<div class="muxus-hero__scene">\n`;
out += `  <svg class="muxus-hero__static" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">\n`;
out += `    <defs>\n`;
out += `      <pattern id="mx-grid" width="32" height="32" patternUnits="userSpaceOnUse">\n`;
out += `        <circle cx="16" cy="16" r="1.1"/>\n`;
out += `      </pattern>\n`;
out += `      <radialGradient id="mx-fade" cx="50%" cy="45%" r="72%">\n`;
out += `        <stop offset="0" stop-color="#fff" stop-opacity="0.15"/>\n`;
out += `        <stop offset="0.55" stop-color="#fff" stop-opacity="0.75"/>\n`;
out += `        <stop offset="1" stop-color="#fff" stop-opacity="1"/>\n`;
out += `      </radialGradient>\n`;
out += `      <mask id="mx-edge"><rect width="${W}" height="${H}" fill="url(#mx-fade)"/></mask>\n`;
out += `    </defs>\n`;
out += `    <rect class="muxus-hero__grid" width="${W}" height="${H}" fill="url(#mx-grid)" mask="url(#mx-edge)"/>\n`;
out += `    <g class="muxus-hero__links">\n`;
for (const [a, b] of links) {
  out += `      <line x1="${fmt(a.cx)}" y1="${fmt(a.cy)}" x2="${fmt(b.cx)}" y2="${fmt(b.cy)}" vector-effect="non-scaling-stroke"/>\n`;
}
out += `    </g>\n`;
out += `  </svg>\n`;

// One animation per host (drift up and light up together). The delay follows the diagonal
// position so the pulse sweeps across the field as a wave; periods differ slightly so the
// field slowly loses lockstep.
const wave = (c, period) => (-((c.cx + c.cy * 0.7) / (W + H * 0.7)) * period - between(0, 0.6)).toFixed(2);

for (const L of [...layers].reverse()) {
  out += `  <div class="muxus-hero__layer muxus-hero__layer--${L.name}">\n`;
  for (const c of items.filter((c) => c.name === L.name)) {
    const h = hue(c.cx, c.cy);
    if (c.kind === 'dot') {
      // A third of the hosts stay still, which keeps the animated element count down.
      if (rand() < 0.33) {
        out += `    <i class="mx-dot mx-dot--still" style="left:${pct(c.cx, W)}%;top:${pct(c.cy, H)}%;--h:${h}"></i>\n`;
        continue;
      }
      const period = between(4.5, 7.5).toFixed(1);
      out += `    <i class="mx-dot" style="left:${pct(c.cx, W)}%;top:${pct(c.cy, H)}%;--h:${h};--t:${period}s;--d:${wave(c, period)}s"></i>\n`;
      continue;
    }
    const g = PANE[c.kind];
    const period = between(9, 12.5).toFixed(1);
    out += `    <i class="mx-pane mx-pane--${c.kind}" style="left:${pct(c.cx, W)}%;top:${pct(c.cy, H)}%;--h:${h};--t:${period}s;--d:${wave(c, period)}s">`;
    out += `<svg viewBox="0 0 ${g.w} ${g.h}"><use xlink:href="#mx-pane-${c.kind}"/>`;
    if (c.kind === 'l') {
      const host = HOSTS[items.filter((o) => o.kind === 'l').indexOf(c) % HOSTS.length];
      out += `<text class="mx-pane__prompt" x="${g.text[0]}" y="${g.text[1]}"><tspan class="mx-pane__ps">$</tspan> ssh ${host}</text>`;
    }
    out += `</svg>`;
    if (c.kind === 'l') {
      out += `<b class="mx-cursor" style="left:${g.cursor[0]}px;top:${g.cursor[1]}px;--d:${-between(0, 1).toFixed(2)}s"></b>`;
    }
    out += `</i>\n`;
  }
  out += `  </div>\n`;
}

// A small packet travels along each link, like traffic between the two hosts. The element
// is the link's bounding box and the visible dot sits in the corner the packet starts from,
// so the keyframes can move it by a literal 100% of its own size in the right direction.
out += `  <div class="muxus-hero__packets">\n`;
for (const [a, b] of links) {
  const [from, to] = rand() < 0.5 ? [a, b] : [b, a];
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const dir = (dx >= 0 ? 'e' : 'w') + (dy >= 0 ? 's' : 'n');
  const t = between(3.5, 6.5).toFixed(1);
  const d = -between(0, 6).toFixed(1);
  const box = `left:${pct(Math.min(from.cx, to.cx), W)}%;top:${pct(Math.min(from.cy, to.cy), H)}%;width:${pct(Math.abs(dx), W)}%;height:${pct(Math.abs(dy), H)}%`;
  out += `    <i class="mx-packet mx-packet--${dir}" style="${box};--h:${hue(from.cx, from.cy)};--t:${t}s;--d:${d}s"></i>\n`;
}
out += `  </div>\n`;
out += `</div>\n`;

writeFileSync(OUT, out);
const count = (kind) => items.filter((c) => c.kind === kind).length;
console.log(`${OUT}: ${count('l')} large panes, ${count('s')} small panes, ${count('dot')} hosts, ${links.length} links, ${(out.length / 1024).toFixed(1)} KiB`);
