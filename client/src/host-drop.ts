import { managedHostKey, type ManagedHost } from './managed-hosts.js';
import { connectManagedHost } from './session-actions.js';
import { useHostDragStore } from './state/host-drag.js';
import { useTabsStore } from './state/tabs.js';

/**
 * Hosts dragged out of the sidebar or the hosts tab and dropped on a pane:
 * open a session for each one there, in the order they were picked up.
 */
export function openDraggedHosts(paneId: string, hosts: readonly ManagedHost[]): void {
  const drag = useHostDragStore.getState();
  const source = drag.source;
  drag.setSource(null);
  if (source?.kind !== 'host') return;
  const byKey = new Map(hosts.map((host) => [managedHostKey(host), host]));
  useTabsStore.getState().focusPane(paneId);
  useTabsStore.getState().stopTiling();
  for (const dragged of source.hosts) {
    const host = byKey.get(dragged.hostKey);
    if (host) connectManagedHost(host);
  }
}
