import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Render the app icons from the Muxus SVG: icon.png (1024px) is for Linux;
// the iconset feeds macOS .icns and its 256px PNG feeds Windows .ico generation.
const root = path.dirname(fileURLToPath(import.meta.url));
const script = fileURLToPath(import.meta.url);
const svg = path.resolve(root, '../../client/public/muxus.svg');
const main = path.resolve(root, '../assets/icon.png');
// Keep the transparent glyph inside a macOS-friendly safe area instead of
// letting the non-square SVG fill and crop the generated square icon.
const contentScale = 0.82;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

const mtime = async (p) => (await stat(p).catch(() => undefined))?.mtimeMs ?? 0;

const sourceMtime = async () => Math.max(await mtime(svg), await mtime(script));

const outdated = async (p) => (await mtime(p)) <= (await sourceMtime());

const render = async (size, file) => {
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

await mkdir(path.resolve(root, '../assets'), { recursive: true });
if (await outdated(main)) {
  await render(1024, main);
  console.log(`rendered ${main}`);
}
// iconutil requires Apple's iconset filenames, including Retina variants.
await mkdir(path.resolve(root, '../assets/icon.iconset'), { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const file = path.resolve(root, `../assets/icon.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
    if (await outdated(file)) await render(size * scale, file);
  }
}
