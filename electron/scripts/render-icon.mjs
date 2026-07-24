import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Render the app icons from the Muxus SVG: icon.png (1024px) feeds the
// mac .icns / win .ico generation, icons/<size> the Linux hicolor set.
const root = path.dirname(fileURLToPath(import.meta.url));
const script = fileURLToPath(import.meta.url);
const svg = path.resolve(root, '../../client/public/muxus.svg');
const main = path.resolve(root, '../build/icon.png');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
// Keep the macOS/Windows source inside a platform-friendly safe area. Linux
// launchers add their own spacing, so its hicolor icons should use the full
// canvas (the SVG already contains a small amount of transparent padding).
const mainContentScale = 0.82;
const linuxContentScale = 1;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

const mtime = async (p) => (await stat(p).catch(() => undefined))?.mtimeMs ?? 0;

const sourceMtime = async () => Math.max(await mtime(svg), await mtime(script));

const outdated = async (p) => (await mtime(p)) <= (await sourceMtime());

const render = async (size, file, contentScale) => {
  const contentSize = Math.max(1, Math.round(size * contentScale));
  const left = Math.floor((size - contentSize) / 2);
  const top = Math.floor((size - contentSize) / 2);
  return sharp(svg, { density: 300 })
    .resize({
      width: contentSize,
      height: contentSize,
      fit: 'contain',
      background: transparent,
    })
    .extend({
      left,
      top,
      right: size - contentSize - left,
      bottom: size - contentSize - top,
      background: transparent,
    })
    .png()
    .toFile(file);
};

await mkdir(path.resolve(root, '../build/icons'), { recursive: true });
if (await outdated(main)) {
  await render(1024, main, mainContentScale);
  console.log(`rendered ${main}`);
}
for (const size of sizes) {
  const file = path.resolve(root, `../build/icons/${size}x${size}.png`);
  if (await outdated(file)) await render(size, file, linuxContentScale);
}
