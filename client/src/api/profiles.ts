import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SavedHostProfilesResponse,
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
    // Telnet and serial rows sit in the same sidebar folders as SSH hosts,
    // whose metadata hook is optimistic — without this they visibly lag behind
    // when a folder change moves both at once.
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ['saved-host-profiles'] });
      const previous = queryClient.getQueryData<SavedHostProfilesResponse>([
        'saved-host-profiles',
      ]);
      queryClient.setQueryData<SavedHostProfilesResponse>(['saved-host-profiles'], (current) => {
        if (!current) return current;
        return {
          profiles: current.profiles.map((profile) =>
            profile.id === id
              ? { ...profile, metadata: { ...profile.metadata, ...nullsToUndefined(patch) } }
              : profile,
          ),
        };
      });
      return { previous };
    },
    onSuccess: (profile) => {
      onSuccess?.(profile);
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['saved-host-profiles'], context.previous);
      showErrorToast(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
    },
  });
}

/** The patch clears fields with null; the stored metadata omits them instead. */
function nullsToUndefined(patch: OpenSshMetadataPatch): Partial<SavedHostProfile['metadata']> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, value ?? undefined]),
  );
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
