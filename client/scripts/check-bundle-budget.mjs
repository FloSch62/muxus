import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'));
const entries = Object.entries(manifest);

function manifestKeyForSource(source) {
  const match = entries.find(([key]) => key === source);
  if (!match) throw new Error(`Bundle manifest is missing ${source}`);
  return match[0];
}

function collectStaticGraph(key, excluded = new Set(), result = new Set()) {
  if (excluded.has(key) || result.has(key)) return result;
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Bundle manifest references missing chunk ${key}`);
  result.add(key);
  for (const imported of chunk.imports ?? []) collectStaticGraph(imported, excluded, result);
  return result;
}

function measureFiles(files) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const bytes = readFileSync(join(dist, file));
    raw += bytes.byteLength;
    gzip += gzipSync(bytes).byteLength;
  }
  return { raw, gzip };
}

function measureGraph(keys) {
  return measureFiles(
    [...keys]
      .map((key) => manifest[key].file)
      .filter((file) => file.endsWith('.js')),
  );
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const failures = [];
function check(label, measured, budget) {
  const detail = `${format(measured.raw)} raw / ${format(measured.gzip)} gzip`;
  console.log(`${label}: ${detail}`);
  if (measured.raw > budget.raw || measured.gzip > budget.gzip) {
    failures.push(
      `${label} exceeds ${format(budget.raw)} raw / ${format(budget.gzip)} gzip (${detail})`,
    );
  }
}

const entry = entries.find(([, chunk]) => chunk.isEntry);
if (!entry) throw new Error('Bundle manifest has no application entry');
const initialKeys = collectStaticGraph(entry[0]);

check('Initial JavaScript', measureGraph(initialKeys), {
  raw: 750_000,
  gzip: 240_000,
});

for (const feature of [
  {
    label: 'Terminal feature JavaScript',
    source: 'src/components/TerminalViewImpl.tsx',
    budget: { raw: 520_000, gzip: 140_000 },
  },
  {
    // The editor is intent-preloaded and lazy. This budget covers Monaco's
    // complete standalone contribution set (commands, formatting, folding,
    // suggestions, navigation, accessibility, etc.), not the initial app.
    label: 'Monaco full editor JavaScript',
    source: 'src/components/MonacoTextEditor.tsx',
    budget: { raw: 4_050_000, gzip: 1_020_000 },
  },
]) {
  const featureKeys = collectStaticGraph(
    manifestKeyForSource(feature.source),
    initialKeys,
  );
  check(feature.label, measureGraph(featureKeys), feature.budget);
}

const assetFiles = readdirSync(join(dist, 'assets')).filter((file) => file.endsWith('.js'));
const typeScriptWorker = assetFiles.find((file) => file.startsWith('ts.worker-'));
if (!typeScriptWorker) throw new Error('Bundle is missing the TypeScript worker');
check('TypeScript worker', measureFiles([`assets/${typeScriptWorker}`]), {
  raw: 7_100_000,
  gzip: 1_550_000,
});

for (const file of assetFiles) {
  const bytes = readFileSync(join(dist, 'assets', file));
  if (
    bytes.byteLength > 700_000 &&
    !file.includes('worker') &&
    !file.startsWith('editor.api-') &&
    // Rolldown names Monaco's full editor-contributions chunk after its final
    // CSS-bearing contribution. It is part of the measured lazy editor graph.
    !file.startsWith('toggleHighContrast-')
  ) {
    failures.push(`${file} is ${format(bytes.byteLength)}; unapproved chunks must stay below 683.6 KiB`);
  }
}

if (failures.length > 0) {
  console.error('\nBundle budget failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Bundle budgets passed.');
}
