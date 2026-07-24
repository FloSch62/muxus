import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
} from '@muxus/shared';
import { apiFetch } from './http.js';
import { showErrorToast } from '../state/toast.js';

export function useSaveHostProfile(onSuccess?: (profile: SavedHostProfile) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SavedHostProfileInput) =>
      apiFetch<SavedHostProfile>('/api/profiles', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (profile) => {
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
      onSuccess?.(profile);
    },
    onError: showErrorToast,
  });
}

export function useUpdateHostProfileMetadata(
  onSuccess?: (profile: SavedHostProfile) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: OpenSshMetadataPatch }) =>
      apiFetch<SavedHostProfile>(`/api/profiles/${encodeURIComponent(id)}/metadata`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    onSuccess: (profile) => {
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
      onSuccess?.(profile);
    },
    onError: showErrorToast,
  });
}

export function useDeleteHostProfile(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/profiles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
      onSuccess?.();
    },
    onError: showErrorToast,
  });
}
