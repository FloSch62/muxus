import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  SessionHistorySettingsInput,
  SessionHistoryStorageStatus,
  SessionLoggingPolicy,
  SessionLoggingPolicyInput,
} from '@muxus/shared';
import { apiFetch } from './http.js';
import { showErrorToast } from '../state/toast.js';

export interface SaveSessionLoggingPolicyRequest {
  profileKey: string;
  /** Null removes the override and restores inherited defaults. */
  policy: SessionLoggingPolicyInput | null;
}

export function useSaveSessionLoggingPolicy(
  onSuccess?: (
    policy: SessionLoggingPolicy | undefined,
    request: SaveSessionLoggingPolicyRequest,
  ) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: SaveSessionLoggingPolicyRequest) => {
      const url =
        '/api/session-history/policy?profileKey=' +
        encodeURIComponent(request.profileKey);
      if (request.policy === null) {
        await apiFetch<{ deleted: boolean }>(url, { method: 'DELETE' });
        return undefined;
      }
      return apiFetch<SessionLoggingPolicy>(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.policy),
      });
    },
    onSuccess: (policy, request) => {
      void queryClient.invalidateQueries({
        queryKey:
          request.profileKey === '*'
            ? ['session-logging-policy']
            : ['session-logging-policy', request.profileKey],
      });
      onSuccess?.(policy, request);
    },
    onError: showErrorToast,
  });
}

export function useSaveSessionHistorySettings(
  onSuccess?: (status: SessionHistoryStorageStatus) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: SessionHistorySettingsInput) =>
      apiFetch<SessionHistoryStorageStatus>('/api/session-history/storage', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    onSuccess: (status) => {
      queryClient.setQueryData(['session-history-storage'], status);
      onSuccess?.(status);
    },
    onError: showErrorToast,
  });
}

export function useSetSessionPinned() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      apiFetch<{ updated: boolean }>(`/api/session-history/${id}/pin`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['session-history'] });
    },
    onError: showErrorToast,
  });
}
