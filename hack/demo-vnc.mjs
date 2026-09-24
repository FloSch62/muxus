// A tiny VNC server for the documentation sandbox. It speaks just enough RFB 3.8
// (no authentication, raw encoding) to hand noVNC one frame: an invented desktop
// drawn from rectangles, so the remote-desktop screenshots contain no real host.
import net from 'node:net';

/** RGB colour helpers. */
const hex = (value) => [
  Number.parseInt(value.slice(1, 3), 16),
  Number.parseInt(value.slice(3, 5), 16),
  Number.parseInt(value.slice(5, 7), 16),
];
const mix = (a, b, t) => a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));

function drawDesktop(width, height) {
  const pixels = new Uint8Array(width * height * 3);
  const set = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    pixels.set(colour, (y * width + x) * 3);
  };
  const rect = (x, y, w, h, colour, radius = 0) => {
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        if (radius) {
          const dx = Math.max(radius - col, col - (w - 1 - radius), 0);
          const dy = Math.max(radius - row, row - (h - 1 - radius), 0);
          if (dx * dx + dy * dy > radius * radius) continue;
        }
        set(x + col, y + row, colour);
      }
    }
  };
  const circle = (cx, cy, r, colour) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) set(cx + x, cy + y, colour);
  };

  // Wallpaper: a deep blue to teal gradient with a soft diagonal band.
  const top = hex('#10224a');
  const bottom = hex('#15707c');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = Math.max(0, 1 - Math.abs((x - y * 1.4) - width * 0.35) / (width * 0.35));
      set(x, y, mix(mix(top, bottom, y / height), hex('#3aa6b9'), band * 0.18));
    }
  }

  // Desktop icons.
  for (const [i, colour] of ['#60a5fa', '#fbbf24', '#34d399'].entries()) {
    rect(28, 28 + i * 86, 48, 40, hex(colour), 6);
    rect(34, 76 + i * 86, 36, 5, hex('#dbe7f5'), 2);
  }

  // A dashboard window.
  const wx = 150;
  const wy = 70;
  const ww = Math.round(width * 0.58);
  const wh = Math.round(height * 0.66);
  rect(wx + 6, wy + 8, ww, wh, hex('#0b1830'), 10);
  rect(wx, wy, ww, wh, hex('#f8fafc'), 10);
  rect(wx, wy, ww, 36, hex('#e2e8f0'), 10);
  rect(wx, wy + 26, ww, 10, hex('#e2e8f0'));
  rect(wx + 16, wy + 13, 160, 10, hex('#94a3b8'), 5);
  for (const [i, colour] of ['#94a3b8', '#94a3b8', '#ef4444'].entries()) circle(wx + ww - 70 + i * 24, wy + 18, 6, hex(colour));
  rect(wx, wy + 36, 170, wh - 36, hex('#eef2f7'));
  for (let i = 0; i < 7; i++) rect(wx + 20, wy + 64 + i * 34, i === 1 ? 120 : 96 + (i % 3) * 14, 10, hex(i === 1 ? '#6366f1' : '#b6c2d2'), 5);
  const cx = wx + 200;
  const cw = ww - 230;
  for (const [i, colour] of ['#6366f1', '#22c55e', '#f59e0b'].entries()) {
    const x = cx + i * Math.round(cw / 3);
    rect(x, wy + 60, Math.round(cw / 3) - 16, 70, hex('#ffffff'), 8);
    rect(x + 14, wy + 76, 60, 8, hex('#cbd5e1'), 4);
    rect(x + 14, wy + 96, 90, 18, hex(colour), 5);
  }
  const chartTop = wy + 150;
  const chartHeight = wh - 190;
  rect(cx, chartTop, cw - 16, chartHeight, hex('#ffffff'), 8);
  const bars = [0.42, 0.58, 0.51, 0.72, 0.64, 0.81, 0.69, 0.88, 0.77, 0.93, 0.84, 0.97];
  const barWidth = Math.floor((cw - 60) / bars.length) - 8;
  bars.forEach((value, i) => {
    const h = Math.round((chartHeight - 50) * value);
    rect(cx + 22 + i * (barWidth + 8), chartTop + chartHeight - 22 - h, barWidth, h, hex(i === bars.length - 1 ? '#6366f1' : '#a5b4fc'), 4);
  });

  // A terminal window overlapping it.
  const tx = wx + ww - 150;
  const ty = wy + wh - 190;
  const tw = Math.round(width * 0.36);
  const th = Math.round(height * 0.38);
  rect(tx + 6, ty + 8, tw, th, hex('#06101f'), 10);
  rect(tx, ty, tw, th, hex('#1e2430'), 10);
  rect(tx, ty, tw, 30, hex('#2b3342'), 10);
  rect(tx, ty + 22, tw, 8, hex('#2b3342'));
  for (const [i, colour] of ['#ef4444', '#f59e0b', '#22c55e'].entries()) circle(tx + 20 + i * 20, ty + 15, 5, hex(colour));
  const lines = [[0.55, '#86efac'], [0.8, '#cbd5e1'], [0.62, '#cbd5e1'], [0.35, '#93c5fd'], [0.7, '#cbd5e1'], [0.45, '#86efac'], [0.25, '#cbd5e1']];
  lines.forEach(([fraction, colour], i) => rect(tx + 18, ty + 48 + i * 26, Math.round((tw - 40) * fraction), 9, hex(colour), 4));

  // Taskbar.
  rect(0, height - 44, width, 44, hex('#0c1424'));
  rect(12, height - 34, 24, 24, hex('#6366f1'), 5);
  for (const [i, colour] of ['#60a5fa', '#f8fafc', '#34d399', '#fbbf24'].entries()) {
    rect(56 + i * 40, height - 34, 24, 24, hex(colour), 5);
  }
  rect(width - 96, height - 28, 80, 12, hex('#64748b'), 6);
  return pixels;
}

