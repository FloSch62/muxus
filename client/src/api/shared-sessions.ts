import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  SavedHostProfile,
  SharedSessionApplyResult,
  SharedSessionSource,
  SharedSessionSourceInput,
  SharedSessionSourcesResponse,
} from '@muxus/shared';
import { create } from 'zustand';
import { apiFetch } from './http.js';
import { confirmAction } from '../state/dialogs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { formatTimestamp } from '../time-format.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const SOURCES_KEY = ['shared-session-sources'];

export function useSharedSessionSources() {
  return useQuery({
    queryKey: SOURCES_KEY,
    queryFn: () => apiFetch<SharedSessionSourcesResponse>('/api/shared-sessions'),
  });
}

/**
 * The caption under a host editor's title when a shared sessions link keeps
 * that host up to date; nothing for a host of the user's own.
 */
export function useSharedHostCaption(profile: SavedHostProfile | undefined): string | undefined {
  const sourceId = profile?.metadata.sharedSourceId;
  const { data } = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: () => apiFetch<SharedSessionSourcesResponse>('/api/shared-sessions'),
    enabled: sourceId !== undefined,
  });
  if (sourceId === undefined) return undefined;
  const name = data?.sources.find((source) => source.id === sourceId)?.name;
  return `Follows ${name ? `“${name}”` : 'a shared sessions link'} — your changes stay unless the list changes the same setting`;
}

/** Everything a link's hosts show up in. */
function invalidateSharedSessions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
  void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
  void queryClient.invalidateQueries({ queryKey: ['data-transfer-summary'] });
}

export function useSaveSharedSessionSource(onSuccess?: (source: SharedSessionSource) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SharedSessionSourceInput) =>
      apiFetch<SharedSessionSource>('/api/shared-sessions', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }),
    onSuccess: (source) => {
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
      onSuccess?.(source);
    },
  });
}

export function useDeleteSharedSessionSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, keepHosts }: { id: string; keepHosts: boolean }) =>
      apiFetch<{ deleted: boolean }>(
        `/api/shared-sessions/${encodeURIComponent(id)}${keepHosts ? '?keepHosts=true' : ''}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateSharedSessions(queryClient),
    onError: showErrorToast,
  });
}

/** Links being read right now in this window, for the rows that show it. */
const useReadingStore = create<{ ids: ReadonlySet<string> }>()(() => ({ ids: new Set() }));

export function useSharedSessionsBeingRead(): ReadonlySet<string> {
  return useReadingStore((state) => state.ids);
}

function setReading(id: string, reading: boolean): void {
  useReadingStore.setState((state) => {
    const ids = new Set(state.ids);
    if (reading) ids.add(id);
    else ids.delete(id);
    return { ids };
  });
}

/**
 * Read a link and make its hosts match, then show the result everywhere.
 * Resolves to nothing when the link was not due. The importers load only
 * now, so a setup without links never pays for them.
 */
export async function refreshSharedSessions(
  queryClient: QueryClient,
  source: Pick<SharedSessionSource, 'id' | 'folder'>,
  options: { force?: boolean } = {},
): Promise<SharedSessionApplyResult | undefined> {
  setReading(source.id, true);
  try {
    const { syncSharedSessions } = await import('../shared-sessions.js');
    return await syncSharedSessions(source, options);
  } finally {
    setReading(source.id, false);
    // A failed check changes the link's status too.
    invalidateSharedSessions(queryClient);
  }
}

/** Read a link because the user asked to, and say what came of it. */
export async function refreshSharedSessionsNow(
  queryClient: QueryClient,
  source: Pick<SharedSessionSource, 'id' | 'folder' | 'name'>,
): Promise<void> {
  try {
    const result = await refreshSharedSessions(queryClient, source, { force: true });
    const changes = result ? sharedSessionChanges(result) : '';
    showToast('success', `${source.name}: ${changes || 'already up to date'}.`);
  } catch (error) {
    showToast(
      'error',
      `${source.name}: ${error instanceof Error ? error.message : 'the shared sessions could not be read.'}`,
    );
  }
}

/**
 * Ask before a link is removed. Resolves to what happens to its hosts, or to
 * nothing when the user backs out.
 */
export async function confirmRemoveSharedSessions(
  source: SharedSessionSource,
): Promise<{ keepHosts: boolean } | undefined> {
  let keepHosts = false;
  const hosts = sharedHostCount(source.hostCount);
  const confirmed = await confirmAction({
    title: `Stop following “${source.name}”?`,
    description: source.hostCount
      ? `Its ${hosts} in “${source.folder}” are deleted.`
      : undefined,
    confirmLabel: 'Stop following',
    destructive: true,
    ...(source.hostCount
      ? {
          checkbox: {
            label: `Keep the ${hosts} as hosts of my own`,
            onChecked: () => {
              keepHosts = true;
            },
          },
        }
      : {}),
  });
  return confirmed ? { keepHosts } : undefined;
}

export function sharedHostCount(count: number): string {
  return `${count} ${count === 1 ? 'host' : 'hosts'}`;
}

/** Where a link points, without the part that is often personal: a server name or a file name. */
export function sharedSessionsOrigin(url: string): string {
  try {
    return new URL(url).host || 'link';
  } catch {
    return url.split(/[\\/]/).filter(Boolean).pop() ?? 'file';
  }
}

/** How a link is doing, in the words its row and its folder both use. */
export function sharedSessionsState(
  source: SharedSessionSource,
): { tone: 'success' | 'error' | 'info'; text: string } {
  if (source.lastError) return { tone: 'error', text: source.lastError };
  if (source.lastSyncedAt) {
    return { tone: 'success', text: `Up to date · ${formatTimestamp(source.lastSyncedAt)}` };
  }
  return { tone: 'info', text: 'Not read yet' };
}

/** "3 added · 1 removed", or nothing when a check changed no host. */
export function sharedSessionChanges(result: SharedSessionApplyResult): string {
  return [
    result.added ? `${result.added} added` : '',
    result.updated ? `${result.updated} updated` : '',
    result.removed ? `${result.removed} removed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
