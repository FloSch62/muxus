import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HostBulkDeleteRequest, HostBulkDeleteResponse } from '@muxus/shared';
import type { ManagedHost } from '../managed-hosts.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { apiFetch } from './http.js';

/** Enough in flight to feel instant, few enough not to stampede the server. */
const CHUNK_SIZE = 8;

export interface BulkDeleteResult {
  attempted: number;
  failed: number;
}

/**
 * Delete several hosts at once. Every OpenSSH host goes in one request that
 * the server writes all at once, so each config file is rewritten once and its
 * `.muxus.bak` holds the content from before the whole delete — and when it
 * refuses, nothing else is deleted either. Hosts stored in Muxus then go one
 * request each, with a single summary at the end.
 */
export function useDeleteManagedHosts(onSuccess?: (result: BulkDeleteResult) => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (hosts: readonly ManagedHost[]): Promise<BulkDeleteResult> => {
      const aliases = hosts.flatMap((host) => (host.kind === 'ssh' ? [host.entry.alias] : []));
      if (aliases.length > 0) {
        await apiFetch<HostBulkDeleteResponse>('/api/ssh/config/hosts', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ aliases } satisfies HostBulkDeleteRequest),
        });
      }

      const ids = hosts.flatMap((host) => (host.kind === 'ssh' ? [] : [host.entry.id]));
      let failed = 0;
      for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
        const chunk = ids.slice(index, index + CHUNK_SIZE);
        const results = await Promise.allSettled(
          chunk.map((id) =>
            apiFetch<unknown>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
          ),
        );
        failed += results.filter((result) => result.status === 'rejected').length;
      }
      return { attempted: hosts.length, failed };
    },
    onSuccess: (result) => {
      if (result.failed > 0) {
        showToast(
          'error',
          `Deleted ${result.attempted - result.failed} of ${result.attempted} hosts — some could not be deleted.`,
        );
      } else {
        showToast(
          'success',
          `Deleted ${result.attempted} host${result.attempted === 1 ? '' : 's'}.`,
        );
      }
      onSuccess?.(result);
    },
    onError: showErrorToast,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
    },
  });
}
