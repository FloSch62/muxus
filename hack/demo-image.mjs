// Draws the chart that the kitty-graphics screenshot renders inside a terminal,
// and wraps it in the kitty transmission escape. No image libraries: a few
// hundred bytes of pixels, deflate, and the PNG chunk framing.
import { deflateSync } from 'node:zlib';

const WIDTH = 720;
const HEIGHT = 360;

const PALETTE = {
  background: [24, 26, 32, 255],
  panel: [30, 33, 41, 255],
  grid: [55, 60, 72, 255],
  axis: [110, 118, 135, 255],
  line: [56, 189, 248, 255],
  fill: [56, 189, 248, 60],
  accent: [163, 230, 53, 255],
};

function blend(canvas, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  const alpha = a / 255;
  canvas[i] = Math.round(canvas[i] * (1 - alpha) + r * alpha);
  canvas[i + 1] = Math.round(canvas[i + 1] * (1 - alpha) + g * alpha);
  canvas[i + 2] = Math.round(canvas[i + 2] * (1 - alpha) + b * alpha);
  canvas[i + 3] = 255;
}

function rect(canvas, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) blend(canvas, x, y, color);
}

function disc(canvas, cx, cy, radius, color) {
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      if (x * x + y * y <= radius * radius) blend(canvas, cx + x, cy + y, color);
    }
  }
}

/** A plausible request-latency curve — deterministic, so reruns are identical. */
function series(count) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const wave = Math.sin(t * Math.PI * 3.1) * 0.18 + Math.sin(t * Math.PI * 7.3) * 0.07;
    const drift = 0.45 + t * 0.25;
    points.push(Math.min(0.95, Math.max(0.05, drift + wave)));
  }
  return points;
}

export function chartPng() {
  const canvas = Buffer.alloc(WIDTH * HEIGHT * 4);
  rect(canvas, 0, 0, WIDTH, HEIGHT, PALETTE.background);

  const plot = { left: 56, top: 40, right: WIDTH - 24, bottom: HEIGHT - 40 };
  rect(canvas, plot.left, plot.top, plot.right, plot.bottom, PALETTE.panel);

  for (let i = 0; i <= 4; i++) {
    const y = Math.round(plot.top + ((plot.bottom - plot.top) * i) / 4);
    rect(canvas, plot.left, y, plot.right, y + 1, PALETTE.grid);
  }
  for (let i = 0; i <= 6; i++) {
    const x = Math.round(plot.left + ((plot.right - plot.left) * i) / 6);
    rect(canvas, x, plot.top, x + 1, plot.bottom, PALETTE.grid);
  }
  rect(canvas, plot.left, plot.top, plot.left + 2, plot.bottom, PALETTE.axis);
  rect(canvas, plot.left, plot.bottom - 2, plot.right, plot.bottom, PALETTE.axis);

  const points = series(plot.right - plot.left);
  let previous = null;
  points.forEach((value, index) => {
    const x = plot.left + index;
    const y = Math.round(plot.bottom - value * (plot.bottom - plot.top));
    rect(canvas, x, y, x + 1, plot.bottom - 2, PALETTE.fill);
    const from = previous ?? y;
    for (let step = Math.min(from, y); step <= Math.max(from, y); step++) {
      rect(canvas, x, step - 1, x + 2, step + 2, PALETTE.line);
    }
    previous = y;
  });

  const last = points[points.length - 1];
  disc(canvas, plot.right - 1, Math.round(plot.bottom - last * (plot.bottom - plot.top)), 5, PALETTE.accent);

  return encodePng(canvas);
}

// --- PNG container -------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng(rgba) {
  const raw = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    raw[y * (WIDTH * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (WIDTH * 4 + 1) + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The kitty graphics escape: a chunked, direct PNG transmission + placement. */
export function kittySequence(png, { columns = 60, rows = 15 } = {}) {
  const payload = png.toString('base64');
  const size = 4096;
  const parts = [];
  for (let offset = 0; offset < payload.length; offset += size) {
    const slice = payload.slice(offset, offset + size);
    const more = offset + size < payload.length ? 1 : 0;
    const control =
      offset === 0 ? `a=T,f=100,c=${columns},r=${rows},m=${more}` : `m=${more}`;
    parts.push(`\x1b_G${control};${slice}\x1b\\`);
  }
  return `${parts.join('')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(kittySequence(chartPng()));
}
