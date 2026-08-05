import { describe, expect, it } from 'vitest';
import {
  BUNDLE_POLICIES,
  evaluateBundleReport,
  type BundleMetricKey,
  type BundlePolicy,
  type BundleReport,
} from '../../../client/scripts/check-bundle-budget.mjs';

function policy(key: BundleMetricKey): BundlePolicy {
  const result = BUNDLE_POLICIES.find((candidate) => candidate.key === key);
  if (!result) throw new Error(`Missing ${key} bundle policy`);
  return result;
}

function report(size = 100_000): BundleReport {
  return {
    version: 1,
    metrics: Object.fromEntries(
      BUNDLE_POLICIES.map(({ key }) => [key, { raw: size, gzip: size }]),
    ) as BundleReport['metrics'],
    oversizedChunks: [],
  };
}

describe('bundle budget policy', () => {
  it('accepts small growth relative to the base bundle', () => {
    const baseline = report();
    const current = report();
    const initial = policy('initial');
    current.metrics.initial.raw += initial.growth.raw;
    current.metrics.initial.gzip += initial.growth.gzip;

    expect(evaluateBundleReport(current, baseline)).toEqual([]);
  });

  it('reports the exact bytes above the allowed PR growth', () => {
    const baseline = report();
    const current = report();
    current.metrics.initial.raw += policy('initial').growth.raw + 40;

    expect(evaluateBundleReport(current, baseline)).toEqual([
      'Initial JavaScript exceeds allowed PR growth by 40 B raw',
    ]);
  });

  it('enforces emergency caps without a base report', () => {
    const current = report();
    current.metrics.terminal.gzip = policy('terminal').safetyCap.gzip + 1;

    expect(evaluateBundleReport(current)).toEqual([
      'Terminal feature JavaScript exceeds its safety cap by 1 B gzip',
    ]);
  });

  it('keeps blocking unapproved large chunks', () => {
    const current = report();
    current.oversizedChunks.push({ file: 'accidental.js', raw: 700_001 });

    expect(evaluateBundleReport(current)).toEqual([
      'accidental.js exceeds the unapproved chunk limit by 1 B (683.6 KiB total)',
    ]);
  });
});
