// Pictures for the demo hosts' ~/renders folder, which the kitty-graphics
// screenshot browses with yazi. Drawn here pixel by pixel, so every image on
// screen is invented and reruns are identical.
import { chartPng, encodePng } from './demo-image.mjs';

const W = 960;
const H = 600;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));

/** A gradient through evenly spaced stops, t in 0..1. */
function ramp(stops, t) {
  const scaled = clamp(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  return mixRgb(stops[i], stops[i + 1], scaled - i);
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Renders `pixel(x, y) → [r, g, b]` (0–255) into a PNG, 2×2 supersampled. */
function paint(pixel) {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const [pr, pg, pb] = pixel(x + dx, y + dy);
        r += pr;
        g += pg;
        b += pb;
      }
      const i = (y * W + x) * 4;
      rgba[i] = clamp(r / 4, 0, 255);
      rgba[i + 1] = clamp(g / 4, 0, 255);
      rgba[i + 2] = clamp(b / 4, 0, 255);
      rgba[i + 3] = 255;
    }
  }
  return encodePng(rgba, W, H);
}

// ---------------------------------------------------------------------------

function mandelbrot() {
  const cx = -0.7453;
  const cy = 0.1127;
  const span = 0.0065;
  const limit = 400;
  const inside = hex('#0b1020');
  const palette = ['#0b1020', '#16307a', '#2a86c9', '#bfe9ff', '#ffd27a', '#c2551d', '#3a0f2e', '#0b1020'].map(hex);
  return paint((px, py) => {
    const x0 = cx + (px / W - 0.5) * span;
    const y0 = cy + (py / H - 0.5) * span * (H / W);
    let x = 0;
    let y = 0;
    let n = 0;
    while (x * x + y * y < 256 && n < limit) {
      const xt = x * x - y * y + x0;
      y = 2 * x * y + y0;
      x = xt;
      n++;
    }
    if (n === limit) return inside;
    const mu = n + 1 - Math.log2(Math.log(Math.sqrt(x * x + y * y)));
    // Bands of deep blue, ice and amber that repeat outward from the set.
    return ramp(palette, (Math.sqrt(mu) * 0.19 + 0.35) % 1);
  });
}

function synthwave() {
  const horizon = H * 0.64;
  const sun = { x: W / 2, y: horizon - H * 0.2, r: H * 0.24 };
  const sky = ['#140a33', '#3b1366', '#8a2a8c', '#ff5c8a'].map(hex);
  const sunTop = hex('#ffe55c');
  const sunBottom = hex('#ff3d8b');
  const ridge = (x) =>
    horizon -
    H * (0.07 + 0.05 * Math.sin(x / 70 + 1.3) + 0.03 * Math.sin(x / 23 + 0.4) + 0.015 * Math.sin(x / 9)) *
      (0.55 + 0.45 * Math.abs(x / W - 0.5) * 2);
  const stars = random(7);
  const starField = Array.from({ length: 140 }, () => [stars() * W, stars() * horizon * 0.7, stars()]);

  return paint((x, y) => {
    if (y < horizon) {
      let color = ramp(sky, y / horizon);
      for (const [sx, sy, s] of starField) {
        const d = Math.hypot(x - sx, y - sy);
        if (d < 1.6) color = mixRgb(color, [255, 255, 255], (1 - d / 1.6) * (0.4 + 0.6 * s));
      }
      // The sun, cut by bands that thicken toward the horizon.
      const d = Math.hypot(x - sun.x, y - sun.y);
      const glow = Math.exp(-Math.max(0, d - sun.r) / 60) * 0.35;
      color = mixRgb(color, [255, 120, 170], glow);
      if (d < sun.r) {
        const v = (y - (sun.y - sun.r)) / (2 * sun.r);
        const band = v > 0.5 ? (v - 0.5) * 2 : -1;
        const stripe = band >= 0 && ((v * 22) % 1) < 0.15 + band * 0.45;
        if (!stripe) color = mixRgb(sunTop, sunBottom, smooth(0, 1, v));
      }
      const top = ridge(x);
      if (y > top) {
        const edge = clamp(1 - (y - top) / 3);
        color = mixRgb(hex('#2a0d4d'), [255, 92, 200], edge * 0.8);
      }
      return color;
    }
    // The floor: a grid in perspective under a magenta haze.
    const depth = (y - horizon) / (H - horizon);
    let color = mixRgb(hex('#1a0630'), hex('#0a0214'), depth);
    color = mixRgb(color, [255, 60, 160], Math.exp(-depth * 9) * 0.55);
    const z = 1 / Math.max(depth, 0.0001);
    const row = Math.abs(((z * 3) % 1) - 0.5) * 2;
    const rowWidth = 0.08 * z;
    const lineH = clamp(1 - (1 - row) / Math.min(rowWidth, 0.9) * 0.5);
    const u = ((x - W / 2) / (depth * W)) * 9;
    const col = Math.abs((u % 1 + 1) % 1 - 0.5) * 2;
    const lineV = clamp((col - (1 - 0.06 / depth / 9)) / (0.06 / depth / 9));
    const line = Math.max(lineH > 0.75 ? (lineH - 0.75) * 4 : 0, lineV);
    return mixRgb(color, hex('#ff4fd8'), line * clamp(depth * 3));
  });
}

