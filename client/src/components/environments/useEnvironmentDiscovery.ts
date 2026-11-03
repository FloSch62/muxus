import { useEffect } from 'react';
import { useSavedHostProfiles, useSshConfig } from '../../api/queries.js';
import {
  LOCAL_ENVIRONMENT_HOST,
  discoverHost,
  discoveryEnabledFor,
  environmentHostForProfile,
  forgetDisconnectedHosts,
  refreshConnectedHosts,
} from '../../environments.js';
import { useEnvironmentsStore, type EnvironmentHost } from '../../state/environments.js';
import { usePrefsStore } from '../../state/prefs.js';
import { useTabsStore } from '../../state/tabs.js';
import { useUiStore } from '../../state/ui.js';

/**
 * Read this computer when the window opens, and each SSH host when a tab to
 * it connects, so the sidebar can show what they run; read them again on the
 * refresh interval while they stay connected. A host nobody is connected to
 * shows nothing. Hosts are read over the tab's own connection and only when
 * their server runs commands.
 */
export function useEnvironmentDiscovery(): void {
  const enabled = usePrefsStore((state) => state.discoverEnvironments);
  const refreshSeconds = usePrefsStore((state) => state.environmentRefreshSeconds);
  const tabs = useTabsStore((state) => state.tabs);
  const panel = useUiStore((state) => state.environmentsPanel);
  const { data: config } = useSshConfig();
  const { data: saved } = useSavedHostProfiles();
  const scopedKey = panel === false ? undefined : panel.hostKey;

  // This computer, at startup and when the setting comes back on.
  useEffect(() => {
    const store = useEnvironmentsStore.getState();
    const entry = store.entries[LOCAL_ENVIRONMENT_HOST.key];
    if (!enabled) {
      if (entry?.automatic) store.remove(LOCAL_ENVIRONMENT_HOST.key);
      return;
    }
    if (!entry) void discoverHost(LOCAL_ENVIRONMENT_HOST, { automatic: true, interactive: false });
  }, [enabled]);

  // SSH hosts, as their tabs connect and disconnect.
  useEffect(() => {
    if (!config || !saved) return;
    const store = useEnvironmentsStore.getState();
    const connected = new Map<string, EnvironmentHost>();
    for (const tab of tabs) {
      if (tab.profile?.kind !== 'ssh' || tab.status !== 'connected' || !tab.connId) continue;
      const host = environmentHostForProfile(tab.profile, config.hosts, saved.profiles);
      if (host) connected.set(host.key, host);
    }
    for (const host of connected.values()) {
      const entry = store.entries[host.key];
      if (entry) {
        // The host editor may have changed the host's own choice.
        if (entry.discover !== host.discover) store.update(host, {});
        if (entry.automatic && !discoveryEnabledFor(host)) store.remove(host.key);
        continue;
      }
      if (discoveryEnabledFor(host)) void discoverHost(host, { automatic: true, interactive: false });
    }
    forgetDisconnectedHosts(scopedKey);
  }, [enabled, tabs, config, saved, scopedKey]);

  useEffect(() => {
    if (refreshSeconds <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refreshConnectedHosts();
    }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refreshSeconds]);
}
