import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultDist = resolve(dirname(scriptPath), '../dist');
const REPORT_VERSION = 1;
const UNAPPROVED_CHUNK_CAP = 700_000;

/** Relative limits catch meaningful PR growth; safety caps catch large eager
 * imports even when no base report is available (for example, local runs and
 * pushes to main). */
export const BUNDLE_POLICIES = [
  {
    key: 'initial',
    label: 'Initial JavaScript',
    growth: { raw: 25 * 1024, gzip: 8 * 1024 },
    safetyCap: { raw: 900 * 1024, gzip: 300 * 1024 },
  },
  {
    key: 'terminal',
    label: 'Terminal feature JavaScript',
    growth: { raw: 25 * 1024, gzip: 8 * 1024 },
    safetyCap: { raw: 600 * 1024, gzip: 165 * 1024 },
  },
  {
    key: 'monaco',
    label: 'Monaco full editor JavaScript',
    growth: { raw: 100 * 1024, gzip: 30 * 1024 },
    safetyCap: { raw: 4_500 * 1024, gzip: 1_150 * 1024 },
  },
  {
    key: 'typescriptWorker',
    label: 'TypeScript worker',
    growth: { raw: 100 * 1024, gzip: 30 * 1024 },
    safetyCap: { raw: 7_800 * 1024, gzip: 1_750 * 1024 },
  },
];

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatChange(bytes) {
  return `${bytes >= 0 ? '+' : ''}${format(bytes)}`;
}

function measurement(raw, gzip) {
  return { raw, gzip };
}

