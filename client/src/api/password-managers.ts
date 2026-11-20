import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  PasswordManagerEntriesResponse,
  PasswordManagerInput,
  PasswordManagerSource,
  PasswordManagersResponse,
} from '@muxus/shared';
import { apiFetch } from './http.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const KEY = ['password-managers'] as const;

/** Connected password managers with their current state. */
export function usePasswordManagers(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<PasswordManagersResponse>('/api/password-managers'),
    enabled,
    // A manager is locked, unlocked and signed in to outside this window too.
    staleTime: 0,
  });
}

/**
 * The entries of one unlocked password manager: titles and user names only.
 * Kept briefly so typing in the picker filters without asking again.
 */
export function usePasswordManagerEntries(sourceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, sourceId, 'entries'],
    queryFn: () =>
      apiFetch<PasswordManagerEntriesResponse>(
        `/api/password-managers/${encodeURIComponent(sourceId!)}/entries`,
      ),
    enabled: enabled && !!sourceId,
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
  });
}

/** Pull changes from the manager's server, then list again. */
export function useSyncPasswordManagerEntries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      apiFetch<PasswordManagerEntriesResponse>(
        `/api/password-managers/${encodeURIComponent(sourceId)}/entries?sync=1`,
      ),
    onSuccess: (data, sourceId) => {
      queryClient.setQueryData([...KEY, sourceId, 'entries'], data);
    },
    onError: shownInPlace,
  });
}

export function useSavePasswordManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: PasswordManagerInput }) =>
      apiFetch<PasswordManagerSource>(
        id ? `/api/password-managers/${encodeURIComponent(id)}` : '/api/password-managers',
        { method: id ? 'PUT' : 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) },
      ),
    onError: shownInPlace,
    onSettled: () => invalidate(queryClient),
  });
}

export function useDeletePasswordManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/password-managers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSettled: () => invalidate(queryClient),
  });
}

export function useUnlockPasswordManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      apiFetch<PasswordManagerSource>(`/api/password-managers/${encodeURIComponent(id)}/unlock`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ password }),
      }),
    onError: shownInPlace,
    onSettled: () => invalidate(queryClient),
  });
}

export function useLockPasswordManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PasswordManagerSource>(`/api/password-managers/${encodeURIComponent(id)}/lock`, {
        method: 'POST',
      }),
    onSettled: () => invalidate(queryClient),
  });
}

/** The form that ran the mutation shows its error, so the global toast stays out of it. */
function shownInPlace(): void {}

function invalidate(queryClient: QueryClient): void {
  // Entry lists hang off the same key, so a lock or a new path drops them too.
  void queryClient.invalidateQueries({ queryKey: KEY });
}
