import { useEffect } from 'react';
import { useSavedHostProfiles, useSshConfig } from '../../api/queries.js';
import {
  AUTO_REFRESH_MS,
  LOCAL_ENVIRONMENT_HOST,
  discoverHost,
  environmentHostForProfile,
} from '../../environments.js';
import { usePrefsStore } from '../../state/prefs.js';
import { useTabsStore } from '../../state/tabs.js';

/** When each host was last read automatically, so a busy window does not ask again and again. */
const attempted = new Map<string, number>();

function due(key: string): boolean {
  const last = attempted.get(key);
  if (last !== undefined && Date.now() - last < AUTO_REFRESH_MS) return false;
  attempted.set(key, Date.now());
  return true;
}

/**
 * Read this computer when the window opens, and each SSH host when a tab to
 * it connects, so the sidebar can show what they run. Hosts are read over the
 * tab's own connection and only when their server runs commands.
 */
export function useEnvironmentDiscovery(): void {
  const enabled = usePrefsStore((state) => state.discoverEnvironments);
  const tabs = useTabsStore((state) => state.tabs);
  const { data: config } = useSshConfig(enabled);
  const { data: saved } = useSavedHostProfiles(enabled);

  useEffect(() => {
    if (!enabled || !due(LOCAL_ENVIRONMENT_HOST.key)) return;
    void discoverHost(LOCAL_ENVIRONMENT_HOST, { automatic: true, interactive: false });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !config || !saved) return;
    for (const tab of tabs) {
      if (tab.profile?.kind !== 'ssh' || tab.status !== 'connected' || !tab.connId) continue;
      const host = environmentHostForProfile(tab.profile, config.hosts, saved.profiles);
      if (!host || !due(host.key)) continue;
      void discoverHost(host, { automatic: true, interactive: false });
    }
  }, [enabled, tabs, config, saved]);
}
