import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HostBulkUpdateRequest, HostBulkUpdateResponse } from '@muxus/shared';
import type { BulkEditPlan } from '../host-bulk-edit.js';
import { managedHostKey } from '../managed-hosts.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { apiFetch } from './http.js';

/** Enough in flight to feel instant, few enough not to stampede the server. */
const CHUNK_SIZE = 8;

export interface BulkEditResult {
  attempted: number;
  /** Hosts with at least one write that did not go through. */
  failed: number;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Apply a bulk edit. Every OpenSSH host goes in one request that the server
 * writes all at once, so ssh_config either takes the whole change or none of
 * it — and when it refuses, nothing else is written either. The Muxus-side
 * writes then run per host, with one summary at the end rather than a toast
 * per failure.
 */
export function useApplyBulkHostEdit(onSuccess?: (result: BulkEditResult) => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (plan: BulkEditPlan): Promise<BulkEditResult> => {
      if (plan.openSsh) {
        await apiFetch<HostBulkUpdateResponse>(
          '/api/ssh/config/hosts',
          jsonInit('PATCH', plan.openSsh satisfies HostBulkUpdateRequest),
        );
      }

      const writes: Array<{ hostKey: string; run: () => Promise<unknown> }> = [
        ...plan.profiles.map((input) => ({
          hostKey: `profile:${input.id}`,
          run: () => apiFetch<unknown>('/api/profiles', jsonInit('PUT', input)),
        })),
        ...plan.metadata.map(({ host, patch }) => ({
          hostKey: managedHostKey(host),
          run: () =>
            apiFetch<unknown>(
              host.kind === 'ssh'
                ? `/api/ssh/config/hosts/${encodeURIComponent(host.entry.alias)}/metadata`
                : `/api/profiles/${encodeURIComponent(host.entry.id)}/metadata`,
              jsonInit('PATCH', patch),
            ),
        })),
        ...plan.logging.map(({ profileKey, policy }) => {
          const url = `/api/session-history/policy?profileKey=${encodeURIComponent(profileKey)}`;
          return {
            hostKey: profileKey,
            run: () =>
              policy === null
                ? apiFetch<unknown>(url, { method: 'DELETE' })
                : apiFetch<unknown>(url, jsonInit('PUT', policy)),
          };
        }),
      ];

      const failed = new Set<string>();
      for (let index = 0; index < writes.length; index += CHUNK_SIZE) {
        const chunk = writes.slice(index, index + CHUNK_SIZE);
        const results = await Promise.allSettled(chunk.map((write) => write.run()));
        results.forEach((result, offset) => {
          if (result.status === 'rejected') failed.add(chunk[offset]!.hostKey);
        });
      }
      return { attempted: plan.hosts.length, failed: failed.size };
    },
    onSuccess: (result) => {
      if (result.failed > 0) {
        showToast(
          'error',
          `Updated ${result.attempted - result.failed} of ${result.attempted} hosts — some changes did not save.`,
        );
      } else {
        showToast(
          'success',
          `Updated ${result.attempted} host${result.attempted === 1 ? '' : 's'}.`,
        );
      }
      onSuccess?.(result);
    },
    onError: showErrorToast,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
      void queryClient.invalidateQueries({ queryKey: ['session-logging-policy'] });
    },
  });
}
