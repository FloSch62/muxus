import { useMemo } from 'react';
import { useTabsStore } from '../../state/tabs.js';

export interface LiveCounts {
  connected: number;
  connecting: number;
}

/** Live session dots keyed like managedHostKey: connected/connecting tab counts. */
export function useLiveHostCounts(): Map<string, LiveCounts> {
  const tabs = useTabsStore((s) => s.tabs);
  return useMemo(() => {
    const map = new Map<string, LiveCounts>();
    for (const tab of tabs) {
      if (!tab.profile) continue;
      const key =
        tab.profile.kind === 'ssh'
          ? tab.profile.profileId
            ? `profile:${tab.profile.profileId}`
            : `ssh:${tab.profile.target}`
          : tab.profile.kind === 'telnet' || tab.profile.kind === 'serial'
            ? tab.profile.profileId && `profile:${tab.profile.profileId}`
            : undefined;
      if (!key) continue;
      const entry = map.get(key) ?? { connected: 0, connecting: 0 };
      if (tab.status === 'connected') entry.connected++;
      if (tab.status === 'connecting') entry.connecting++;
      map.set(key, entry);
    }
    return map;
  }, [tabs]);
}
