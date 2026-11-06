/** How a script is spread over its hosts. */
export type RunMode =
  | { kind: 'parallel' }
  /** `size` hosts at a time; the next batch starts when the whole batch is done. */
  | { kind: 'batches'; size: number }
  | { kind: 'sequential' };

export type HostRunState =
  | 'queued'
  | 'connecting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface HostRunOutcome {
  state: 'completed' | 'failed' | 'cancelled';
}

/** Hosts in the order they start, grouped into the waves that run together. */
export function runWaves<T>(hosts: readonly T[], mode: RunMode): T[][] {
  if (hosts.length === 0) return [];
  const size =
    mode.kind === 'parallel' ? hosts.length : mode.kind === 'sequential' ? 1 : Math.max(1, Math.floor(mode.size));
  const waves: T[][] = [];
  for (let i = 0; i < hosts.length; i += size) waves.push(hosts.slice(i, i + size));
  return waves;
}

/**
 * Run `runOne` over the hosts wave by wave. With `stopOnFailure`, a failed
 * host lets its own wave finish and marks every later host skipped. A
 * cancelled job starts nothing more.
 */
export async function runJob<T>(
  hosts: readonly T[],
  options: {
    mode: RunMode;
    stopOnFailure: boolean;
    cancelled: () => boolean;
    runOne: (host: T) => Promise<HostRunOutcome>;
    skip: (host: T) => void;
  },
): Promise<void> {
  const waves = runWaves(hosts, options.mode);
  for (const [index, wave] of waves.entries()) {
    if (options.cancelled()) {
      for (const host of waves.slice(index).flat()) options.skip(host);
      return;
    }
    const outcomes = await Promise.all(wave.map((host) => options.runOne(host)));
    if (options.stopOnFailure && outcomes.some((outcome) => outcome.state === 'failed')) {
      for (const host of waves.slice(index + 1).flat()) options.skip(host);
      return;
    }
  }
}
