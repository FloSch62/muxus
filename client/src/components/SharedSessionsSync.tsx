import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sharedSessionSourceDue } from '@muxus/shared';
import {
  refreshSharedSessions,
  sharedSessionChanges,
  useSharedSessionSources,
} from '../api/shared-sessions.js';
import { showToast } from '../state/toast.js';

/** How often a window looks for links that are due. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * Keeps the hosts of shared session links up to date: at startup and while
 * the app runs, every link whose interval has passed is read again. Failures
 * stay quiet here and show with the link in Settings; changed hosts are
 * announced, since they appear and disappear in the sidebar.
 */
export function SharedSessionsSync() {
  const queryClient = useQueryClient();
  const { data } = useSharedSessionSources();
  // Also keeps a link whose check cannot even be claimed (backend away) from being retried in a loop.
  const attempted = useRef(new Map<string, number>());

  useEffect(() => {
    const sources = data?.sources ?? [];
    if (!sources.some((source) => source.refreshMinutes > 0)) return undefined;
    const check = () => {
      const now = Date.now();
      for (const source of sources) {
        if (!sharedSessionSourceDue(source, now)) continue;
        if (now - (attempted.current.get(source.id) ?? 0) < CHECK_INTERVAL_MS) continue;
        attempted.current.set(source.id, now);
        void refreshSharedSessions(queryClient, source)
          .then((result) => {
            const changes = result ? sharedSessionChanges(result) : '';
            if (changes) showToast('info', `${source.name}: ${changes}.`);
          })
          .catch(() => undefined);
      }
    };
    check();
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [data, queryClient]);

  return null;
}