function aurora() {
  const shore = H * 0.62;
  const sky = ['#020617', '#061a33', '#0d3047'].map(hex);
  const green = hex('#3ef5a1');
  const violet = hex('#a35cff');
  const stars = random(21);
  const starField = Array.from({ length: 220 }, () => [stars() * W, stars() * shore, stars()]);
  const curtain = (x) => H * 0.3 + 55 * Math.sin(x / 170 + 0.8) + 22 * Math.sin(x / 67 + 2.1);
  const ridge = (x) =>
    shore - H * (0.035 + 0.06 * Math.pow(Math.abs(Math.sin(x / 190 + 0.3)), 1.5) + 0.01 * Math.sin(x / 43) + 0.003 * Math.sin(x / 9));

  const skyAt = (x, y) => {
    let color = ramp(sky, y / shore);
    for (const [sx, sy, s] of starField) {
      const d = Math.hypot(x - sx, y - sy);
      if (d < 1.4) color = mixRgb(color, [230, 240, 255], (1 - d / 1.4) * (0.3 + 0.7 * s));
    }
    // Light falls off sharply below the curtain's edge and slowly above it,
    // in vertical rays that shimmer along the band.
    const edge = curtain(x);
    const below = y - edge;
    const rays =
      0.7 + 0.18 * Math.sin(x / 4.1 + Math.sin(x / 29) * 4) + 0.12 * Math.sin(x / 11.3 + Math.sin(x / 53) * 2);
    const envelope = 0.25 + 0.75 * smooth(-0.6, 1, Math.sin(x / 150 + 1.7) * 0.6 + Math.sin(x / 61) * 0.4);
    const intensity = (below > 0 ? Math.exp(-below / 6) : Math.exp(below / 90)) * rays * envelope;
    const height = clamp(-below / 200);
    const light = mixRgb(green, violet, smooth(0.35, 1, height));
    return [0, 1, 2].map((k) => color[k] + light[k] * intensity * 1.25);
  };

  return paint((x, y) => {
    const top = ridge(x);
    if (y < top) return skyAt(x, y);
    if (y < shore) return mixRgb(hex('#07111f'), hex('#0c1a2c'), (y - top) / (shore - top));
    // The lake mirrors the sky, darker and broken by ripples.
    const mirror = 2 * shore - y;
    const ripple = Math.sin(y * 0.9 + Math.sin(x / 40) * 2) * (y - shore) * 0.04;
    const reflected = mirror < ridge(x + ripple) ? skyAt(x + ripple, mirror) : hex('#03070f');
    return mixRgb(reflected, hex('#020611'), 0.45 + 0.4 * ((y - shore) / (H - shore)));
  });
}

/** The pictures by file name. */
export function galleryPngs() {
  return {
    'aurora.png': aurora(),
    'latency-p95.png': chartPng(),
    'mandelbrot.png': mandelbrot(),
    'synthwave.png': synthwave(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const out = process.argv[2] ?? 'gallery';
  await mkdir(out, { recursive: true });
  for (const [name, png] of Object.entries(galleryPngs())) await writeFile(`${out}/${name}`, png);
}
