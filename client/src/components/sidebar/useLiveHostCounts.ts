import { useMemo } from 'react';
import { tabHostKey } from '../../host-sessions.js';
import { useTabsStore, type TerminalTab } from '../../state/tabs.js';

export interface LiveCounts {
  connected: number;
  connecting: number;
}

/**
 * Live session dots keyed like managedHostKey: connected/connecting tab counts.
 *
 * The tabs array changes on every step of every session (status, cwd, output
 * flags …), but the sidebar only has to hear about it when a host's counts
 * move. The selector reduces the tabs to a string, which the store compares by
 * value, so every other tab update leaves the sidebar alone.
 */
export function useLiveHostCounts(): Map<string, LiveCounts> {
  const signature = useTabsStore((s) => liveCountsSignature(s.tabs));
  return useMemo(() => parseLiveCounts(signature), [signature]);
}

/** Hosts with live tabs as `[key, connected, connecting]` triples, sorted by key. */
export function liveCountsSignature(tabs: readonly TerminalTab[]): string {
  const counts = new Map<string, LiveCounts>();
  for (const tab of tabs) {
    if (!tab.profile) continue;
    if (tab.status !== 'connected' && tab.status !== 'connecting') continue;
    const key = tabHostKey(tab);
    if (!key) continue;
    const entry = counts.get(key) ?? { connected: 0, connecting: 0 };
    if (tab.status === 'connected') entry.connected++;
    else entry.connecting++;
    counts.set(key, entry);
  }
  return JSON.stringify(
    [...counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, entry.connected, entry.connecting]),
  );
}

export function parseLiveCounts(signature: string): Map<string, LiveCounts> {
  const entries = JSON.parse(signature) as Array<[string, number, number]>;
  return new Map(entries.map(([key, connected, connecting]) => [key, { connected, connecting }]));
}