/** Measure the user-visible loading graphs from one Vite output directory. */
export function measureBundle(dist = defaultDist) {
  const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'));
  const entries = Object.entries(manifest);

  const manifestKeyForSource = (source) => {
    const match = entries.find(([key]) => key === source);
    if (!match) throw new Error(`Bundle manifest is missing ${source}`);
    return match[0];
  };

  const collectStaticGraph = (key, excluded = new Set(), result = new Set()) => {
    if (excluded.has(key) || result.has(key)) return result;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Bundle manifest references missing chunk ${key}`);
    result.add(key);
    for (const imported of chunk.imports ?? []) collectStaticGraph(imported, excluded, result);
    return result;
  };

  const measureFiles = (files) => {
    let raw = 0;
    let gzip = 0;
    for (const file of files) {
      const bytes = readFileSync(join(dist, file));
      raw += bytes.byteLength;
      gzip += gzipSync(bytes).byteLength;
    }
    return measurement(raw, gzip);
  };

  const measureGraph = (keys) =>
    measureFiles(
      [...keys]
        .map((key) => manifest[key].file)
        .filter((file) => file.endsWith('.js')),
    );

  const entry = entries.find(([, chunk]) => chunk.isEntry);
  if (!entry) throw new Error('Bundle manifest has no application entry');
  const initialKeys = collectStaticGraph(entry[0]);
  const featureGraph = (source) =>
    measureGraph(collectStaticGraph(manifestKeyForSource(source), initialKeys));

  const assetFiles = readdirSync(join(dist, 'assets')).filter((file) => file.endsWith('.js'));
  const typeScriptWorker = assetFiles.find((file) => file.startsWith('ts.worker-'));
  if (!typeScriptWorker) throw new Error('Bundle is missing the TypeScript worker');
  const monacoEntryFile = manifest[manifestKeyForSource('src/components/MonacoTextEditor.tsx')].file;

  const oversizedChunks = [];
  for (const file of assetFiles) {
    const bytes = readFileSync(join(dist, 'assets', file));
    if (
      bytes.byteLength > UNAPPROVED_CHUNK_CAP &&
      !file.includes('worker') &&
      !file.startsWith('editor.api-') &&
      // Vite 8.2 may fold Monaco's full editor-contributions layer into the
      // lazy feature entry itself. Its aggregate graph has a dedicated cap.
      `assets/${file}` !== monacoEntryFile &&
      // Rolldown names Monaco's full editor-contributions chunk after its
      // final CSS-bearing contribution in earlier Vite builds.
      !file.startsWith('toggleHighContrast-')
    ) {
      oversizedChunks.push({ file, raw: bytes.byteLength });
    }
  }

  return {
    version: REPORT_VERSION,
    metrics: {
      initial: measureGraph(initialKeys),
      terminal: featureGraph('src/components/TerminalViewImpl.tsx'),
      monaco: featureGraph('src/components/MonacoTextEditor.tsx'),
      typescriptWorker: measureFiles([`assets/${typeScriptWorker}`]),
    },
    oversizedChunks,
  };
}

function validateReport(report, source) {
  if (!report || report.version !== REPORT_VERSION || !report.metrics) {
    throw new Error(`${source} is not a bundle report version ${REPORT_VERSION}`);
  }
  for (const policy of BUNDLE_POLICIES) {
    const measured = report.metrics[policy.key];
    if (
      !measured ||
      !Number.isFinite(measured.raw) ||
      !Number.isFinite(measured.gzip) ||
      measured.raw < 0 ||
      measured.gzip < 0
    ) {
      throw new Error(`${source} has no valid ${policy.key} measurement`);
    }
  }
  if (!Array.isArray(report.oversizedChunks)) {
    throw new Error(`${source} has no oversizedChunks list`);
  }
  return report;
}

function exceededDimensions(measured, limit) {
  const exceeded = [];
  if (measured.raw > limit.raw) exceeded.push(`${measured.raw - limit.raw} B raw`);
  if (measured.gzip > limit.gzip) exceeded.push(`${measured.gzip - limit.gzip} B gzip`);
  return exceeded.join(' and ');
}

/** Evaluate relative growth and absolute safety boundaries separately so a
 * small intentional feature does not require ratcheting a hard-coded ceiling. */
export function evaluateBundleReport(report, baseline) {
  validateReport(report, 'bundle report');
  if (baseline) validateReport(baseline, 'baseline bundle report');
  const failures = [];

  for (const policy of BUNDLE_POLICIES) {
    const measured = report.metrics[policy.key];
    if (
      measured.raw > policy.safetyCap.raw ||
      measured.gzip > policy.safetyCap.gzip
    ) {
      failures.push(
        `${policy.label} exceeds its safety cap by ${exceededDimensions(measured, policy.safetyCap)}`,
      );
    }

    if (!baseline) continue;
    const previous = baseline.metrics[policy.key];
    const growth = measurement(measured.raw - previous.raw, measured.gzip - previous.gzip);
    if (growth.raw > policy.growth.raw || growth.gzip > policy.growth.gzip) {
      failures.push(
        `${policy.label} exceeds allowed PR growth by ${exceededDimensions(growth, policy.growth)}`,
      );
    }
  }

  for (const chunk of report.oversizedChunks) {
    failures.push(
      `${chunk.file} exceeds the unapproved chunk limit by ${chunk.raw - UNAPPROVED_CHUNK_CAP} B (${format(chunk.raw)} total)`,
    );
  }
  return failures;
}

function printReport(report, baseline) {
  for (const policy of BUNDLE_POLICIES) {
    const measured = report.metrics[policy.key];
    const detail = `${format(measured.raw)} raw / ${format(measured.gzip)} gzip`;
    if (!baseline) {
      console.log(`${policy.label}: ${detail}`);
      continue;
    }
    const previous = baseline.metrics[policy.key];
    console.log(
      `${policy.label}: ${detail} (${formatChange(measured.raw - previous.raw)} raw / ${formatChange(measured.gzip - previous.gzip)} gzip vs base)`,
    );
  }
}

function parseArgs(args) {
  const options = { dist: defaultDist };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--report-only') {
      options.reportOnly = true;
      continue;
    }
    if (arg === '--dist' || arg === '--baseline' || arg === '--write-report') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a path`);
      const key = arg === '--dist' ? 'dist' : arg === '--baseline' ? 'baseline' : 'writeReport';
      options[key] = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = measureBundle(options.dist);
  const baseline = options.baseline
    ? validateReport(JSON.parse(readFileSync(options.baseline, 'utf8')), options.baseline)
    : undefined;
  printReport(report, baseline);

  if (options.writeReport) {
    writeFileSync(options.writeReport, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Bundle report written to ${options.writeReport}`);
  }
  if (options.reportOnly) return;

  const failures = evaluateBundleReport(report, baseline);
  if (failures.length > 0) {
    console.error('\nBundle check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    baseline
      ? 'Bundle growth and safety caps passed.'
      : 'Bundle safety caps passed (relative growth requires a base report).',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) main();
