#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'client', 'dist');
const destination = path.join(root, 'app', 'internal', 'frontend', 'web');

await fs.mkdir(destination, { recursive: true });
for (const entry of await fs.readdir(destination)) {
  if (entry !== 'placeholder.txt') {
    await fs.rm(path.join(destination, entry), { recursive: true, force: true });
  }
}
const compress = new Set(['.css', '.html', '.js', '.json', '.map', '.svg', '.txt']);

async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, entry.name);
    const destinationPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath);
      continue;
    }
    const content = await fs.readFile(sourcePath);
    if (entry.name !== 'index.html' && compress.has(path.extname(entry.name))) {
      await fs.writeFile(`${destinationPath}.gz`, gzipSync(content, { level: 9 }));
    } else {
      await fs.writeFile(destinationPath, content);
    }
  }
}

await copyTree(source, destination);
