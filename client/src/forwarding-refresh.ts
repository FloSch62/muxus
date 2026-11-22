import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectionsQuery, forwardsQuery } from './api/queries.js';
import { useTabsStore, type TerminalTab } from './state/tabs.js';

/** A closed session's transport and its forwards go a moment after its tab. */
const SETTLE_MS = 800;

/** The SSH transports this window's tabs are on, as one value that changes when they do. */
export function liveConnectionsKey(tabs: readonly Pick<TerminalTab, 'connId'>[]): string {
  const ids = new Set(tabs.flatMap((tab) => (tab.connId ? [tab.connId] : [])));
  return [...ids].sort().join('\n');
}

/**
 * A session's own forwards start while it connects and end with it, and the
 * server only says so when asked. Rather than leave the forwarding panel and
 * its badge a poll behind, ask again the moment a connection of this window
 * comes or goes.
 */
export function useForwardingRefresh(): void {
  const queryClient = useQueryClient();
  const connections = useTabsStore((state) => liveConnectionsKey(state.tabs));
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: forwardsQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    };
    refresh();
    const again = window.setTimeout(refresh, SETTLE_MS);
    return () => window.clearTimeout(again);
  }, [queryClient, connections]);
}
