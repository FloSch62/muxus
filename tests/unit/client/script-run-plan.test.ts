import { describe, expect, it } from 'vitest';
import { runJob, runWaves } from '../../../client/src/scripts/run-plan.js';

describe('script run waves', () => {
  const hosts = ['a', 'b', 'c', 'd', 'e'];

  it('runs everything together, in batches, or one by one', () => {
    expect(runWaves(hosts, { kind: 'parallel' })).toEqual([hosts]);
    expect(runWaves(hosts, { kind: 'batches', size: 2 })).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(runWaves(hosts, { kind: 'sequential' })).toEqual([['a'], ['b'], ['c'], ['d'], ['e']]);
    expect(runWaves([], { kind: 'parallel' })).toEqual([]);
  });

  it('starts a batch only when the one before has finished', async () => {
    const events: string[] = [];
    await runJob(hosts, {
      mode: { kind: 'batches', size: 2 },
      stopOnFailure: false,
      cancelled: () => false,
      skip: () => undefined,
      runOne: async (host) => {
        events.push(`start ${host}`);
        await new Promise((resolve) => setTimeout(resolve, host === 'a' ? 20 : 1));
        events.push(`end ${host}`);
        return { state: 'completed' };
      },
    });
    expect(events.indexOf('start c')).toBeGreaterThan(events.indexOf('end a'));
    expect(events.indexOf('start c')).toBeGreaterThan(events.indexOf('end b'));
  });

  it('skips the rest after a failure when asked to', async () => {
    const ran: string[] = [];
    const skipped: string[] = [];
    await runJob(hosts, {
      mode: { kind: 'sequential' },
      stopOnFailure: true,
      cancelled: () => false,
      skip: (host) => skipped.push(host),
      runOne: async (host) => {
        ran.push(host);
        return { state: host === 'b' ? 'failed' : 'completed' };
      },
    });
    expect(ran).toEqual(['a', 'b']);
    expect(skipped).toEqual(['c', 'd', 'e']);
  });

  it('keeps going after a failure otherwise, and stops starting hosts once cancelled', async () => {
    const ran: string[] = [];
    let cancel = false;
    const skipped: string[] = [];
    await runJob(hosts, {
      mode: { kind: 'sequential' },
      stopOnFailure: false,
      cancelled: () => cancel,
      skip: (host) => skipped.push(host),
      runOne: async (host) => {
        ran.push(host);
        if (host === 'c') cancel = true;
        return { state: host === 'a' ? 'failed' : 'completed' };
      },
    });
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(skipped).toEqual(['d', 'e']);
  });
});