const u16 = (value) => Buffer.from([value >> 8, value & 0xff]);
const u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

function pixelFormatBytes(format) {
  return Buffer.from([
    32, 24, format.bigEndian ? 1 : 0, 1,
    0, 255, 0, 255, 0, 255,
    format.redShift, format.greenShift, format.blueShift,
    0, 0, 0,
  ]);
}

/** Serve `name` on 127.0.0.1:`port`; resolves with the net.Server. */
export function startDemoVnc({ port, width = 1280, height = 800, name = 'design-vm' }) {
  const desktop = drawDesktop(width, height);

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let format = { bigEndian: false, redShift: 16, greenShift: 8, blueShift: 0 };
    let state = 'version';
    let pending = Buffer.alloc(0);

    const sendFrame = () => {
      const pixels = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const value =
          (desktop[i * 3] << format.redShift) |
          (desktop[i * 3 + 1] << format.greenShift) |
          (desktop[i * 3 + 2] << format.blueShift);
        if (format.bigEndian) pixels.writeUInt32BE(value >>> 0, i * 4);
        else pixels.writeUInt32LE(value >>> 0, i * 4);
      }
      socket.write(Buffer.concat([Buffer.from([0, 0]), u16(1), u16(0), u16(0), u16(width), u16(height), u32(0), pixels]));
    };

    socket.write('RFB 003.008\n');
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (state === 'version') {
          if (pending.length < 12) return;
          pending = pending.subarray(12);
          socket.write(Buffer.from([1, 1])); // one security type: None
          state = 'security';
        } else if (state === 'security') {
          if (pending.length < 1) return;
          pending = pending.subarray(1);
          socket.write(u32(0));
          state = 'init';
        } else if (state === 'init') {
          if (pending.length < 1) return;
          pending = pending.subarray(1);
          socket.write(Buffer.concat([u16(width), u16(height), pixelFormatBytes(format), u32(name.length), Buffer.from(name)]));
          state = 'messages';
        } else {
          if (pending.length < 1) return;
          const type = pending[0];
          const size =
            type === 0 ? 20
            : type === 2 ? (pending.length >= 4 ? 4 + 4 * pending.readUInt16BE(2) : Infinity)
            : type === 3 ? 10
            : type === 4 ? 8
            : type === 5 ? 6
            : type === 6 ? (pending.length >= 8 ? 8 + pending.readUInt32BE(4) : Infinity)
            : undefined;
          if (size === undefined) {
            socket.destroy();
            return;
          }
          if (pending.length < size) return;
          const message = pending.subarray(0, size);
          pending = pending.subarray(size);
          if (type === 0) {
            format = {
              bigEndian: message[6] === 1,
              redShift: message[14],
              greenShift: message[15],
              blueShift: message[16],
            };
          }
          // Only full refreshes get a frame: the picture never changes.
          if (type === 3 && message[1] === 0) sendFrame();
        }
      }
    });
    socket.on('error', () => undefined);
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
