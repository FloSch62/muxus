import { useEffect } from 'react';
import type {
  WorkspaceLayoutV1,
  WorkspaceRecord,
  WorkspaceSummary,
} from '@muxus/shared';
import { apiFetch, authToken } from './api/http.js';
import { useTabsStore, type SessionTab } from './state/tabs.js';
import { serializeWorkspace } from './state/workspace-layout.js';

const SAVE_DELAY_MS = 350;
const RETRY_DELAY_MS = 2_000;

function currentLayout(): WorkspaceLayoutV1 {
  const { root, tabs, activePaneId } = useTabsStore.getState();
  const sessionTabs = tabs.filter((tab): tab is SessionTab => tab.profile !== null);
  return serializeWorkspace(root, sessionTabs, activePaneId);
}

/**
 * Restore the most recent layout once, then debounce structural snapshots to
 * SQLite. Restored terminal tabs remain disconnected until the user chooses
 * Reconnect; this never claims to resume a shell process.
 */
export function useWorkspacePersistence(): void {
  useEffect(() => {
    let stopped = false;
    let workspaceId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: { layout: WorkspaceLayoutV1; serialized: string } | undefined;
    let saving = false;
    let lastSerialized = '';

    const schedule = (delay = SAVE_DELAY_MS) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    };

    const flush = async () => {
      timer = undefined;
      if (saving || !pending || stopped) return;
      const snapshot = pending;
      pending = undefined;
      saving = true;
      try {
        const saved = await apiFetch<WorkspaceRecord>('/api/workspaces', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: workspaceId,
            name: 'Last workspace',
            layout: snapshot.layout,
          }),
        });
        workspaceId = saved.id;
      } catch {
        // Backend restart/disk failure: retain the latest snapshot and retry.
        pending ??= snapshot;
        if (!stopped) schedule(RETRY_DELAY_MS);
      } finally {
        saving = false;
        if (pending && !timer && !stopped) schedule();
      }
    };

    const start = async () => {
      const beforeLoad = JSON.stringify(currentLayout());
      let restored = false;
      try {
        const { workspaces } = await apiFetch<{ workspaces: WorkspaceSummary[] }>('/api/workspaces');
        if (stopped) return;
        const latest = workspaces[0];
        if (latest) {
          workspaceId = latest.id;
          const workspace = await apiFetch<WorkspaceRecord>(
            `/api/workspaces/${encodeURIComponent(latest.id)}`,
          );
          if (stopped) return;
          const state = useTabsStore.getState();
          // Do not clobber a session the user opened while the request was in flight.
          if (state.tabs.length === 0 && state.root.type === 'pane') {
            state.restore(workspace.layout);
            restored = true;
          }
        }
      } catch {
        // The backend-status banner owns connectivity/auth failures. A later
        // structural change will still enter the retrying save path.
      }
      if (stopped) return;
      const loadedLayout = currentLayout();
      lastSerialized = JSON.stringify(loadedLayout);
      // A user can open or split a terminal while the initial read is in
      // flight. Preserve that newer state instead of treating it as the
      // post-load baseline and silently losing it on shutdown.
      if (!restored && lastSerialized !== beforeLoad) {
        pending = { layout: loadedLayout, serialized: lastSerialized };
        schedule();
      }
      unsubscribe = useTabsStore.subscribe(() => {
        const layout = currentLayout();
        const serialized = JSON.stringify(layout);
        if (serialized === lastSerialized) return;
        lastSerialized = serialized;
        pending = { layout, serialized };
        schedule();
      });
    };

    const flushOnUnload = () => {
      if (!pending) return;
      const body = JSON.stringify({
        id: workspaceId,
        name: 'Last workspace',
        layout: pending.layout,
      });
      void fetch('/api/workspaces', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${authToken()}`,
          'content-type': 'application/json',
        },
        body,
        keepalive: true,
      }).catch(() => undefined);
    };

    window.addEventListener('beforeunload', flushOnUnload);
    void start();
    return () => {
      flushOnUnload();
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener('beforeunload', flushOnUnload);
    };
  }, []);
}
