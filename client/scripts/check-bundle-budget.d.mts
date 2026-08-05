export type BundleMetricKey = 'initial' | 'terminal' | 'monaco' | 'typescriptWorker';

export interface BundleMeasurement {
  raw: number;
  gzip: number;
}

export interface BundleReport {
  version: 1;
  metrics: Record<BundleMetricKey, BundleMeasurement>;
  oversizedChunks: Array<{ file: string; raw: number }>;
}

export interface BundlePolicy {
  key: BundleMetricKey;
  label: string;
  growth: BundleMeasurement;
  safetyCap: BundleMeasurement;
}

export const BUNDLE_POLICIES: BundlePolicy[];
export function measureBundle(dist?: string): BundleReport;
export function evaluateBundleReport(
  report: BundleReport,
  baseline?: BundleReport,
): string[];
